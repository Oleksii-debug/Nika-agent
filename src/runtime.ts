import type { ChatAgent, ChatState, ContentCommand, ContentResult, RunSource, StateEvidence } from './types';
import type { SendIntent } from './db';
import { appendLog } from './storage';
import { evaluateSendEffectProof } from './effect-proof';
import { describeRouteMismatch, sameChatRoute } from './route-identity';
import { getOrCreateSendIntent, setSendIntentState, settleSendIntentEffectProof } from './send-intents';

const agentQueues = new Map<string, Promise<void>>();
const HARD_BLOCKED_STATES = new Set<ChatState>(['blocked', 'logged_out', 'rate_limited', 'verification_required', 'unsupported']);

export class ChatSurfaceBlockedError extends Error {
  readonly agentId: string;
  readonly evidence: StateEvidence;

  constructor(agentId: string, evidence: StateEvidence) {
    super(describeUnsafeEvidence(evidence));
    this.name = 'ChatSurfaceBlockedError';
    this.agentId = agentId;
    this.evidence = evidence;
  }
}

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
    if (agent.completion.waitForIdle) await waitUntilIdle(tabId, agent.completion.timeoutMs, agent.completion.settleMs, agent.id);

    const status = await contentCommand(tabId, { type: 'status' }, { recover: true });
    if (!status.ok || !status.evidence) throw new Error(status.ok ? 'Chat state evidence is unavailable.' : status.error);
    if (status.evidence.state !== 'idle') throw blockedError(agent.id, status.evidence);
    assertExpectedAgentRoute(agent, status.evidence);

    const intentInput: Parameters<typeof getOrCreateSendIntent>[0] = {
      agentId: agent.id,
      prompt,
      baselineUserTurnCount: status.evidence.userTurnCount,
    };
    if (context.jobId !== undefined) intentInput.jobId = context.jobId;
    if (context.runId !== undefined) intentInput.runId = context.runId;
    if (status.evidence.pageUrl !== undefined) intentInput.baselinePageUrl = status.evidence.pageUrl;
    if (status.evidence.selectorProfile !== undefined) intentInput.baselineSelectorProfile = status.evidence.selectorProfile;
    const intent = await getOrCreateSendIntent(intentInput);

    if (intent.state === 'confirmed') return;
    if (intent.state === 'dispatching' || intent.state === 'ambiguous') {
      const presence = await reconcileSendIntentUnlocked(agent, intent);
      if (presence === 'confirmed') return;
      if (presence === 'ambiguous') throw new Error('SEND_AMBIGUOUS: persisted send intent cannot be causally reconciled.');
    }

    // Re-observe immediately before crossing into DISPATCHING. This closes the
    // runtime-side navigation race; the content script repeats the same fence
    // at the final click/Enter boundary after composer stability verification.
    const preDispatchStatus = await contentCommand(tabId, { type: 'status' }, { recover: true });
    if (!preDispatchStatus.ok || !preDispatchStatus.evidence) {
      throw new Error(preDispatchStatus.ok ? 'Pre-dispatch route evidence is unavailable.' : preDispatchStatus.error);
    }
    if (preDispatchStatus.evidence.state !== 'idle') throw blockedError(agent.id, preDispatchStatus.evidence);
    assertExpectedAgentRoute(agent, preDispatchStatus.evidence);

    await setSendIntentState(intent.id, 'dispatching');
    const result = await contentCommand(tabId, {
      type: 'send',
      prompt: intent.prompt,
      promptHash: intent.promptHash,
      baselineUserTurnCount: intent.baselineUserTurnCount,
      expectedPageUrl: agent.url,
    }, { recover: false });

    if (!result.ok) {
      if (result.evidence && HARD_BLOCKED_STATES.has(result.evidence.state)) throw blockedError(agent.id, result.evidence);
      const reconciled = await reconcileSendIntentUnlocked(agent, intent);
      if (reconciled === 'confirmed') {
        await appendLog({ agentId: agent.id, ...context, level: 'info', event: 'prompt_sent', detail: prompt.slice(0, 500) });
        return;
      }
      if (reconciled === 'ambiguous') throw new Error(`SEND_AMBIGUOUS: ${result.error}`);
      throw new Error(result.error);
    }

    const settled = await settleResultWithFreshObservation(tabId, intent, result);
    if (settled === 'confirmed') {
      await appendLog({ agentId: agent.id, ...context, level: 'info', event: 'prompt_sent', detail: prompt.slice(0, 500) });
      return;
    }
    if (settled === 'absent') {
      throw new Error('SEND_NO_EFFECT: one-shot dispatch produced no observable user turn; durable retry is permitted.');
    }
    throw new Error('SEND_AMBIGUOUS: one-shot dispatch changed the surface without a unique causal proof.');
  });
}

export async function reconcileSendIntent(agent: ChatAgent, intent: SendIntent): Promise<'confirmed' | 'absent' | 'ambiguous'> {
  return runAgentExclusive(agent.id, () => reconcileSendIntentUnlocked(agent, intent));
}

