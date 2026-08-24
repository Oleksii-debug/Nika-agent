import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db';
import { acquireTargetClaim, getTargetClaim, releaseTargetClaim } from '../src/target-claims';

const jobOwner = { ownerKind: 'job' as const, ownerId: 'job-1', operationId: 'job:job-1' };
const workflowOwner = { ownerKind: 'workflow' as const, ownerId: 'run-1', operationId: 'step-1' };

describe('durable target claims', () => {
  beforeEach(async () => {
    await db.targetClaims.clear();
  });

  it('grants one mutating owner per target and blocks competing owners', async () => {
    expect(await acquireTargetClaim('agent-1', jobOwner)).toBe(true);
    expect(await acquireTargetClaim('agent-1', workflowOwner)).toBe(false);

    const persisted = await getTargetClaim('agent-1');
    expect(persisted?.ownerKind).toBe('job');
    expect(persisted?.ownerId).toBe('job-1');
  });

  it('allows idempotent reacquisition by the exact same operation after worker restart', async () => {
    expect(await acquireTargetClaim('agent-1', workflowOwner)).toBe(true);
    expect(await acquireTargetClaim('agent-1', workflowOwner)).toBe(true);
    expect((await db.targetClaims.toArray())).toHaveLength(1);
  });

  it('refuses release by a different owner', async () => {
    await acquireTargetClaim('agent-1', jobOwner);
    expect(await releaseTargetClaim('agent-1', workflowOwner)).toBe(false);
    expect(await getTargetClaim('agent-1')).toBeDefined();
  });

  it('releases only the exact owner and then permits the waiting owner', async () => {
    await acquireTargetClaim('agent-1', jobOwner);
    expect(await releaseTargetClaim('agent-1', jobOwner)).toBe(true);
    expect(await getTargetClaim('agent-1')).toBeUndefined();
    expect(await acquireTargetClaim('agent-1', workflowOwner)).toBe(true);
  });
});
