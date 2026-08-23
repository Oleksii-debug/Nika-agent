import type { ChatAgent, ContentCommand, ContentResult } from './types';
import { appendLog } from './storage';

export async function ensureAgentTab(agent: ChatAgent): Promise<number> {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  const exact = tabs.find((tab) => tab.url === agent.url && typeof tab.id === 'number');
  if (exact?.id) return exact.id;

  const created = await chrome.tabs.create({ url: agent.url, active: false });
  if (typeof created.id !== 'number') throw new Error(`Unable to create tab for ${agent.name}`);
  await waitForTabComplete(created.id, 30_000);
  return created.id;
}

export async function sendToAgent(agent: ChatAgent, prompt: string): Promise<void> {
  const tabId = await ensureAgentTab(agent);
  if (agent.completion.waitForIdle) {
    await waitUntilIdle(tabId, agent.completion.timeoutMs, agent.completion.settleMs);
  }
  const result = await contentCommand(tabId, { type: 'send', prompt });
  if (!result.ok) throw new Error(result.error);
  await appendLog({ agentId: agent.id, level: 'info', event: 'prompt_sent', detail: prompt.slice(0, 500) });
}

export async function captureAgentResponse(agent: ChatAgent): Promise<string> {
  const tabId = await ensureAgentTab(agent);
  await waitUntilIdle(tabId, agent.completion.timeoutMs, agent.completion.settleMs);
  const result = await contentCommand(tabId, { type: 'captureLatest' });
  if (!result.ok || !result.text) throw new Error(result.ok ? 'Response was empty.' : result.error);
  await appendLog({ agentId: agent.id, level: 'info', event: 'response_captured', detail: result.text.slice(0, 500) });
  return result.text;
}

export async function waitUntilIdle(tabId: number, timeoutMs: number, settleMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let idleSince: number | null = null;

  while (Date.now() < deadline) {
    try {
      const result = await contentCommand(tabId, { type: 'status' });
      if (result.ok && result.state === 'idle') {
        idleSince ??= Date.now();
        if (Date.now() - idleSince >= settleMs) return;
      } else {
        idleSince = null;
      }
    } catch {
      idleSince = null;
    }
    await sleep(1000);
  }
  throw new Error('Timed out waiting for ChatGPT to become idle.');
}

async function contentCommand(tabId: number, command: ContentCommand): Promise<ContentResult> {
  try {
    return (await chrome.tabs.sendMessage(tabId, command)) as ContentResult;
  } catch (error) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-scripts/chatgpt.js'] }).catch(() => undefined);
    await sleep(300);
    try {
      return (await chrome.tabs.sendMessage(tabId, command)) as ContentResult;
    } catch (retryError) {
      return { ok: false, error: retryError instanceof Error ? retryError.message : String(retryError ?? error) };
    }
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