async function reconcileSendIntentUnlocked(agent: ChatAgent, intent: SendIntent): Promise<'confirmed' | 'absent' | 'ambiguous'> {
  const tabId = await ensureAgentTab(agent);
  const routeStatus = await contentCommand(tabId, { type: 'status' }, { recover: true });
  if (!routeStatus.ok || !routeStatus.evidence?.pageUrl || !sameChatRoute(agent.url, routeStatus.evidence.pageUrl)) {
    const observed = routeStatus.ok ? routeStatus.evidence?.pageUrl ?? '<missing>' : `<unavailable:${routeStatus.error}>`;
    await setSendIntentState(intent.id, 'ambiguous', describeRouteMismatch(agent.url, observed));
    return 'ambiguous';
  }

  const result = await contentCommand(tabId, {
    type: 'verifyPrompt',
    promptHash: intent.promptHash,
    baselineUserTurnCount: intent.baselineUserTurnCount,
  }, { recover: true });
  if (!result.ok) {
    if (result.evidence && HARD_BLOCKED_STATES.has(result.evidence.state)) throw blockedError(agent.id, result.evidence);
    await setSendIntentState(intent.id, 'ambiguous', result.error);
    return 'ambiguous';
  }
  return settleResultWithFreshObservation(tabId, intent, result);
}

async function settleResultWithFreshObservation(
  tabId: number,
  intent: SendIntent,
  result: Extract<ContentResult, { ok: true }>,
): Promise<'confirmed' | 'absent' | 'ambiguous'> {
  const observation = await contentCommand(tabId, { type: 'status' }, { recover: true });
  if (!observation.ok || !observation.evidence) {
    await setSendIntentState(
      intent.id,
      'ambiguous',
      observation.ok ? 'Fresh post-dispatch state evidence is unavailable.' : observation.error,
    );
    return 'ambiguous';
  }

  if (
    intent.baselineSelectorProfile
    && observation.evidence.selectorProfile
    && intent.baselineSelectorProfile !== observation.evidence.selectorProfile
  ) {
    await setSendIntentState(intent.id, 'ambiguous', 'Selector profile changed between baseline and effect observation.');
    return 'ambiguous';
  }

  const proof = evaluateSendEffectProof({
    baselinePageUrl: intent.baselinePageUrl,
    observedPageUrl: observation.evidence.pageUrl,
    baselineUserTurnCount: intent.baselineUserTurnCount,
    observedUserTurnCount: observation.evidence.userTurnCount,
    matches: result.matches ?? 0,
  });
  const state = await settleSendIntentEffectProof(intent.id, proof);
  return state === 'confirmed' ? 'confirmed' : state === 'absent' ? 'absent' : 'ambiguous';
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
    await waitUntilIdle(tabId, timeoutOverride ?? agent.completion.timeoutMs, agent.completion.settleMs, agent.id);
    await appendLog({ agentId: agent.id, ...context, level: 'info', event: 'agent_idle' });
  });
}

export async function captureAgentResponse(agent: ChatAgent, context: RuntimeExecutionContext = {}): Promise<string> {
  return runAgentExclusive(agent.id, async () => {
    const tabId = await ensureAgentTab(agent);
    await waitUntilIdle(tabId, agent.completion.timeoutMs, agent.completion.settleMs, agent.id);
    const result = await contentCommand(tabId, { type: 'captureLatest' }, { recover: true });
    if (!result.ok || !result.text) {
      if (!result.ok && result.evidence && HARD_BLOCKED_STATES.has(result.evidence.state)) throw blockedError(agent.id, result.evidence);
      throw new Error(result.ok ? 'Response was empty.' : result.error);
    }
    await appendLog({ agentId: agent.id, ...context, level: 'info', event: 'response_captured', detail: result.text.slice(0, 500) });
    return result.text;
  });
}

export async function waitUntilIdle(tabId: number, timeoutMs: number, settleMs: number, agentId?: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let idleSince: number | null = null;
  while (Date.now() < deadline) {
    const result = await contentCommand(tabId, { type: 'status' }, { recover: true });
    const evidence = result.ok ? result.evidence : undefined;
    if (evidence && HARD_BLOCKED_STATES.has(evidence.state)) {
      if (agentId) throw blockedError(agentId, evidence);
      throw new Error(describeUnsafeEvidence(evidence));
    }
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

function assertExpectedAgentRoute(agent: ChatAgent, evidence: StateEvidence): void {
  if (!evidence.pageUrl || !sameChatRoute(agent.url, evidence.pageUrl)) {
    throw new Error(describeRouteMismatch(agent.url, evidence.pageUrl ?? '<missing>'));
  }
}

function blockedError(agentId: string, evidence: StateEvidence): ChatSurfaceBlockedError {
  return new ChatSurfaceBlockedError(agentId, evidence);
}

function describeUnsafeEvidence(evidence: StateEvidence): string {
  const blocker = evidence.blockerKind ? `/${evidence.blockerKind}` : '';
  const detail = evidence.visibleError ? `: ${evidence.visibleError}` : '';
  return `CHAT_SURFACE_BLOCKED[${evidence.state}${blocker}]${detail}`;
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
    const listener = (updatedId: number, info: { status?: string }) => {
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