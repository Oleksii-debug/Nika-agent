import type { ChatAgent, ContentCommand, ContentResult, ExecutionContext } from './types';
import { appendLog } from './storage';

const agentQueues = new Map<string, Promise<void>>();
const MAX_MESSAGE_ATTEMPTS = 3;
const RETRY_BASE_MS = 250;

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
  context: ExecutionContext = {},
): Promise<void> {
  await withAgentLease(agent.id, async () => {
    const tabId = await ensureAgentTab(agent);
    if (agent.completion.waitForIdle) {
      await waitUntilIdle(tabId, agent.completion.timeoutMs, agent.completion.settleMs);
    }
    const result = await contentCommand(tabId, { type: 'send', prompt });
    if (!result.ok) throw new Error(result.error);
    await appendLog({
      agentId: agent.id,
      ...context,
      level: 'info',
      event: 'prompt_sent',
      detail: prompt.slice(0, 500),
    });
  });
}

export async function captureAgentResponse(
  agent: ChatAgent,
  context: ExecutionContext = {},
): Promise<string> {
  return withAgentLease(agent.id, async () => {
    const tabId = await ensureAgentTab(agent);
    await waitUntilIdle(tabId, agent.completion.timeoutMs, agent.completion.settleMs);
    const result = await contentCommand(tabId, { type: 'captureLatest' });
    if (!result.ok || !result.text) throw new Error(result.ok ? 'Response was empty.' : result.error);
    await appendLog({
      agentId: agent.id,
      ...context,
      level: 'info',
      event: 'response_captured',
      detail: result.text.slice(0, 500),
    });
    return result.text;
  });
}

export async function waitForAgentIdle(
  agent: ChatAgent,
  timeoutOverride?: number,
  context: ExecutionContext = {},
): Promise<void> {
  await withAgentLease(agent.id, async () => {
    const tabId = await ensureAgentTab(agent);
    await waitUntilIdle(
      tabId,
      timeoutOverride ?? agent.completion.timeoutMs,
      agent.completion.settleMs,
    );
    await appendLog({
      agentId: agent.id,
      ...context,
      level: 'info',
      event: 'agent_idle',
    });
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

export async function withAgentLease<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
  const previous = agentQueues.get(agentId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  agentQueues.set(agentId, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (agentQueues.get(agentId) === tail) agentQueues.delete(agentId);
  }
}

async function contentCommand(
  tabId: number,
  command: ContentCommand,
  recover = true,
): Promise<ContentResult> {
  let lastError: unknown;
  const attempts = recover ? MAX_MESSAGE_ATTEMPTS : 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return (await chrome.tabs.sendMessage(tabId, command)) as ContentResult;
    } catch (error) {
      lastError = error;
      if (!recover || attempt === attempts) break;

      await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
      await chrome.tabs.reload(tabId);
      await waitForTabComplete(tabId, 30_000);
    }
  }

  return {
    ok: false,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  };
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
