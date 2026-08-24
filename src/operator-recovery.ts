import { db, type DurableJob, type DurableTargetClaim, type DurableWorkflowRun, type SendIntent } from './db';
import { releaseTargetClaim, type TargetClaimOwner } from './target-claims';

export type RecoverySubjectKind = 'job' | 'workflow';
export type RecoveryAction = 'mark_confirmed' | 'mark_absent_retry' | 'cancel' | 'release_if_safe';

export type RecoveryCase = {
  kind: RecoverySubjectKind;
  id: string;
  state: string;
  title: string;
  detail?: string;
  agentId?: string;
  workflowId?: string;
  currentStepId?: string;
  intent?: SendIntent;
  claims: DurableTargetClaim[];
  allowedActions: RecoveryAction[];
  blockers: string[];
};

export async function listRecoveryCases(): Promise<RecoveryCase[]> {
  const [jobs, workflows] = await Promise.all([
    db.jobs.where('state').equals('needs_review').toArray(),
    db.workflowRuns.where('state').equals('needs_review').toArray(),
  ]);
  const cases: RecoveryCase[] = [];
  for (const job of jobs) cases.push(await jobRecoveryCase(job));
  for (const run of workflows) cases.push(await workflowRecoveryCase(run));
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

export async function recoverSubject(kind: RecoverySubjectKind, id: string, action: RecoveryAction): Promise<void> {
  if (kind === 'job') return recoverJob(id, action);
  return recoverWorkflow(id, action);
}

async function jobRecoveryCase(job: DurableJob): Promise<RecoveryCase> {
  const intent = await db.sendIntents.where('jobId').equals(job.id).last();
  const claims = await db.targetClaims.where('[ownerKind+ownerId]').equals(['job', job.id]).toArray();
  const blockers: string[] = [];
  const actions: RecoveryAction[] = [];

  if (intent?.state === 'confirmed') actions.push('mark_confirmed');
  if (intent?.state === 'absent' || intent?.state === 'persisted') actions.push('mark_absent_retry');
  if (isSafeToRelease(intent)) {
    actions.push('cancel', 'release_if_safe');
  } else {
    blockers.push('External send effect is unresolved; target ownership must remain until transcript reconciliation or explicit confirmation.');
  }

  return {
    kind: 'job', id: job.id, state: job.state, title: `Job ${job.id}`, detail: job.lastError,
    agentId: job.agentId, intent, claims, allowedActions: unique(actions), blockers,
  };
}

async function workflowRecoveryCase(run: DurableWorkflowRun): Promise<RecoveryCase> {
  const claims = await db.targetClaims.where('[ownerKind+ownerId]').equals(['workflow', run.id]).toArray();
  const step = run.currentStepId;
  const intent = step ? await db.sendIntents.where('jobId').equals(`workflow:${run.id}:${step}`).last() : undefined;
  const blockers: string[] = [];
  const actions: RecoveryAction[] = [];

  if (intent?.state === 'confirmed') actions.push('mark_confirmed');
  if (intent?.state === 'absent' || intent?.state === 'persisted') actions.push('mark_absent_retry');
  if (isSafeToRelease(intent)) {
    actions.push('cancel', 'release_if_safe');
  } else {
    blockers.push('Workflow send effect is unresolved; automatic release is prohibited.');
  }
  if (!run.currentStepId) blockers.push('Workflow has no current step checkpoint; operator must inspect the run before resuming.');

  return {
    kind: 'workflow', id: run.id, state: run.state, title: `Workflow ${run.workflowId}`,
    detail: run.lastError, workflowId: run.workflowId, currentStepId: run.currentStepId,
    intent, claims, allowedActions: unique(actions), blockers,
  };
}

async function recoverJob(jobId: string, action: RecoveryAction): Promise<void> {
  const job = await db.jobs.get(jobId);
  if (!job || job.state !== 'needs_review') throw new Error('RECOVERY_INVALID_STATE: job is not awaiting review.');
  const intent = await db.sendIntents.where('jobId').equals(job.id).last();
  const owner = jobOwner(job.id);

  switch (action) {
    case 'mark_confirmed':
      requireIntentState(intent, ['confirmed']);
      await replaceJobState(job, 'succeeded');
      await releaseAllOwnedClaims('job', job.id, owner);
      return;
    case 'mark_absent_retry':
      requireIntentState(intent, ['persisted', 'absent']);
      await replaceJobState(job, 'pending', 'Operator verified no external effect; safe retry permitted.');
      await releaseAllOwnedClaims('job', job.id, owner);
      return;
    case 'cancel':
      if (!isSafeToRelease(intent)) throw new Error('RECOVERY_UNSAFE_CANCEL: unresolved dispatch cannot release target ownership. Mark confirmed/absent only after evidence is established.');
      await replaceJobState(job, 'cancelled');
      await releaseAllOwnedClaims('job', job.id, owner);
      return;
    case 'release_if_safe':
      if (!isSafeToRelease(intent)) throw new Error('RECOVERY_UNSAFE_RELEASE: send intent is dispatching or ambiguous.');
      await releaseAllOwnedClaims('job', job.id, owner);
      return;
  }
}

async function recoverWorkflow(runId: string, action: RecoveryAction): Promise<void> {
  const run = await db.workflowRuns.get(runId);
  if (!run || run.state !== 'needs_review') throw new Error('RECOVERY_INVALID_STATE: workflow is not awaiting review.');
  const intent = run.currentStepId ? await db.sendIntents.where('jobId').equals(`workflow:${run.id}:${run.currentStepId}`).last() : undefined;
  const owner: TargetClaimOwner | undefined = run.currentStepId
    ? { ownerKind: 'workflow', ownerId: run.id, operationId: `workflow:${run.id}:${run.currentStepId}` }
    : undefined;

  switch (action) {
    case 'mark_confirmed':
      requireIntentState(intent, ['confirmed']);
      await replaceWorkflowState(run, 'running');
      if (owner) await releaseAllOwnedClaims('workflow', run.id, owner);
      return;
    case 'mark_absent_retry':
      requireIntentState(intent, ['persisted', 'absent']);
      await replaceWorkflowState(run, 'running', 'Operator verified no external effect; current step may retry.');
      if (owner) await releaseAllOwnedClaims('workflow', run.id, owner);
      return;
    case 'cancel':
      if (!isSafeToRelease(intent)) throw new Error('RECOVERY_UNSAFE_CANCEL: unresolved workflow send cannot release target ownership.');
      await replaceWorkflowState(run, 'failed', 'Cancelled by operator during recovery.');
      if (owner) await releaseAllOwnedClaims('workflow', run.id, owner);
      return;
    case 'release_if_safe':
      if (!isSafeToRelease(intent)) throw new Error('RECOVERY_UNSAFE_RELEASE: workflow send intent is dispatching or ambiguous.');
      if (owner) await releaseAllOwnedClaims('workflow', run.id, owner);
      return;
  }
}

function isSafeToRelease(intent?: SendIntent): boolean {
  return !intent || intent.state === 'persisted' || intent.state === 'absent' || intent.state === 'confirmed';
}

function requireIntentState(intent: SendIntent | undefined, states: SendIntent['state'][]): asserts intent is SendIntent {
  if (!intent || !states.includes(intent.state)) throw new Error(`RECOVERY_EVIDENCE_REQUIRED: expected intent state ${states.join(' or ')}.`);
}

async function replaceJobState(job: DurableJob, state: DurableJob['state'], lastError?: string): Promise<void> {
  const replacement: DurableJob = { ...job, state, updatedAt: now() };
  delete replacement.leaseOwner;
  delete replacement.leaseUntil;
  if (lastError === undefined) delete replacement.lastError;
  else replacement.lastError = lastError;
  await db.jobs.put(replacement);
}

async function replaceWorkflowState(run: DurableWorkflowRun, state: DurableWorkflowRun['state'], lastError?: string): Promise<void> {
  const replacement: DurableWorkflowRun = { ...run, state, updatedAt: now() };
  if (lastError === undefined) delete replacement.lastError;
  else replacement.lastError = lastError;
  await db.workflowRuns.put(replacement);
}

async function releaseAllOwnedClaims(kind: 'job' | 'workflow', ownerId: string, owner: TargetClaimOwner): Promise<void> {
  const claims = await db.targetClaims.where('[ownerKind+ownerId]').equals([kind, ownerId]).toArray();
  for (const claim of claims) await releaseTargetClaim(claim.targetKey, owner);
}

function jobOwner(jobId: string): TargetClaimOwner {
  return { ownerKind: 'job', ownerId: jobId, operationId: `job:${jobId}` };
}

function unique<T>(items: T[]): T[] { return [...new Set(items)]; }
function now(): string { return new Date().toISOString(); }
