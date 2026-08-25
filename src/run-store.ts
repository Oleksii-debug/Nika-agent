import Dexie, { type Table } from 'dexie';
import type { AgentLease, RunRecord } from './types';

class NikaDatabase extends Dexie {
  runs!: Table<RunRecord, string>;
  leases!: Table<AgentLease, string>;

  constructor() {
    super('nika-agent');
    this.version(1).stores({
      runs: 'runId, workflowId, state, wakeAt, updatedAt',
      leases: 'agentId, ownerRunId, expiresAt',
    });
  }
}

export const nikaDb = new NikaDatabase();

export async function createRunRecord(workflowId: string, runId = crypto.randomUUID()): Promise<RunRecord> {
  const now = new Date().toISOString();
  const record: RunRecord = {
    runId,
    workflowId,
    currentStepIndex: 0,
    stepState: 'pending',
    state: 'queued',
    context: {},
    createdAt: now,
    updatedAt: now,
    retryCount: 0,
    correlationId: crypto.randomUUID(),
  };
  await nikaDb.runs.add(record);
  return record;
}

export async function getRunRecord(runId: string): Promise<RunRecord | undefined> {
  return nikaDb.runs.get(runId);
}

export async function saveRunRecord(record: RunRecord): Promise<void> {
  await nikaDb.runs.put({ ...record, updatedAt: new Date().toISOString() });
}

export async function listRecoverableRuns(now = new Date()): Promise<RunRecord[]> {
  const candidates = await nikaDb.runs.where('state').anyOf('queued', 'running', 'sleeping', 'needs_reconciliation').toArray();
  const timestamp = now.getTime();
  return candidates.filter((run) => run.state !== 'sleeping' || !run.wakeAt || Date.parse(run.wakeAt) <= timestamp);
}

export async function acquireAgentLease(
  agentId: string,
  ownerRunId: string,
  ttlMs = 120_000,
): Promise<boolean> {
  const now = Date.now();
  const expiresAt = new Date(now + ttlMs).toISOString();

  return nikaDb.transaction('rw', nikaDb.leases, async () => {
    const existing = await nikaDb.leases.get(agentId);
    if (existing && existing.ownerRunId !== ownerRunId && Date.parse(existing.expiresAt) > now) return false;

    await nikaDb.leases.put({
      agentId,
      ownerRunId,
      acquiredAt: new Date(now).toISOString(),
      expiresAt,
    });
    return true;
  });
}

export async function releaseAgentLease(agentId: string, ownerRunId: string): Promise<void> {
  await nikaDb.transaction('rw', nikaDb.leases, async () => {
    const lease = await nikaDb.leases.get(agentId);
    if (lease?.ownerRunId === ownerRunId) await nikaDb.leases.delete(agentId);
  });
}

export async function clearExpiredLeases(now = new Date()): Promise<number> {
  const expired = await nikaDb.leases.where('expiresAt').belowOrEqual(now.toISOString()).primaryKeys();
  await nikaDb.leases.bulkDelete(expired);
  return expired.length;
}
