import type { ChatAgent, ContentCommand, ContentResult, ExecutionProvenance } from './types';
import { appendLog } from './storage';

const agentQueues = new Map<string, Promise<void>>();
const RETRY_DELAYS_MS = [250, 750, 2_000] as const;

export async function ensureAgentTab(agent: ChatAgent): Promise<number> {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  const exact = tabs.find((tab) => tab.url === agent.url && typeof tab.id === 'number');
  if (exact?.id) return exact.id;

  const created = await chrome.tabs.create({ url: agent.url, active: false });
  if (typeof created.id !== 'number') throw new Error(`Unable to create tab for ${agent.name}`);
  await waitForTabComplete(created.id, 30_000);
  return created.id;
}

export async function sendToAgent(
  agent: ChatAgent,
  prompt: string,
  provenance: ExecutionProvenance = {},
): Promise<void> {
  await withAgentQueue(agent.id, async () => {
    const tabId = await ensureAgentTab(agent);
    if (agent.completion.waitForIdle) {
      await waitUntilIdle(tabId, agent.completion.timeoutMs, agent.completion.settleMs);
    }
    const result = await contentCommand(tabId, { type: 'send', prompt });
    if (!result.ok) throw new Error(result.error);
    await appendLog({
      agentId: agent.id,
      ...provenance,
      level: 'info',
      event: 'prompt_sent',
      detail: prompt.slice(0, 500),
    });
  });
}

export async function waitForAgentIdle(agent: ChatAgent, timeoutOverride?: number): Promise<void> {
  await withAgentQueue(agent.id, async () => {
    const tabId = await ensureAgentTab(agent);
    await waitUntilIdle(tabId, timeoutOverride ?? agent.completion.timeoutMs, agent.completion.settleMs);
  });
}

export async function captureAgentResponse(
  agent: ChatAgent,
  provenance: ExecutionProvenance = {},
): Promise<string> {
  return withAgentQueue(agent.id, async () => {
    const tabId = await ensureAgentTab(agent);
    await waitUntilIdle(tabId, agent.completion.timeoutMs, agent.completion.settleMs);
    const result = await contentCommand(tabId, { type: 'captureLatest' });
    if (!result.ok || !result.text) throw new Error(result.ok ? 'Response was empty.' : result.error);
    await appendLog({
      agentId: agent.id,
      ...provenance,
      level: 'info',
      event: 'response_captured',
      detail: result.text.slice(0, 500),
    });
    return result.text;
  });
}

export async function waitUntilIdle(tabId: number, timeoutMs: number, settleMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let idleSince: number | null = null;

  while (Date.now() < deadline) {
    const result = await contentCommand(tabId, { type: 'status' }, false);
    if (result.ok && result.state === 'idle') {
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= settleMs) return;
    } else {
      idleSince = null;
    }
    await sleep(1000);
  }
  throw new Error('Timed out waiting for ChatGPT to become idle.');
}

async function contentCommand(
  tabId: number,
  command: ContentCommand,
  recover = true,
): Promise<ContentResult> {
  const attempts = recover ? RETRY_DELAYS_MS.length + 1 : 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return (await chrome.tabs.sendMessage(tabId, command)) as ContentResult;
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) break;

      if (attempt === 0) {
        try {
          await chrome.tabs.reload(tabId);
          await waitForTabComplete(tabId, 30_000);
        } catch (reloadError) {
          lastError = reloadError;
        }
      }

      await sleep(RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS.at(-1) ?? 2_000);
    }
  }

  return { ok: false, error: lastError instanceof Error ? lastError.message : String(lastError) };
}

async function withAgentQueue<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
  const previous = agentQueues.get(agentId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  agentQueues.set(agentId, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (agentQueues.get(agentId) === tail) agentQueues.delete(agentId);
  }
}

async function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  const current = await chrome.tabs.get(tabId);
  if (current.status === 'complete') return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Timed out loading ChatGPT tab.'));
    }, timeoutMs);
    const listener = (updatedId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedId === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
