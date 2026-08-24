import {
  ADAPTER_VERSION,
  PROTOCOL_VERSION,
  SITE_PROFILE_VERSION,
  parseActionResult,
} from './protocol';
import type { ChatAgent, ContentCommand, ContentResult, RuntimeHealthV1 } from './types';
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
  await assertHealthyAdapter(tabId, agent.url);
  if (agent.completion.waitForIdle) {
    await waitUntilIdle(tabId, agent.completion.timeoutMs, agent.completion.settleMs);
  }
  const result = await contentCommand(tabId, createCommand({ type: 'send', prompt }));
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  await appendLog({ agentId: agent.id, level: 'info', event: 'prompt_sent', detail: prompt.slice(0, 500) });
}

export async function captureAgentResponse(agent: ChatAgent): Promise<string> {
  const tabId = await ensureAgentTab(agent);
  await assertHealthyAdapter(tabId, agent.url);
  await waitUntilIdle(tabId, agent.completion.timeoutMs, agent.completion.settleMs);
  const result = await contentCommand(tabId, createCommand({ type: 'captureLatest' }));
  if (!result.ok || !result.text) {
    throw new Error(result.ok ? 'Response was empty.' : `${result.code}: ${result.error}`);
  }
  await appendLog({ agentId: agent.id, level: 'info', event: 'response_captured', detail: result.text.slice(0, 500) });
  return result.text;
}

export async function waitUntilIdle(tabId: number, timeoutMs: number, settleMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let idleSince: number | null = null;

  while (Date.now() < deadline) {
    const result = await contentCommand(tabId, createCommand({ type: 'status' }), false);
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

export async function getRuntimeHealth(tabId: number): Promise<RuntimeHealthV1> {
  const result = await contentCommand(tabId, createCommand({ type: 'runtime.health' }));
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  if (!result.health) throw new Error('Adapter health response was missing health metadata.');
  return result.health;
}

async function assertHealthyAdapter(tabId: number, expectedUrl: string): Promise<void> {
  const health = await getRuntimeHealth(tabId);
  if (health.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`Protocol mismatch: expected ${PROTOCOL_VERSION}, received ${health.protocolVersion}.`);
  }
  if (health.adapterVersion !== ADAPTER_VERSION || health.siteProfileVersion !== SITE_PROFILE_VERSION) {
    throw new Error(
      `Adapter mismatch: expected ${ADAPTER_VERSION}/${SITE_PROFILE_VERSION}, received ${health.adapterVersion}/${health.siteProfileVersion}.`,
    );
  }
  if (!sameConversationTarget(health.observedUrl, expectedUrl)) {
    throw new Error(`Target moved: expected ${expectedUrl}, observed ${health.observedUrl}.`);
  }
}

function sameConversationTarget(observed: string, expected: string): boolean {
  try {
    const a = new URL(observed);
    const b = new URL(expected);
    return a.origin === b.origin && normalizePath(a.pathname) === normalizePath(b.pathname);
  } catch {
    return observed === expected;
  }
}

function normalizePath(path: string): string {
  return path.replace(/\/+$/, '') || '/';
}

type CommandPayload =
  | { type: 'status' }
  | { type: 'send'; prompt: string }
  | { type: 'captureLatest' }
  | { type: 'runtime.health' };

function createCommand(payload: CommandPayload): ContentCommand {
  return {
    protocolVersion: PROTOCOL_VERSION,
    commandId: crypto.randomUUID(),
    ...payload,
  } as ContentCommand;
}

async function contentCommand(
  tabId: number,
  command: ContentCommand,
  recover = true,
): Promise<ContentResult> {
  try {
    return normalizeResult(await chrome.tabs.sendMessage(tabId, command), command.commandId);
  } catch (error) {
    if (!recover) {
      return {
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        ok: false,
        code: 'TARGET_UNAVAILABLE',
        error: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      await chrome.tabs.reload(tabId);
      await waitForTabComplete(tabId, 30_000);
      await sleep(500);
      return normalizeResult(await chrome.tabs.sendMessage(tabId, command), command.commandId);
    } catch (retryError) {
      return {
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        ok: false,
        code: 'TARGET_UNAVAILABLE',
        error: retryError instanceof Error ? retryError.message : String(retryError ?? error),
      };
    }
  }
}

function normalizeResult(input: unknown, commandId: string): ContentResult {
  const result = parseActionResult(input);
  if (!result) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      commandId,
      ok: false,
      code: 'INVALID_COMMAND',
      error: 'Content script returned an invalid protocol payload.',
    };
  }
  if (result.commandId !== commandId) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      commandId,
      ok: false,
      code: 'INVALID_COMMAND',
      error: `Command correlation mismatch: received '${result.commandId}'.`,
    };
  }
  return result;
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
