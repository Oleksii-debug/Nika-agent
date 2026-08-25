import { expect, test, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const EXTENSION_PATH = resolve('.output/chrome-mv3');

type CdpTargetInfo = {
  targetId: string;
  type: string;
  url: string;
};

async function launchExtension(): Promise<{ context: BrowserContext; worker: Worker; extensionId: string }> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'nika-pw-worker-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  return { context, worker, extensionId };
}

async function bootIdentity(worker: Worker): Promise<{ token: string; timeOrigin: number }> {
  return worker.evaluate(() => {
    const scope = globalThis as typeof globalThis & { __nikaLifecycleBootId?: string };
    scope.__nikaLifecycleBootId ??= crypto.randomUUID();
    return {
      token: scope.__nikaLifecycleBootId,
      timeOrigin: performance.timeOrigin,
    };
  });
}

async function terminateBackgroundWorker(context: BrowserContext, worker: Worker): Promise<void> {
  const browser = context.browser();
  if (!browser) throw new Error('Persistent Chromium context has no owning Browser instance.');

  const cdp = await browser.newBrowserCDPSession();
  try {
    const response = await cdp.send('Target.getTargets') as { targetInfos?: CdpTargetInfo[] };
    const target = response.targetInfos?.find((candidate) =>
      candidate.type === 'service_worker' && candidate.url === worker.url(),
    );
    if (!target) throw new Error(`MV3 service-worker CDP target not found for ${worker.url()}.`);

    const closed = worker.waitForEvent('close');
    await cdp.send('Target.closeTarget', { targetId: target.targetId });
    await closed;
  } finally {
    await cdp.detach();
  }
}

async function wakeBackground(context: BrowserContext, extensionId: string): Promise<Worker> {
  const restarted = context.waitForEvent('serviceworker', { timeout: 10_000 });
  const popup = await context.newPage();
  try {
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    await popup.evaluate(async () => {
      try {
        await chrome.runtime.sendMessage({ type: 'nika.lifecycleProbe' });
      } catch {
        // A response is intentionally not required. Dispatching the runtime message is enough
        // to wake the MV3 background worker and exercise its listener registration path.
      }
    });
    return await restarted;
  } finally {
    await popup.close();
  }
}

test('MV3 runtime restart produces a distinct worker boot before recovery work continues', async () => {
  const { context, worker, extensionId } = await launchExtension();
  try {
    const firstBoot = await bootIdentity(worker);
    expect((await bootIdentity(worker)).token).toBe(firstBoot.token);

    // Kill only the current service-worker target. Unlike chrome.runtime.reload(), this keeps
    // the extension and Playwright BrowserContext alive while ending the in-memory MV3 worker
    // lifetime. Durable browser storage and extension identity remain unchanged.
    await terminateBackgroundWorker(context, worker);
    expect(context.isClosed()).toBe(false);

    const restartedWorker = await wakeBackground(context, extensionId);
    const secondBoot = await bootIdentity(restartedWorker);

    expect(restartedWorker).not.toBe(worker);
    expect(restartedWorker.url()).toBe(worker.url());
    expect(secondBoot.timeOrigin).toBeGreaterThanOrEqual(firstBoot.timeOrigin);
    expect(secondBoot.token).not.toBe(firstBoot.token);
    expect((await bootIdentity(restartedWorker)).token).toBe(secondBoot.token);

    // The restarted worker must be capable of servicing Chrome APIs, proving this is not
    // merely a stale Playwright Worker wrapper after termination.
    const runtimeId = await restartedWorker.evaluate(() => chrome.runtime.id);
    expect(runtimeId).toBe(extensionId);
  } finally {
    await context.close();
  }
});
