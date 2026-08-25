import { db, type AgentQuarantine } from './db';
import { getAgents } from './storage';
import { canonicalTargetKey } from './target-claims';
import type { ChatBlockerKind, ChatState, StateEvidence } from './types';

export type QuarantineDisposition =
  | { mode: 'manual'; reason: ChatBlockerKind }
  | { mode: 'cooldown'; reason: ChatBlockerKind; cooldownMs: number };

const RATE_LIMIT_COOLDOWN_MS = 60 * 60_000;
const PAGE_ERROR_COOLDOWN_MS = 15 * 60_000;
const TARGET_QUARANTINE_PREFIX = 'target:';

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

type TargetContext = {
  storageKey: string;
  aliasIds: string[];
};

async function targetContext(agentId: string): Promise<TargetContext> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return { storageKey: `agent:${agentId}`, aliasIds: [agentId] };
  }
  const agents = await getAgents();
  const source = agents.find((agent) => agent.id === agentId);
  if (!source) return { storageKey: `agent:${agentId}`, aliasIds: [agentId] };
  const targetKey = canonicalTargetKey(source.url);
  const aliasIds = agents
    .filter((agent) => canonicalTargetKey(agent.url) === targetKey)
    .map((agent) => agent.id);
  return {
    storageKey: `${TARGET_QUARANTINE_PREFIX}${targetKey}`,
    aliasIds: aliasIds.length ? aliasIds : [agentId],
  };
}

function project(record: AgentQuarantine, agentId: string): AgentQuarantine {
  return { ...record, agentId };
}

function isActive(record: AgentQuarantine, now: Date): boolean {
  if (record.mode === 'manual') return true;
  const resumeAt = record.resumeAt ? Date.parse(record.resumeAt) : Number.NaN;
  return !Number.isFinite(resumeAt) || resumeAt > now.getTime();
}

async function readCanonicalOrMigrateLegacy(agentId: string, now: Date): Promise<AgentQuarantine | undefined> {
  const context = await targetContext(agentId);
  const canonical = await db.agentQuarantines.get(context.storageKey);
  if (canonical) {
    if (isActive(canonical, now)) return project(canonical, agentId);
    await db.agentQuarantines.delete(context.storageKey);
    return undefined;
  }

  const legacy = (await db.agentQuarantines.bulkGet(context.aliasIds))
    .filter((item): item is AgentQuarantine => !!item)
    .filter((item) => isActive(item, now));
  if (!legacy.length) {
    await db.agentQuarantines.bulkDelete(context.aliasIds);
    return undefined;
  }

  const selected = legacy.find((item) => item.mode === 'manual') ?? legacy[0]!;
  const migrated: AgentQuarantine = { ...selected, agentId: context.storageKey };
  await db.transaction('rw', db.agentQuarantines, async () => {
    await db.agentQuarantines.put(migrated);
    await db.agentQuarantines.bulkDelete(context.aliasIds);
  });
  return project(migrated, agentId);
}

export async function quarantineAgent(agentId: string, evidence: StateEvidence, now = new Date()): Promise<AgentQuarantine | undefined> {
  const disposition = quarantineDisposition(evidence);
  if (!disposition) return undefined;
  const context = await targetContext(agentId);
  const timestamp = now.toISOString();
  const canonical = await db.agentQuarantines.get(context.storageKey);
  const legacy = (await db.agentQuarantines.bulkGet(context.aliasIds)).filter(Boolean) as AgentQuarantine[];
  const createdAt = [canonical, ...legacy]
    .filter((item): item is AgentQuarantine => !!item)
    .map((item) => item.createdAt)
    .sort()[0] ?? timestamp;

  const record: AgentQuarantine = {
    agentId: context.storageKey,
    state: evidence.state,
    blockerKind: disposition.reason,
    mode: disposition.mode,
    createdAt,
    updatedAt: timestamp,
  };
  if (disposition.mode === 'cooldown') {
    record.resumeAt = new Date(now.getTime() + disposition.cooldownMs).toISOString();
  }
  if (evidence.visibleError) record.detail = evidence.visibleError;
  if (evidence.pageUrl) record.pageUrl = evidence.pageUrl;

  await db.transaction('rw', db.agentQuarantines, async () => {
    await db.agentQuarantines.put(record);
    await db.agentQuarantines.bulkDelete(context.aliasIds);
  });
  return project(record, agentId);
}

export async function getActiveAgentQuarantine(agentId: string, now = new Date()): Promise<AgentQuarantine | undefined> {
  return readCanonicalOrMigrateLegacy(agentId, now);
}

export async function clearAgentQuarantine(agentId: string): Promise<void> {
  const context = await targetContext(agentId);
  await db.agentQuarantines.bulkDelete([context.storageKey, ...context.aliasIds]);
}

export async function listAgentQuarantines(now = new Date()): Promise<AgentQuarantine[]> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return (await db.agentQuarantines.toArray()).filter((item) => isActive(item, now));
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
