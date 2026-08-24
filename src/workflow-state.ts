import { db, type DurableWorkflowRun } from './db';
import type { RunSource } from './types';

export async function createWorkflowRun(workflowId: string, source: RunSource, runId = crypto.randomUUID()): Promise<DurableWorkflowRun> {
  const existing = await db.workflowRuns.get(runId);
  if (existing) return existing;
  const now = new Date().toISOString();
  const run: DurableWorkflowRun = {
    id: runId,
    workflowId,
    source,
    state: 'running',
    nextStepIndex: 0,
    createdAt: now,
    updatedAt: now,
  };
  await db.workflowRuns.add(run);
  return run;
}

export async function getWorkflowRun(runId: string): Promise<DurableWorkflowRun | undefined> {
  return db.workflowRuns.get(runId);
}

export async function getRecoverableWorkflowRuns(): Promise<DurableWorkflowRun[]> {
  return db.workflowRuns.where('state').equals('running').toArray();
}

export async function checkpointStepStarted(runId: string, stepId: string, resumeAt?: string): Promise<void> {
  await db.workflowRuns.update(runId, {
    currentStepId: stepId,
    resumeAt,
    updatedAt: new Date().toISOString(),
  });
}

export async function checkpointStepCompleted(runId: string, nextStepIndex: number): Promise<void> {
  await db.workflowRuns.update(runId, {
    nextStepIndex,
    currentStepId: undefined,
    resumeAt: undefined,
    lastError: undefined,
    updatedAt: new Date().toISOString(),
  });
}

export async function completeWorkflowRun(runId: string): Promise<void> {
  const now = new Date().toISOString();
  await db.workflowRuns.update(runId, { state: 'completed', completedAt: now, currentStepId: undefined, resumeAt: undefined, updatedAt: now });
}

export async function failWorkflowRun(runId: string, error: unknown, needsReview = false): Promise<void> {
  await db.workflowRuns.update(runId, {
    state: needsReview ? 'needs_review' : 'failed',
    lastError: error instanceof Error ? error.message : String(error),
    updatedAt: new Date().toISOString(),
  });
}

export async function putWorkflowOutput(runId: string, key: string, value: string): Promise<void> {
  const id = `${runId}:${key}`;
  await db.workflowOutputs.put({ id, runId, key, value, capturedAt: new Date().toISOString() });
}

export async function getWorkflowOutputs(runId: string): Promise<Map<string, string>> {
  const rows = await db.workflowOutputs.where('runId').equals(runId).toArray();
  return new Map(rows.map((row) => [row.key, row.value]));
}
