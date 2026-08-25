import { expect, test, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const EXTENSION_PATH = resolve('.output/chrome-mv3');

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
  return worker.evaluate(() => ({
    token: crypto.randomUUID(),
    timeOrigin: performance.timeOrigin,
  }));
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
    const closed = worker.waitForEvent('close');

    // ServiceWorkerGlobalScope has no close() API. chrome.runtime.reload() is a deterministic
    // forced extension-runtime restart: the old MV3 worker/context is destroyed while durable
    // browser storage survives, making it a conservative lifecycle oracle for restart recovery.
    await worker.evaluate(() => {
      chrome.runtime.reload();
    });
    await closed;

    const restartedWorker = await wakeBackground(context, extensionId);
    const secondBoot = await bootIdentity(restartedWorker);

    expect(restartedWorker).not.toBe(worker);
    expect(restartedWorker.url()).toBe(worker.url());
    expect(secondBoot.timeOrigin).toBeGreaterThanOrEqual(firstBoot.timeOrigin);
    expect(secondBoot.token).not.toBe(firstBoot.token);

    // The restarted worker must be capable of servicing Chrome APIs, proving this is not
    // merely a stale Playwright Worker wrapper after termination.
    const runtimeId = await restartedWorker.evaluate(() => chrome.runtime.id);
    expect(runtimeId).toBe(extensionId);
  } finally {
    await context.close();
  }
});
