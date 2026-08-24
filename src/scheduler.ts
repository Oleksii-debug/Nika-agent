import { db, type DurableJob } from './db';
import type { ChatAgent } from './types';

const LEASE_MS = 2 * 60_000;
const SAFETY_WAKE_MINUTES = 1;

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
  const next = cursors.map((cursor) => cursor.nextDueAt ? Date.parse(cursor.nextDueAt) : Number.POSITIVE_INFINITY).filter(Number.isFinite).sort((a, b) => a - b)[0];
  await chrome.alarms.clear('nika.scheduler');
  const when = Number.isFinite(next) ? Math.max(Date.now() + 1000, next) : Date.now() + SAFETY_WAKE_MINUTES * 60_000;
  await chrome.alarms.create('nika.scheduler', { when });
  await chrome.alarms.create('nika.scheduler.safety', { periodInMinutes: SAFETY_WAKE_MINUTES });
}

export async function reconcileSchedules(agents: ChatAgent[], now = new Date()): Promise<DurableJob[]> {
  await synchronizeSchedules(agents, now);
  await reclaimExpiredLeases(now);
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const cursors = await db.scheduleCursors.toArray();
  const materialized: DurableJob[] = [];
  for (const cursor of cursors) {
    const agent = byId.get(cursor.agentId);
    if (!agent || !agent.enabled || !agent.schedule.enabled || !cursor.nextDueAt) continue;
    const due = Date.parse(cursor.nextDueAt);
    if (!Number.isFinite(due) || due > now.getTime()) continue;
    const occurrenceAt = latestOccurrenceAt(agent, due, now.getTime());
    const occurrenceKey = `${agent.id}:${new Date(occurrenceAt).toISOString()}`;
    if (!(await db.jobs.where('occurrenceKey').equals(occurrenceKey).first())) {
      const timestamp = now.toISOString();
      const job: DurableJob = { id: crypto.randomUUID(), occurrenceKey, agentId: agent.id, source: 'scheduled', dueAt: new Date(occurrenceAt).toISOString(), state: 'pending', attempt: 0, maxAttempts: 1, createdAt: timestamp, updatedAt: timestamp };
      await db.jobs.add(job);
      materialized.push(job);
    }
    const next = nextOccurrenceAfter(agent, occurrenceAt, now.getTime());
    await db.scheduleCursors.put({ agentId: agent.id, nextDueAt: next ? new Date(next).toISOString() : undefined, lastMaterializedAt: new Date(occurrenceAt).toISOString(), updatedAt: now.toISOString() });
  }
  await rebuildWakeAlarm();
  return materialized;
}

export async function enqueueManualAgent(agentId: string, prompt?: string): Promise<DurableJob> {
  const now = new Date().toISOString();
  const job: DurableJob = { id: crypto.randomUUID(), occurrenceKey: `manual:${crypto.randomUUID()}`, agentId, prompt, source: 'manual', dueAt: now, state: 'pending', attempt: 0, maxAttempts: 1, createdAt: now, updatedAt: now };
  await db.jobs.add(job);
  return job;
}

export async function claimNextDueJob(now = new Date()): Promise<DurableJob | undefined> {
  const worker = crypto.randomUUID();
  return db.transaction('rw', db.jobs, async () => {
    const candidates = await db.jobs.where('state').equals('pending').filter((candidate) => Date.parse(candidate.dueAt) <= now.getTime()).sortBy('dueAt');
    const job = candidates[0];
    if (!job) return undefined;
    const activeForAgent = await db.jobs.where('agentId').equals(job.agentId).filter((candidate) => candidate.id !== job.id && (candidate.state === 'claimed' || candidate.state === 'running' || candidate.state === 'reconciling') && (!candidate.leaseUntil || Date.parse(candidate.leaseUntil) > now.getTime())).first();
    if (activeForAgent) return undefined;
    const leaseUntil = new Date(now.getTime() + LEASE_MS).toISOString();
    await db.jobs.update(job.id, { state: 'claimed', leaseOwner: worker, leaseUntil, updatedAt: now.toISOString() });
    return { ...job, state: 'claimed', leaseOwner: worker, leaseUntil, updatedAt: now.toISOString() };
  });
}

export async function getReconcilingJobs(): Promise<DurableJob[]> { return db.jobs.where('state').equals('reconciling').toArray(); }

export async function markJobRunning(job: DurableJob, runId: string): Promise<void> {
  await db.jobs.update(job.id, { state: 'running', runId, updatedAt: new Date().toISOString() });
}

export async function markJobReconciling(jobId: string, detail: string): Promise<void> {
  await db.jobs.update(jobId, { state: 'reconciling', leaseOwner: undefined, leaseUntil: undefined, lastError: detail, updatedAt: new Date().toISOString() });
}

export async function markJobPending(jobId: string, detail?: string): Promise<void> {
  await db.jobs.update(jobId, { state: 'pending', leaseOwner: undefined, leaseUntil: undefined, lastError: detail, updatedAt: new Date().toISOString() });
}

export async function markJobNeedsReview(jobId: string, detail: string): Promise<void> {
  await db.jobs.update(jobId, { state: 'needs_review', leaseOwner: undefined, leaseUntil: undefined, lastError: detail, updatedAt: new Date().toISOString() });
}

export async function markJobSucceeded(jobId: string): Promise<void> {
  await db.jobs.update(jobId, { state: 'succeeded', leaseOwner: undefined, leaseUntil: undefined, updatedAt: new Date().toISOString() });
}

export async function markJobFailed(jobId: string, error: unknown): Promise<void> {
  await db.jobs.update(jobId, { state: 'failed', leaseOwner: undefined, leaseUntil: undefined, lastError: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() });
}

async function reclaimExpiredLeases(now: Date): Promise<void> {
  const leased = await db.jobs.filter((job) => (job.state === 'claimed' || job.state === 'running') && !!job.leaseUntil && Date.parse(job.leaseUntil) <= now.getTime()).toArray();
  for (const job of leased) {
    await db.jobs.update(job.id, { state: job.state === 'running' ? 'reconciling' : 'pending', leaseOwner: undefined, leaseUntil: undefined, updatedAt: now.toISOString(), lastError: job.state === 'running' ? 'Worker lease expired after execution started; reconciling persisted send intent before retry.' : job.lastError });
  }
}

function initialDueAt(agent: ChatAgent, now: Date): string | undefined {
  if (agent.schedule.kind === 'once') { const at = Date.parse(agent.schedule.at); return Number.isFinite(at) ? new Date(at).toISOString() : undefined; }
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
