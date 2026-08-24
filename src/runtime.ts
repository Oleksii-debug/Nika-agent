import type { ChatAgent, ContentCommand, ContentResult, ExecutionMeta } from './types';
import { appendLog } from './storage';

const SAFE_TRANSPORT_ATTEMPTS = 3;

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
  meta: ExecutionMeta = {},
): Promise<void> {
  const tabId = await ensureAgentTab(agent);
  if (agent.completion.waitForIdle) {
    await waitUntilIdle(tabId, agent.completion.timeoutMs, agent.completion.settleMs);
  }

  // SEND is deliberately not retried automatically. A broken message channel can be
  // ambiguous: the content script may have performed the side effect before the
  // service worker observed the failure. Retrying blindly can duplicate prompts.
  const result = await contentCommand(tabId, { type: 'send', prompt }, { retryTransport: false });
  if (!result.ok) throw new Error(result.error);
  await appendLog({
    agentId: agent.id,
    ...meta,
    level: 'info',
    event: 'prompt_sent',
    detail: prompt.slice(0, 500),
  });
}

export async function waitForAgentIdle(
  agent: ChatAgent,
  timeoutOverride?: number,
  meta: ExecutionMeta = {},
): Promise<void> {
  const tabId = await ensureAgentTab(agent);
  await waitUntilIdle(tabId, timeoutOverride ?? agent.completion.timeoutMs, agent.completion.settleMs);
  await appendLog({
    agentId: agent.id,
    ...meta,
    level: 'info',
    event: 'agent_idle',
  });
}

export async function captureAgentResponse(
  agent: ChatAgent,
  meta: ExecutionMeta = {},
): Promise<string> {
  const tabId = await ensureAgentTab(agent);
  await waitUntilIdle(tabId, agent.completion.timeoutMs, agent.completion.settleMs);
  const result = await contentCommand(tabId, { type: 'captureLatest' }, { retryTransport: true });
  if (!result.ok || !result.text) throw new Error(result.ok ? 'Response was empty.' : result.error);
  await appendLog({
    agentId: agent.id,
    ...meta,
    level: 'info',
    event: 'response_captured',
    detail: result.text.slice(0, 500),
  });
  return result.text;
}

export async function waitUntilIdle(tabId: number, timeoutMs: number, settleMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let idleSince: number | null = null;

  while (Date.now() < deadline) {
    const result = await contentCommand(tabId, { type: 'status' }, { retryTransport: true });
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

type CommandOptions = {
  retryTransport: boolean;
};

async function contentCommand(
  tabId: number,
  command: ContentCommand,
  options: CommandOptions,
): Promise<ContentResult> {
  const attempts = options.retryTransport ? SAFE_TRANSPORT_ATTEMPTS : 1;
  let lastError = 'Unknown content-script failure.';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return (await chrome.tabs.sendMessage(tabId, command)) as ContentResult;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt >= attempts) break;

      await chrome.tabs.reload(tabId);
      await waitForTabComplete(tabId, 30_000);
      await sleep(backoffMs(attempt));
    }
  }

  return { ok: false, error: lastError };
}

function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 4000);
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
