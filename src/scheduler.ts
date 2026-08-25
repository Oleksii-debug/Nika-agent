import { db, type DurableJob, type ScheduleCursor } from './db';
import { getActiveAgentQuarantine } from './chat-quarantine';
import type { ChatAgent } from './types';

const LEASE_MS = 2 * 60_000;
const SAFETY_WAKE_MINUTES = 1;
const RUNTIME_BOOT_ID = crypto.randomUUID();

export function getRuntimeBootId(): string {
  return RUNTIME_BOOT_ID;
}

export async function synchronizeSchedules(agents: ChatAgent[], now = new Date()): Promise<void> {
  const enabledIds = new Set(agents.filter((agent) => agent.enabled && agent.schedule.enabled).map((agent) => agent.id));
  const cursors = await db.scheduleCursors.toArray();
  for (const cursor of cursors) if (!enabledIds.has(cursor.agentId)) await db.scheduleCursors.delete(cursor.agentId);
  for (const agent of agents) {
    if (!agent.enabled || !agent.schedule.enabled || agent.schedule.kind === 'manual') continue;
    if (await db.scheduleCursors.get(agent.id)) continue;
    const nextDueAt = initialDueAt(agent, now);
    if (nextDueAt) await db.scheduleCursors.put({ agentId: agent.id, nextDueAt, updatedAt: now.toISOString() });
  }
}

export async function rebuildWakeAlarm(): Promise<void> {
  const cursors = await db.scheduleCursors.toArray();
  const quarantineWakeTimes = (await db.agentQuarantines.toArray())
    .filter((item) => item.mode === 'cooldown' && item.resumeAt)
    .map((item) => Date.parse(item.resumeAt!))
    .filter(Number.isFinite);
  const next = [
    ...cursors.map((cursor) => cursor.nextDueAt ? Date.parse(cursor.nextDueAt) : Number.POSITIVE_INFINITY),
    ...quarantineWakeTimes,
  ].filter(Number.isFinite).sort((a, b) => a - b)[0];
  await chrome.alarms.clear('nika.scheduler');
  const when = typeof next === 'number' && Number.isFinite(next)
    ? Math.max(Date.now() + 1000, next)
    : Date.now() + SAFETY_WAKE_MINUTES * 60_000;
  await chrome.alarms.create('nika.scheduler', { when });
  await chrome.alarms.create('nika.scheduler.safety', { periodInMinutes: SAFETY_WAKE_MINUTES });
}

