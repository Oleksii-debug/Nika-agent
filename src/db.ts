import Dexie, { type EntityTable } from 'dexie';
import type { AgentLease, RunRecord } from './types';

class NikaDatabase extends Dexie {
  runs!: EntityTable<RunRecord, 'runId'>;
  leases!: EntityTable<AgentLease, 'agentId'>;

  constructor() {
    super('nika-agent');
    this.version(1).stores({
      runs: 'runId, workflowId, state, updatedAt, wakeAt',
      leases: 'agentId, ownerRunId, expiresAt',
    });
  }
}

export const db = new NikaDatabase();

export async function putRun(run: RunRecord): Promise<void> {
  await db.runs.put(run);
}

export async function getRun(runId: string): Promise<RunRecord | undefined> {
  return db.runs.get(runId);
}

export async function getRecoverableRuns(): Promise<RunRecord[]> {
  return db.runs.where('state').anyOf('running', 'waiting').toArray();
}

export async function updateRun(runId: string, patch: Partial<RunRecord>): Promise<void> {
  await db.runs.update(runId, { ...patch, updatedAt: new Date().toISOString() });
}

export async function acquireAgentLease(
  agentId: string,
  ownerRunId: string,
  ttlMs = 120_000,
): Promise<AgentLease | null> {
  const now = Date.now();
  const lease = await db.transaction('rw', db.leases, async () => {
    const current = await db.leases.get(agentId);
    if (current && Date.parse(current.expiresAt) > now && current.ownerRunId !== ownerRunId) return null;

    const next: AgentLease = {
      agentId,
      ownerRunId,
      fencingToken: crypto.randomUUID(),
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    };
    await db.leases.put(next);
    return next;
  });
  return lease;
}

export async function renewAgentLease(lease: AgentLease, ttlMs = 120_000): Promise<AgentLease | null> {
  return db.transaction('rw', db.leases, async () => {
    const current = await db.leases.get(lease.agentId);
    if (!current || current.ownerRunId !== lease.ownerRunId || current.fencingToken !== lease.fencingToken) return null;

    const renewed = { ...current, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
    await db.leases.put(renewed);
    return renewed;
  });
}

export async function releaseAgentLease(lease: AgentLease): Promise<void> {
  await db.transaction('rw', db.leases, async () => {
    const current = await db.leases.get(lease.agentId);
    if (current?.ownerRunId === lease.ownerRunId && current.fencingToken === lease.fencingToken) {
      await db.leases.delete(lease.agentId);
    }
  });
}

export async function purgeExpiredLeases(now = Date.now()): Promise<number> {
  const expired = await db.leases.filter((lease) => Date.parse(lease.expiresAt) <= now).primaryKeys();
  if (expired.length === 0) return 0;
  await db.leases.bulkDelete(expired);
  return expired.length;
}
