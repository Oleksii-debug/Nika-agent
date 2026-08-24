import type { ChatAgent, ContentCommand, ContentResult, RunSource, StateEvidence } from './types';
import type { SendIntent } from './db';
import { appendLog } from './storage';
import { getOrCreateSendIntent, setSendIntentState } from './send-intents';

const agentQueues = new Map<string, Promise<void>>();

export type RuntimeExecutionContext = {
  runId?: string;
  workflowId?: string;
  stepId?: string;
  source?: RunSource;
  jobId?: string;
};

export async function ensureAgentTab(agent: ChatAgent): Promise<number> {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  const exact = tabs.find((tab) => tab.url === agent.url && typeof tab.id === 'number');
  if (exact?.id) return exact.id;

  const created = await chrome.tabs.create({ url: agent.url, active: false });
  if (typeof created.id !== 'number') throw new Error(`Unable to create tab for ${agent.name}`);
  await waitForTabComplete(created.id, 30_000);
  return created.id;
}

export async function runAgentExclusive<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
  const previous = agentQueues.get(agentId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
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

export async function sendToAgent(
  agent: ChatAgent,
  prompt: string,
  context: RuntimeExecutionContext = {},
): Promise<void> {
  return runAgentExclusive(agent.id, async () => {
    const tabId = await ensureAgentTab(agent);
    if (agent.completion.waitForIdle) await waitUntilIdle(tabId, agent.completion.timeoutMs, agent.completion.settleMs);

    const status = await contentCommand(tabId, { type: 'status' }, { recover: true });
    if (!status.ok || !status.evidence) throw new Error(status.ok ? 'Chat state evidence is unavailable.' : status.error);
    if (status.evidence.state !== 'idle') throw new Error(`Chat is not send-safe: ${status.evidence.state}.`);

    const intentInput: Parameters<typeof getOrCreateSendIntent>[0] = {
      agentId: agent.id,
      prompt,
      baselineUserTurnCount: status.evidence.userTurnCount,
    };
    if (context.jobId !== undefined) intentInput.jobId = context.jobId;
    if (context.runId !== undefined) intentInput.runId = context.runId;
    const intent = await getOrCreateSendIntent(intentInput);

    if (intent.state === 'confirmed') return;
    if (intent.state === 'dispatching' || intent.state === 'ambiguous') {
      const presence = await reconcileSendIntent(agent, intent);
      if (presence === 'confirmed') return;
      if (presence === 'ambiguous') throw new Error('SEND_AMBIGUOUS: persisted send intent cannot be uniquely reconciled.');
    }

    await setSendIntentState(intent.id, 'dispatching');
    const result = await contentCommand(tabId, {
      type: 'send',
      prompt: intent.prompt,
      promptHash: intent.promptHash,
      baselineUserTurnCount: intent.baselineUserTurnCount,
    }, { recover: false });

    if (!result.ok) throw new Error(result.error);
    if (result.sendStatus !== 'confirmed') {
      await setSendIntentState(intent.id, 'ambiguous', result.detail ?? 'DOM submit occurred but user-turn confirmation was not unique.');
      throw new Error('SEND_AMBIGUOUS: prompt submission was not confirmed by a unique new user turn.');
    }

    await setSendIntentState(intent.id, 'confirmed');
    await appendLog({ agentId: agent.id, ...context, level: 'info', event: 'prompt_sent', detail: prompt.slice(0, 500) });
  });
}

export async function reconcileSendIntent(agent: ChatAgent, intent: SendIntent): Promise<'confirmed' | 'absent' | 'ambiguous'> {
  return runAgentExclusive(agent.id, async () => {
    const tabId = await ensureAgentTab(agent);
    const result = await contentCommand(tabId, {
      type: 'verifyPrompt',
      promptHash: intent.promptHash,
      baselineUserTurnCount: intent.baselineUserTurnCount,
    }, { recover: true });
    if (!result.ok || !result.presence) {
      await setSendIntentState(intent.id, 'ambiguous', result.ok ? 'Prompt presence result missing.' : result.error);
      return 'ambiguous';
    }
    await setSendIntentState(intent.id, result.presence, result.detail);
    return result.presence;
  });
}

export async function inspectAgentState(agent: ChatAgent): Promise<StateEvidence> {
  return runAgentExclusive(agent.id, async () => {
    const tabId = await ensureAgentTab(agent);
    const result = await contentCommand(tabId, { type: 'status' }, { recover: true });
    if (!result.ok || !result.evidence) throw new Error(result.ok ? 'Chat state evidence is unavailable.' : result.error);
    return result.evidence;
  });
}

export function isStablyIdle(evidence: StateEvidence, settleMs: number): boolean {
  return evidence.state === 'idle'
    && evidence.composerEditable
    && !evidence.stopControlPresent
    && (evidence.mutationAgeMs ?? settleMs) >= settleMs;
}

export async function waitForAgentIdle(agent: ChatAgent, timeoutOverride?: number, context: RuntimeExecutionContext = {}): Promise<void> {
  return runAgentExclusive(agent.id, async () => {
    const tabId = await ensureAgentTab(agent);
    await waitUntilIdle(tabId, timeoutOverride ?? agent.completion.timeoutMs, agent.completion.settleMs);
    await appendLog({ agentId: agent.id, ...context, level: 'info', event: 'agent_idle' });
  });
}

export async function captureAgentResponse(agent: ChatAgent, context: RuntimeExecutionContext = {}): Promise<string> {
  return runAgentExclusive(agent.id, async () => {
    const tabId = await ensureAgentTab(agent);
    await waitUntilIdle(tabId, agent.completion.timeoutMs, agent.completion.settleMs);
    const result = await contentCommand(tabId, { type: 'captureLatest' }, { recover: true });
    if (!result.ok || !result.text) throw new Error(result.ok ? 'Response was empty.' : result.error);
    await appendLog({ agentId: agent.id, ...context, level: 'info', event: 'response_captured', detail: result.text.slice(0, 500) });
    return result.text;
  });
}

export async function waitUntilIdle(tabId: number, timeoutMs: number, settleMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let idleSince: number | null = null;
  while (Date.now() < deadline) {
    const result = await contentCommand(tabId, { type: 'status' }, { recover: true });
    const evidence = result.ok ? result.evidence : undefined;
    if (result.ok && evidence && isStablyIdle(evidence, settleMs)) {
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= Math.min(1000, settleMs)) return;
    } else {
      idleSince = null;
    }
    await sleep(1000);
  }
  throw new Error('Timed out waiting for ChatGPT to become stably idle.');
}

type ContentCommandOptions = { recover: boolean; attempts?: number };

async function contentCommand(tabId: number, command: ContentCommand, options: ContentCommandOptions): Promise<ContentResult> {
  const attempts = Math.max(1, options.attempts ?? (options.recover ? 3 : 1));
  let lastError = 'Unknown content-script error.';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return (await chrome.tabs.sendMessage(tabId, command)) as ContentResult;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (!options.recover || attempt === attempts) break;
      if (attempt === 1) {
        const status = await chrome.tabs.get(tabId);
        if (status.status !== 'complete') await waitForTabComplete(tabId, 30_000);
      }
      await sleep(Math.min(2000, 250 * 2 ** (attempt - 1)));
    }
  }
  return { ok: false, error: lastError };
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
