import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, type DurableJob, type SendIntent } from '../src/db';
import { listRecoveryCases, recoverSubject } from '../src/operator-recovery';

const now = '2026-08-24T05:00:00.000Z';

beforeEach(async () => {
  await db.open();
  await Promise.all([
    db.jobs.clear(),
    db.sendIntents.clear(),
    db.targetClaims.clear(),
    db.workflowRuns.clear(),
    db.workflowOutputs.clear(),
    db.scheduleCursors.clear(),
  ]);
});

describe('operator recovery', () => {
  it('does not expose or permit releasing/cancelling an ambiguous external send', async () => {
    await putJob('job-1');
    await putIntent('intent-1', 'job-1', 'ambiguous');
    await db.targetClaims.put({
      targetKey: 'https://chatgpt.com/c/abc', ownerKind: 'job', ownerId: 'job-1', operationId: 'job:job-1', acquiredAt: now, updatedAt: now,
    });

    const recovery = (await listRecoveryCases())[0];
    if (!recovery) throw new Error('Expected an operator recovery case.');
    expect(recovery.blockers.length).toBeGreaterThan(0);
    expect(recovery.allowedActions).not.toContain('release_if_safe');
    expect(recovery.allowedActions).not.toContain('cancel');
    await expect(recoverSubject('job', 'job-1', 'release_if_safe')).rejects.toThrow('RECOVERY_UNSAFE_RELEASE');
    await expect(recoverSubject('job', 'job-1', 'cancel')).rejects.toThrow('RECOVERY_UNSAFE_CANCEL');
    expect(await db.targetClaims.get('https://chatgpt.com/c/abc')).toBeTruthy();
  });

  it('retains the physical-target claim for an unresolved send across a worker-style database restart', async () => {
    await putJob('job-restart');
    await putIntent('intent-restart', 'job-restart', 'dispatching');
    const targetKey = 'https://chatgpt.com/c/restart-ambiguous';
    await db.targetClaims.put({
      targetKey, ownerKind: 'job', ownerId: 'job-restart', operationId: 'job:job-restart', acquiredAt: now, updatedAt: now,
    });

    db.close();
    await db.open();

    const persistedClaim = await db.targetClaims.get(targetKey);
    expect(persistedClaim?.ownerId).toBe('job-restart');
    expect(persistedClaim?.operationId).toBe('job:job-restart');

    const recovery = (await listRecoveryCases()).find((item) => item.id === 'job-restart');
    if (!recovery) throw new Error('Expected the unresolved restarted job to remain an operator recovery case.');
    expect(recovery.allowedActions).not.toContain('release_if_safe');
    expect(recovery.allowedActions).not.toContain('cancel');
    await expect(recoverSubject('job', 'job-restart', 'release_if_safe')).rejects.toThrow('RECOVERY_UNSAFE_RELEASE');
    expect(await db.targetClaims.get(targetKey)).toBeTruthy();
  });

  it('marks a confirmed job succeeded and releases its owned target', async () => {
    await putJob('job-2');
    await putIntent('intent-2', 'job-2', 'confirmed');
    await db.targetClaims.put({
      targetKey: 'https://chatgpt.com/c/confirmed', ownerKind: 'job', ownerId: 'job-2', operationId: 'job:job-2', acquiredAt: now, updatedAt: now,
    });

    await recoverSubject('job', 'job-2', 'mark_confirmed');
    expect((await db.jobs.get('job-2'))?.state).toBe('succeeded');
    expect(await db.targetClaims.get('https://chatgpt.com/c/confirmed')).toBeUndefined();
  });

  it('returns a proven-absent job to pending and releases ownership', async () => {
    await putJob('job-3');
    await putIntent('intent-3', 'job-3', 'absent');
    await db.targetClaims.put({
      targetKey: 'https://chatgpt.com/c/absent', ownerKind: 'job', ownerId: 'job-3', operationId: 'job:job-3', acquiredAt: now, updatedAt: now,
    });

    await recoverSubject('job', 'job-3', 'mark_absent_retry');
    const recovered = await db.jobs.get('job-3');
    expect(recovered?.state).toBe('pending');
    expect(recovered?.leaseOwner).toBeUndefined();
    expect(recovered?.leaseUntil).toBeUndefined();
    expect(await db.targetClaims.get('https://chatgpt.com/c/absent')).toBeUndefined();
  });

  it('refuses cancellation when dispatch evidence is unresolved', async () => {
    await putJob('job-4');
    await putIntent('intent-4', 'job-4', 'dispatching');
    await expect(recoverSubject('job', 'job-4', 'cancel')).rejects.toThrow('RECOVERY_UNSAFE_CANCEL');
    expect((await db.jobs.get('job-4'))?.state).toBe('needs_review');
  });
});

async function putJob(id: string): Promise<void> {
  const job: DurableJob = {
    id, occurrenceKey: `manual:${id}`, agentId: `agent-${id}`, source: 'manual', dueAt: now,
    state: 'needs_review', attempt: 1, maxAttempts: 1, lastError: 'Needs operator review', createdAt: now, updatedAt: now,
  };
  await db.jobs.put(job);
}

async function putIntent(id: string, jobId: string, state: SendIntent['state']): Promise<void> {
  const intent: SendIntent = {
    id, jobId, agentId: `agent-${jobId}`, prompt: 'continue', promptHash: 'hash', baselineUserTurnCount: 1,
    state, createdAt: now, updatedAt: now,
  };
  await db.sendIntents.put(intent);
}