export async function reconcileSchedules(agents: ChatAgent[], now = new Date()): Promise<DurableJob[]> {
  await synchronizeSchedules(agents, now);
  await reclaimStaleLeases(now);
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const cursors = await db.scheduleCursors.toArray();
  const materialized: DurableJob[] = [];
  for (const cursor of cursors) {
    const agent = byId.get(cursor.agentId);
    if (!agent || !agent.enabled || !agent.schedule.enabled || !cursor.nextDueAt) continue;
    const due = Date.parse(cursor.nextDueAt);
    if (!Number.isFinite(due) || due > now.getTime()) continue;
    const occurrenceAt = latestOccurrenceAt(agent, due, now.getTime());
    const quarantine = await getActiveAgentQuarantine(agent.id, now);
    if (!quarantine) {
      const occurrenceKey = `${agent.id}:${new Date(occurrenceAt).toISOString()}`;
      if (!(await db.jobs.where('occurrenceKey').equals(occurrenceKey).first())) {
        const timestamp = now.toISOString();
        const job: DurableJob = {
          id: crypto.randomUUID(),
          occurrenceKey,
          agentId: agent.id,
          source: 'scheduled',
          dueAt: new Date(occurrenceAt).toISOString(),
          state: 'pending',
          attempt: 0,
          maxAttempts: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        await db.jobs.add(job);
        materialized.push(job);
      }
    }
    const next = nextOccurrenceAfter(agent, occurrenceAt, now.getTime());
    const nextCursor: ScheduleCursor = {
      agentId: agent.id,
      lastMaterializedAt: new Date(occurrenceAt).toISOString(),
      updatedAt: now.toISOString(),
    };
    if (next !== undefined) nextCursor.nextDueAt = new Date(next).toISOString();
    await db.scheduleCursors.put(nextCursor);
  }
  await rebuildWakeAlarm();
  return materialized;
}

export async function enqueueManualAgent(agentId: string, prompt?: string): Promise<DurableJob> {
  const timestamp = new Date().toISOString();
  const job: DurableJob = {
    id: crypto.randomUUID(),
    occurrenceKey: `manual:${crypto.randomUUID()}`,
    agentId,
    source: 'manual',
    dueAt: timestamp,
    state: 'pending',
    attempt: 0,
    maxAttempts: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  if (prompt !== undefined) job.prompt = prompt;
  await db.jobs.add(job);
  return job;
}

export async function claimNextDueJob(now = new Date()): Promise<DurableJob | undefined> {
  // A browser event can wake a fresh MV3 worker before startup/install reconciliation finishes.
  // Fence stale leases here too, so prior-worker ownership cannot block or race a new claim.
  await reclaimStaleLeases(now);
  const worker = crypto.randomUUID();
  return db.transaction('rw', db.jobs, async () => {
    const candidates = await db.jobs
      .where('state').equals('pending')
      .filter((candidate) => Date.parse(candidate.dueAt) <= now.getTime())
      .sortBy('dueAt');
    const job = candidates[0];
    if (!job) return undefined;
    const activeForAgent = await db.jobs.where('agentId').equals(job.agentId).filter((candidate) =>
      candidate.id !== job.id
      && (candidate.state === 'claimed' || candidate.state === 'running' || candidate.state === 'reconciling'),
    ).first();
    if (activeForAgent) return undefined;
    const leaseUntil = new Date(now.getTime() + LEASE_MS).toISOString();
    const updatedAt = now.toISOString();
    await db.jobs.update(job.id, {
      state: 'claimed',
      leaseOwner: worker,
      leaseBootId: RUNTIME_BOOT_ID,
      leaseUntil,
      updatedAt,
    });
    return {
      ...job,
      state: 'claimed',
      leaseOwner: worker,
      leaseBootId: RUNTIME_BOOT_ID,
      leaseUntil,
      updatedAt,
    };
  });
}

export async function getReconcilingJobs(): Promise<DurableJob[]> {
  return db.jobs.where('state').equals('reconciling').toArray();
}

export async function markJobRunning(job: DurableJob, runId: string): Promise<void> {
  await replaceJob(job.id, (current) => {
    current.state = 'running';
    current.runId = runId;
  });
}

export async function markJobReconciling(jobId: string, detail: string): Promise<void> {
  await replaceJob(jobId, (job) => {
    job.state = 'reconciling';
    clearLease(job);
    job.lastError = detail;
  });
}

export async function markJobPending(jobId: string, detail?: string): Promise<void> {
  await replaceJob(jobId, (job) => {
    job.state = 'pending';
    clearLease(job);
    if (detail === undefined) delete job.lastError;
    else job.lastError = detail;
  });
}

export async function deferJobUntil(jobId: string, dueAt: string, detail: string): Promise<void> {
  await replaceJob(jobId, (job) => {
    job.state = 'pending';
    job.dueAt = dueAt;
    clearLease(job);
    job.lastError = detail;
  });
}

export async function markJobNeedsReview(jobId: string, detail: string): Promise<void> {
  await replaceJob(jobId, (job) => {
    job.state = 'needs_review';
    clearLease(job);
    job.lastError = detail;
  });
}

export async function markJobSucceeded(jobId: string): Promise<void> {
  await replaceJob(jobId, (job) => {
    job.state = 'succeeded';
    clearLease(job);
  });
}

export async function markJobFailed(jobId: string, error: unknown): Promise<void> {
  await replaceJob(jobId, (job) => {
    job.state = 'failed';
    clearLease(job);
    job.lastError = error instanceof Error ? error.message : String(error);
  });
}

export async function reclaimStaleLeases(now = new Date()): Promise<number> {
  // Boot identity, not wall-clock TTL, is the fencing authority. A same-boot operation may
  // legitimately remain alive longer than LEASE_MS while ChatGPT is generating or the tab is
  // loading. Reclaiming it solely because its timestamp aged out could release ownership under
  // still-running code and permit a duplicate mutation. A new MV3 service-worker boot gets a
  // different RUNTIME_BOOT_ID, so prior-boot ownership is immediately identifiable without a
  // timeout. Legacy leases with no boot ID are intentionally treated as prior-boot ownership.
  const stale = await db.jobs.filter((job) =>
    (job.state === 'claimed' || job.state === 'running')
    && job.leaseBootId !== RUNTIME_BOOT_ID,
  ).toArray();

  for (const staleJob of stale) {
    await replaceJob(staleJob.id, (job) => {
      job.state = staleJob.state === 'running' ? 'reconciling' : 'pending';
      clearLease(job);
      if (staleJob.state === 'running') {
        job.lastError = 'Previous MV3 worker boot ended after execution started; reconciling persisted send intent before any retry.';
      } else {
        delete job.lastError;
      }
    }, now.toISOString());
  }
  return stale.length;
}

async function replaceJob(jobId: string, mutate: (job: DurableJob) => void, updatedAt = new Date().toISOString()): Promise<void> {
  const job = await db.jobs.get(jobId);
  if (!job) throw new Error(`JOB_MISSING: ${jobId}`);
  mutate(job);
  job.updatedAt = updatedAt;
  await db.jobs.put(job);
}

function clearLease(job: DurableJob): void {
  delete job.leaseOwner;
  delete job.leaseBootId;
  delete job.leaseUntil;
}

function initialDueAt(agent: ChatAgent, now: Date): string | undefined {
  if (agent.schedule.kind === 'once') {
    const at = Date.parse(agent.schedule.at);
    return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
  }
  if (agent.schedule.kind === 'interval') return new Date(now.getTime() + Math.max(1, agent.schedule.minutes) * 60_000).toISOString();
  return undefined;
}

function latestOccurrenceAt(agent: ChatAgent, firstDue: number, now: number): number {
  if (agent.schedule.kind !== 'interval') return firstDue;
  const interval = Math.max(1, agent.schedule.minutes) * 60_000;
  return firstDue + Math.floor(Math.max(0, now - firstDue) / interval) * interval;
}

function nextOccurrenceAfter(agent: ChatAgent, occurrence: number, now: number): number | undefined {
  if (agent.schedule.kind !== 'interval') return undefined;
  const interval = Math.max(1, agent.schedule.minutes) * 60_000;
  let next = occurrence + interval;
  while (next <= now) next += interval;
  return next;
}
