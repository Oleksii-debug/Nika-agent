import { db, type AgentQuarantine } from './db';
import type { ChatBlockerKind, ChatState, StateEvidence } from './types';

export type QuarantineDisposition =
  | { mode: 'manual'; reason: ChatBlockerKind }
  | { mode: 'cooldown'; reason: ChatBlockerKind; cooldownMs: number };

const RATE_LIMIT_COOLDOWN_MS = 60 * 60_000;
const PAGE_ERROR_COOLDOWN_MS = 15 * 60_000;

export function quarantineDisposition(evidence: StateEvidence): QuarantineDisposition | undefined {
  const reason = evidence.blockerKind;
  if (!reason) return undefined;
  switch (reason) {
    case 'rate_limit':
      return { mode: 'cooldown', reason, cooldownMs: RATE_LIMIT_COOLDOWN_MS };
    case 'page_error':
      return { mode: 'cooldown', reason, cooldownMs: PAGE_ERROR_COOLDOWN_MS };
    case 'login':
    case 'verification':
    case 'access':
      return { mode: 'manual', reason };
  }
}

export async function quarantineAgent(agentId: string, evidence: StateEvidence, now = new Date()): Promise<AgentQuarantine | undefined> {
  const disposition = quarantineDisposition(evidence);
  if (!disposition) return undefined;
  const timestamp = now.toISOString();
  const existing = await db.agentQuarantines.get(agentId);
  const quarantine: AgentQuarantine = {
    agentId,
    state: evidence.state,
    blockerKind: disposition.reason,
    mode: disposition.mode,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  if (disposition.mode === 'cooldown') {
    quarantine.resumeAt = new Date(now.getTime() + disposition.cooldownMs).toISOString();
  }
  if (evidence.visibleError) quarantine.detail = evidence.visibleError;
  if (evidence.pageUrl) quarantine.pageUrl = evidence.pageUrl;
  await db.agentQuarantines.put(quarantine);
  return quarantine;
}

export async function getActiveAgentQuarantine(agentId: string, now = new Date()): Promise<AgentQuarantine | undefined> {
  const quarantine = await db.agentQuarantines.get(agentId);
  if (!quarantine) return undefined;
  if (quarantine.mode === 'manual') return quarantine;
  const resumeAt = quarantine.resumeAt ? Date.parse(quarantine.resumeAt) : Number.NaN;
  if (!Number.isFinite(resumeAt)) return quarantine;
  if (resumeAt > now.getTime()) return quarantine;
  await db.agentQuarantines.delete(agentId);
  return undefined;
}

export async function clearAgentQuarantine(agentId: string): Promise<void> {
  await db.agentQuarantines.delete(agentId);
}

export async function listAgentQuarantines(now = new Date()): Promise<AgentQuarantine[]> {
  const result: AgentQuarantine[] = [];
  for (const item of await db.agentQuarantines.toArray()) {
    const active = await getActiveAgentQuarantine(item.agentId, now);
    if (active) result.push(active);
  }
  return result;
}

export function isHardBlockedChatState(state: ChatState): boolean {
  return state === 'blocked'
    || state === 'logged_out'
    || state === 'rate_limited'
    || state === 'verification_required'
    || state === 'unsupported';
}
