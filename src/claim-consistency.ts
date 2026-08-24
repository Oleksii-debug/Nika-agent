import {
  db,
  type ClaimAuditFinding,
  type DurableJob,
  type DurableTargetClaim,
  type DurableWorkflowRun,
  type SendIntent,
} from './db';
import { releaseTargetClaim, type TargetClaimOwner } from './target-claims';

export type ClaimAuditDisposition = 'healthy' | 'released' | 'quarantined';

export type ClaimAuditResult = {
  targetKey: string;
  ownerKind: DurableTargetClaim['ownerKind'];
  ownerId: string;
  operationId: string;
  disposition: ClaimAuditDisposition;
  reason: string;
};

export type ClaimAuditSummary = {
  checked: number;
  healthy: number;
  released: number;
  quarantined: number;
  results: ClaimAuditResult[];
};

export async function auditAndRepairTargetClaims(): Promise<ClaimAuditSummary> {
  const claims = await db.targetClaims.toArray();
  const results: ClaimAuditResult[] = [];
  for (const claim of claims) results.push(await inspectAndRepairClaim(claim));
  return {
    checked: results.length,
    healthy: results.filter((item) => item.disposition === 'healthy').length,
    released: results.filter((item) => item.disposition === 'released').length,
    quarantined: results.filter((item) => item.disposition === 'quarantined').length,
    results,
  };
}

export async function getOpenClaimAuditFindings(): Promise<ClaimAuditFinding[]> {
  return db.claimAuditFindings.where('state').equals('open').sortBy('updatedAt');
}

export async function resolveClaimAuditFinding(id: string): Promise<void> {
  const finding = await db.claimAuditFindings.get(id);
  if (!finding || finding.state === 'resolved') return;
  const resolvedAt = now();
  await db.claimAuditFindings.put({ ...finding, state: 'resolved', resolvedAt, updatedAt: resolvedAt });
}

async function inspectAndRepairClaim(claim: DurableTargetClaim): Promise<ClaimAuditResult> {
  if (claim.ownerKind === 'job') return inspectJobClaim(claim);
  return inspectWorkflowClaim(claim);
}

async function inspectJobClaim(claim: DurableTargetClaim): Promise<ClaimAuditResult> {
  const job = await db.jobs.get(claim.ownerId);
  const intent = await latestIntent(claim.operationId, claim.ownerId);
  const expectedOperationId = `job:${claim.ownerId}`;

  if (claim.operationId !== expectedOperationId) {
    return resolveInconsistentClaim(claim, intent, job, undefined,
      `Job claim operation mismatch: expected ${expectedOperationId}, found ${claim.operationId}.`);
  }

  if (!job) {
    return resolveInconsistentClaim(claim, intent, undefined, undefined,
      'Target claim references a job that no longer exists.');
  }

  if (job.state === 'needs_review') {
    return healthy(claim, 'Claim intentionally retained by a job awaiting operator review.');
  }

  if (job.state === 'claimed' || job.state === 'running' || job.state === 'reconciling') {
    return healthy(claim, `Claim matches active job state ${job.state}.`);
  }

  if (job.state === 'pending') {
    return resolveInconsistentClaim(claim, intent, job, undefined,
      'Pending job retained a mutating target claim outside active execution.');
  }

  return resolveInconsistentClaim(claim, intent, job, undefined,
    `Terminal job state ${job.state} retained a target claim.`);
}

async function inspectWorkflowClaim(claim: DurableTargetClaim): Promise<ClaimAuditResult> {
  const run = await db.workflowRuns.get(claim.ownerId);
  const intent = await latestIntent(claim.operationId);
  const prefix = `workflow:${claim.ownerId}:`;

  if (!claim.operationId.startsWith(prefix)) {
    return resolveInconsistentClaim(claim, intent, undefined, run,
      `Workflow claim operation mismatch: ${claim.operationId} does not belong to run ${claim.ownerId}.`);
  }

  if (!run) {
    return resolveInconsistentClaim(claim, intent, undefined, undefined,
      'Target claim references a workflow run that no longer exists.');
  }

  if (run.state === 'needs_review') {
    return healthy(claim, 'Claim intentionally retained by a workflow awaiting operator review.');
  }

  if (run.state === 'running') {
    const expected = run.currentStepId ? `workflow:${run.id}:${run.currentStepId}` : undefined;
    if (expected === claim.operationId) return healthy(claim, 'Claim matches the workflow current-step checkpoint.');
    return resolveInconsistentClaim(claim, intent, undefined, run,
      expected
        ? `Running workflow claim belongs to a stale step; current operation is ${expected}.`
        : 'Running workflow has no current-step checkpoint but still owns a target claim.');
  }

  return resolveInconsistentClaim(claim, intent, undefined, run,
    `Terminal workflow state ${run.state} retained a target claim.`);
}

