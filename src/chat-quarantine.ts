import { db, type AgentQuarantine } from './db';
import { getAgents } from './storage';
import { canonicalTargetKey } from './target-claims';
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

async function targetAliasIds(agentId: string): Promise<string[]> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return [agentId];
  const agents = await getAgents();
  const source = agents.find((agent) => agent.id === agentId);
  if (!source) return [agentId];
  const targetKey = canonicalTargetKey(source.url);
  const aliases = agents
    .filter((agent) => canonicalTargetKey(agent.url) === targetKey)
    .map((agent) => agent.id);
  return aliases.length ? aliases : [agentId];
}

export async function quarantineAgent(agentId: string, evidence: StateEvidence, now = new Date()): Promise<AgentQuarantine | undefined> {
  const disposition = quarantineDisposition(evidence);
  if (!disposition) return undefined;
  const aliases = await targetAliasIds(agentId);
  const timestamp = now.toISOString();
  const existing = (await db.agentQuarantines.bulkGet(aliases)).filter(Boolean) as AgentQuarantine[];
  const createdAt = existing.map((item) => item.createdAt).sort()[0] ?? timestamp;

  const records = aliases.map<AgentQuarantine>((aliasId) => {
    const quarantine: AgentQuarantine = {
      agentId: aliasId,
      state: evidence.state,
      blockerKind: disposition.reason,
      mode: disposition.mode,
      createdAt,
      updatedAt: timestamp,
    };
    if (disposition.mode === 'cooldown') {
      quarantine.resumeAt = new Date(now.getTime() + disposition.cooldownMs).toISOString();
    }
    if (evidence.visibleError) quarantine.detail = evidence.visibleError;
    if (evidence.pageUrl) quarantine.pageUrl = evidence.pageUrl;
    return quarantine;
  });

  await db.transaction('rw', db.agentQuarantines, async () => {
    await db.agentQuarantines.bulkPut(records);
  });
  return records.find((record) => record.agentId === agentId) ?? records[0];
}

export async function getActiveAgentQuarantine(agentId: string, now = new Date()): Promise<AgentQuarantine | undefined> {
  const aliases = await targetAliasIds(agentId);
  const records = (await db.agentQuarantines.bulkGet(aliases)).filter(Boolean) as AgentQuarantine[];
  if (!records.length) return undefined;

  const manual = records.find((item) => item.mode === 'manual');
  if (manual) return { ...manual, agentId };

  const activeCooldown = records.find((item) => {
    const resumeAt = item.resumeAt ? Date.parse(item.resumeAt) : Number.NaN;
    return !Number.isFinite(resumeAt) || resumeAt > now.getTime();
  });
  if (activeCooldown) return { ...activeCooldown, agentId };

  await db.agentQuarantines.bulkDelete(aliases);
  return undefined;
}

export async function clearAgentQuarantine(agentId: string): Promise<void> {
  await db.agentQuarantines.bulkDelete(await targetAliasIds(agentId));
}

export async function listAgentQuarantines(now = new Date()): Promise<AgentQuarantine[]> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    const result: AgentQuarantine[] = [];
    for (const item of await db.agentQuarantines.toArray()) {
      const active = await getActiveAgentQuarantine(item.agentId, now);
      if (active) result.push(active);
    }
    return result;
  }

  const agents = await getAgents();
  const representativeByTarget = new Map<string, string>();
  for (const agent of agents) {
    const key = canonicalTargetKey(agent.url);
    if (!representativeByTarget.has(key)) representativeByTarget.set(key, agent.id);
  }

  const result: AgentQuarantine[] = [];
  for (const representativeId of representativeByTarget.values()) {
    const active = await getActiveAgentQuarantine(representativeId, now);
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
