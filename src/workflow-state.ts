import { db, type DurableWorkflowRun, type WorkflowWaitKind } from './db';
import type { RunSource, WorkflowDefinition } from './types';

export const WORKFLOW_WAKE_PREFIX = 'nika.workflow.wake.';

export async function createWorkflowRun(
  workflow: WorkflowDefinition,
  source: RunSource,
  runId = crypto.randomUUID(),
): Promise<DurableWorkflowRun> {
  const existing = await db.workflowRuns.get(runId);
  if (existing) return existing;

  const workflowSnapshot = cloneWorkflow(workflow);
  const workflowRevision = await hashWorkflow(workflowSnapshot);
  const now = new Date().toISOString();
  const run: DurableWorkflowRun = {
    id: runId,
    workflowId: workflow.id,
    workflowRevision,
    workflowSnapshot,
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

export async function checkpointWorkflowWait(
  runId: string,
  waitKind: WorkflowWaitKind,
  wakeAt: string,
  waitDeadlineAt?: string,
): Promise<void> {
  await db.workflowRuns.update(runId, {
    waitKind,
    wakeAt,
    waitDeadlineAt,
    updatedAt: new Date().toISOString(),
  });
  await ensureWorkflowWakeAlarm(runId, wakeAt);
}

export async function clearWorkflowWait(runId: string): Promise<void> {
  await chrome.alarms.clear(workflowWakeAlarmName(runId));
  await db.workflowRuns.update(runId, {
    wakeAt: undefined,
    waitKind: undefined,
    waitDeadlineAt: undefined,
    updatedAt: new Date().toISOString(),
  });
}

export async function ensureWorkflowWakeAlarm(runId: string, wakeAt: string): Promise<void> {
  const when = Date.parse(wakeAt);
  if (!Number.isFinite(when)) throw new Error(`WORKFLOW_WAKE_INVALID: '${wakeAt}' is not a valid wake timestamp.`);
  await chrome.alarms.create(workflowWakeAlarmName(runId), { when: Math.max(Date.now() + 250, when) });
}

export function workflowWakeAlarmName(runId: string): string {
  return `${WORKFLOW_WAKE_PREFIX}${runId}`;
}

export function workflowRunIdFromAlarm(name: string): string | undefined {
  return name.startsWith(WORKFLOW_WAKE_PREFIX) ? name.slice(WORKFLOW_WAKE_PREFIX.length) : undefined;
}

export async function checkpointStepCompleted(runId: string, nextStepIndex: number): Promise<void> {
  await chrome.alarms.clear(workflowWakeAlarmName(runId));
  await db.workflowRuns.update(runId, {
    nextStepIndex,
    currentStepId: undefined,
    resumeAt: undefined,
    wakeAt: undefined,
    waitKind: undefined,
    waitDeadlineAt: undefined,
    lastError: undefined,
    updatedAt: new Date().toISOString(),
  });
}

export async function completeWorkflowRun(runId: string): Promise<void> {
  const now = new Date().toISOString();
  await chrome.alarms.clear(workflowWakeAlarmName(runId));
  await db.workflowRuns.update(runId, {
    state: 'completed',
    completedAt: now,
    currentStepId: undefined,
    resumeAt: undefined,
    wakeAt: undefined,
    waitKind: undefined,
    waitDeadlineAt: undefined,
    updatedAt: now,
  });
}

export async function failWorkflowRun(runId: string, error: unknown, needsReview = false): Promise<void> {
  await chrome.alarms.clear(workflowWakeAlarmName(runId));
  await db.workflowRuns.update(runId, {
    state: needsReview ? 'needs_review' : 'failed',
    wakeAt: undefined,
    waitKind: undefined,
    waitDeadlineAt: undefined,
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

export async function verifyWorkflowSnapshot(run: DurableWorkflowRun): Promise<boolean> {
  if (!run.workflowSnapshot || !run.workflowRevision || run.workflowRevision === 'legacy-unpinned') return false;
  return (await hashWorkflow(run.workflowSnapshot)) === run.workflowRevision;
}

export async function hashWorkflow(workflow: WorkflowDefinition): Promise<string> {
  const canonical = canonicalize(workflow);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function cloneWorkflow(workflow: WorkflowDefinition): WorkflowDefinition {
  return JSON.parse(JSON.stringify(workflow)) as WorkflowDefinition;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(',')}}`;
}