async function resolveInconsistentClaim(
  claim: DurableTargetClaim,
  intent: SendIntent | undefined,
  job: DurableJob | undefined,
  run: DurableWorkflowRun | undefined,
  reason: string,
): Promise<ClaimAuditResult> {
  if (hasUnresolvedExternalEffect(intent)) {
    await quarantine(claim, intent, job, run, reason);
    return result(claim, 'quarantined', `${reason} External send effect remains ${intent?.state ?? 'unknown'}.`);
  }

  const owner: TargetClaimOwner = {
    ownerKind: claim.ownerKind,
    ownerId: claim.ownerId,
    operationId: claim.operationId,
  };
  const released = await releaseTargetClaim(claim.targetKey, owner);
  if (!released) {
    await quarantine(claim, intent, job, run, `${reason} Owner-checked release failed.`);
    return result(claim, 'quarantined', `${reason} Owner-checked release failed; claim retained.`);
  }

  await closeExistingFinding(claim.targetKey);
  return result(claim, 'released', `${reason} No unresolved external effect exists, so stale ownership was released.`);
}

async function quarantine(
  claim: DurableTargetClaim,
  intent: SendIntent | undefined,
  job: DurableJob | undefined,
  run: DurableWorkflowRun | undefined,
  reason: string,
): Promise<void> {
  const detail = `Claim consistency quarantine: ${reason}`;
  if (job && job.state !== 'needs_review') await replaceJobNeedsReview(job, detail);
  if (run && run.state !== 'needs_review') await replaceWorkflowNeedsReview(run, detail);

  const timestamp = now();
  const existing = await db.claimAuditFindings.get(claim.targetKey);
  const finding: ClaimAuditFinding = {
    id: claim.targetKey,
    targetKey: claim.targetKey,
    ownerKind: claim.ownerKind,
    ownerId: claim.ownerId,
    operationId: claim.operationId,
    reason,
    state: 'open',
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  if (intent) finding.intentState = intent.state;
  await db.claimAuditFindings.put(finding);
}

async function replaceJobNeedsReview(job: DurableJob, detail: string): Promise<void> {
  const replacement: DurableJob = { ...job, state: 'needs_review', lastError: detail, updatedAt: now() };
  delete replacement.leaseOwner;
  delete replacement.leaseUntil;
  await db.jobs.put(replacement);
}

async function replaceWorkflowNeedsReview(run: DurableWorkflowRun, detail: string): Promise<void> {
  const replacement: DurableWorkflowRun = { ...run, state: 'needs_review', lastError: detail, updatedAt: now() };
  await db.workflowRuns.put(replacement);
}

async function latestIntent(operationId: string, jobIdFallback?: string): Promise<SendIntent | undefined> {
  const exact = await db.sendIntents.where('jobId').equals(operationId).last();
  if (exact || !jobIdFallback) return exact;
  return db.sendIntents.where('jobId').equals(jobIdFallback).last();
}

function hasUnresolvedExternalEffect(intent?: SendIntent): boolean {
  return intent?.state === 'dispatching' || intent?.state === 'ambiguous';
}

async function closeExistingFinding(targetKey: string): Promise<void> {
  const finding = await db.claimAuditFindings.get(targetKey);
  if (!finding || finding.state === 'resolved') return;
  const resolvedAt = now();
  await db.claimAuditFindings.put({ ...finding, state: 'resolved', resolvedAt, updatedAt: resolvedAt });
}

function healthy(claim: DurableTargetClaim, reason: string): ClaimAuditResult {
  return result(claim, 'healthy', reason);
}

function result(claim: DurableTargetClaim, disposition: ClaimAuditDisposition, reason: string): ClaimAuditResult {
  return {
    targetKey: claim.targetKey,
    ownerKind: claim.ownerKind,
    ownerId: claim.ownerId,
    operationId: claim.operationId,
    disposition,
    reason,
  };
}

function now(): string { return new Date().toISOString(); }
