import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db';
import { acquireTargetClaim, getTargetClaim, releaseTargetClaim } from '../src/target-claims';

const target = 'https://chatgpt.com/c/example-chat';
const targetAlias = 'https://chatgpt.com/c/example-chat/?utm_source=test#fragment';
const jobOwner = { ownerKind: 'job' as const, ownerId: 'job-1', operationId: 'job:job-1' };
const workflowOwner = { ownerKind: 'workflow' as const, ownerId: 'run-1', operationId: 'workflow:run-1:step-1' };

describe('durable target claims', () => {
  beforeEach(async () => {
    await db.targetClaims.clear();
  });

  it('grants one mutating owner per physical chat and blocks URL aliases', async () => {
    expect(await acquireTargetClaim(target, jobOwner)).toBe(true);
    expect(await acquireTargetClaim(targetAlias, workflowOwner)).toBe(false);

    const persisted = await getTargetClaim(targetAlias);
    expect(persisted?.ownerKind).toBe('job');
    expect(persisted?.ownerId).toBe('job-1');
  });

  it('allows idempotent reacquisition by the exact same operation after worker restart', async () => {
    expect(await acquireTargetClaim(target, workflowOwner)).toBe(true);
    expect(await acquireTargetClaim(targetAlias, workflowOwner)).toBe(true);
    expect((await db.targetClaims.toArray())).toHaveLength(1);
  });

  it('refuses release by a different owner', async () => {
    await acquireTargetClaim(target, jobOwner);
    expect(await releaseTargetClaim(targetAlias, workflowOwner)).toBe(false);
    expect(await getTargetClaim(target)).toBeDefined();
  });

  it('releases only the exact owner and then permits the waiting owner', async () => {
    await acquireTargetClaim(target, jobOwner);
    expect(await releaseTargetClaim(targetAlias, jobOwner)).toBe(true);
    expect(await getTargetClaim(target)).toBeUndefined();
    expect(await acquireTargetClaim(target, workflowOwner)).toBe(true);
  });
});
