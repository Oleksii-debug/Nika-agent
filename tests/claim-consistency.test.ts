import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { auditAndRepairTargetClaims, getOpenClaimAuditFindings } from '../src/claim-consistency';
import { db, type DurableJob, type DurableWorkflowRun, type SendIntent } from '../src/db';

const now = '2026-08-24T06:00:00.000Z';

beforeEach(async () => {
  await db.open();
  await Promise.all([
    db.jobs.clear(),
    db.sendIntents.clear(),
    db.targetClaims.clear(),
    db.claimAuditFindings.clear(),
    db.workflowRuns.clear(),
    db.workflowOutputs.clear(),
    db.scheduleCursors.clear(),
  ]);
});

describe('target claim consistency audit', () => {
  it('auto-releases a stale terminal-job claim when no unresolved external effect exists', async () => {
    await putJob('job-terminal', 'succeeded');
    await putIntent('intent-terminal', 'job-terminal', 'confirmed');
    await putJobClaim('job-terminal', 'https://chatgpt.com/c/terminal');

    const summary = await auditAndRepairTargetClaims();

    expect(summary.released).toBe(1);
    expect(summary.quarantined).toBe(0);
    expect(await db.targetClaims.get('https://chatgpt.com/c/terminal')).toBeUndefined();
  });

  it('quarantines an orphan claim when an ambiguous external effect still exists', async () => {
    await putIntent('intent-orphan', 'job-orphan', 'ambiguous');
    await putJobClaim('job-orphan', 'https://chatgpt.com/c/orphan');

    const summary = await auditAndRepairTargetClaims();
    const [finding] = await getOpenClaimAuditFindings();

    expect(summary.quarantined).toBe(1);
    expect(await db.targetClaims.get('https://chatgpt.com/c/orphan')).toBeTruthy();
    expect(finding?.ownerId).toBe('job-orphan');
    expect(finding?.intentState).toBe('ambiguous');
  });

  it('moves a pending job to needs_review instead of freeing an unresolved send', async () => {
    await putJob('job-pending', 'pending');
    await putIntent('intent-pending', 'job-pending', 'dispatching');
    await putJobClaim('job-pending', 'https://chatgpt.com/c/pending');

    const summary = await auditAndRepairTargetClaims();

    expect(summary.quarantined).toBe(1);
    expect((await db.jobs.get('job-pending'))?.state).toBe('needs_review');
    expect(await db.targetClaims.get('https://chatgpt.com/c/pending')).toBeTruthy();
  });

  it('releases a stale previous-step workflow claim when its effect is already confirmed', async () => {
    const run = workflowRun('run-1', 'step-2');
    await db.workflowRuns.put(run);
    await putIntent('intent-workflow', 'workflow:run-1:step-1', 'confirmed');
    await db.targetClaims.put({
      targetKey: 'https://chatgpt.com/c/workflow',
      ownerKind: 'workflow',
      ownerId: 'run-1',
      operationId: 'workflow:run-1:step-1',
      acquiredAt: now,
      updatedAt: now,
    });

    const summary = await auditAndRepairTargetClaims();

    expect(summary.released).toBe(1);
    expect((await db.workflowRuns.get('run-1'))?.state).toBe('running');
    expect(await db.targetClaims.get('https://chatgpt.com/c/workflow')).toBeUndefined();
  });

  it('keeps a claim healthy when it matches the active workflow checkpoint', async () => {
    await db.workflowRuns.put(workflowRun('run-2', 'step-1'));
    await db.targetClaims.put({
      targetKey: 'https://chatgpt.com/c/healthy',
      ownerKind: 'workflow',
      ownerId: 'run-2',
      operationId: 'workflow:run-2:step-1',
      acquiredAt: now,
      updatedAt: now,
    });

    const summary = await auditAndRepairTargetClaims();

    expect(summary.healthy).toBe(1);
    expect(summary.released).toBe(0);
    expect(await db.targetClaims.get('https://chatgpt.com/c/healthy')).toBeTruthy();
  });
});

async function putJob(id: string, state: DurableJob['state']): Promise<void> {
  const job: DurableJob = {
    id,
    occurrenceKey: `manual:${id}`,
    agentId: `agent-${id}`,
    source: 'manual',
    dueAt: now,
    state,
    attempt: 1,
    maxAttempts: 2,
    createdAt: now,
    updatedAt: now,
  };
  await db.jobs.put(job);
}

async function putIntent(id: string, jobId: string, state: SendIntent['state']): Promise<void> {
  const intent: SendIntent = {
    id,
    jobId,
    agentId: 'agent',
    prompt: 'continue',
    promptHash: 'hash',
    baselineUserTurnCount: 1,
    state,
    createdAt: now,
    updatedAt: now,
  };
  await db.sendIntents.put(intent);
}

async function putJobClaim(jobId: string, targetKey: string): Promise<void> {
  await db.targetClaims.put({
    targetKey,
    ownerKind: 'job',
    ownerId: jobId,
    operationId: `job:${jobId}`,
    acquiredAt: now,
    updatedAt: now,
  });
}

function workflowRun(id: string, currentStepId: string): DurableWorkflowRun {
  return {
    id,
    workflowId: `workflow-${id}`,
    workflowRevision: 'revision',
    workflowSnapshot: {
      id: `workflow-${id}`,
      projectId: 'project',
      name: 'Test workflow',
      enabled: true,
      steps: [
        { id: 'step-1', type: 'send', agentId: 'agent-1', prompt: 'one' },
        { id: 'step-2', type: 'send', agentId: 'agent-1', prompt: 'two' },
      ],
    },
    source: 'workflow',
    state: 'running',
    nextStepIndex: currentStepId === 'step-1' ? 0 : 1,
    currentStepId,
    createdAt: now,
    updatedAt: now,
  };
}
