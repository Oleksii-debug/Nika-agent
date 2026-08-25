import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, type DurableJob } from '../src/db';
import { claimNextDueJob, getRuntimeBootId, reclaimStaleLeases } from '../src/scheduler';

const NOW = new Date('2026-08-25T10:00:00.000Z');
const FUTURE = new Date(NOW.getTime() + 60_000).toISOString();

function job(id: string, overrides: Omit<Partial<DurableJob>, 'id'> = {}): DurableJob {
  return {
    id,
    occurrenceKey: `test:${id}`,
    agentId: 'agent-a',
    source: 'manual',
    dueAt: NOW.toISOString(),
    state: 'pending',
    attempt: 0,
    maxAttempts: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

describe('MV3 worker-boot fenced job leases', () => {
  beforeEach(async () => {
    await db.jobs.clear();
  });

  it('keeps a live current-boot running lease and blocks another job for the same agent', async () => {
    await db.jobs.bulkPut([
      job('running-current', {
        state: 'running',
        leaseOwner: 'worker-a',
        leaseBootId: getRuntimeBootId(),
        leaseUntil: FUTURE,
        runId: 'run-a',
      }),
      job('pending-same-agent'),
    ]);

    expect(await claimNextDueJob(NOW)).toBeUndefined();
    expect(await db.jobs.get('running-current')).toMatchObject({
      state: 'running',
      leaseBootId: getRuntimeBootId(),
      leaseUntil: FUTURE,
    });
  });

  it('immediately quarantines a prior-boot running lease for reconciliation even before TTL expiry', async () => {
    await db.jobs.bulkPut([
      job('running-prior', {
        state: 'running',
        leaseOwner: 'old-worker',
        leaseBootId: 'prior-boot',
        leaseUntil: FUTURE,
        runId: 'run-prior',
      }),
      job('pending-same-agent'),
    ]);

    expect(await claimNextDueJob(NOW)).toBeUndefined();
    const recovered = await db.jobs.get('running-prior');
    expect(recovered).toMatchObject({ state: 'reconciling', runId: 'run-prior' });
    expect(recovered?.lastError).toContain('Previous MV3 worker boot ended after execution started');
    expect(recovered?.leaseOwner).toBeUndefined();
    expect(recovered?.leaseBootId).toBeUndefined();
    expect(recovered?.leaseUntil).toBeUndefined();
    expect((await db.jobs.get('pending-same-agent'))?.state).toBe('pending');
  });

  it('safely reclaims a prior-boot claimed job because external execution had not started', async () => {
    await db.jobs.put(job('claimed-prior', {
      state: 'claimed',
      leaseOwner: 'old-worker',
      leaseBootId: 'prior-boot',
      leaseUntil: FUTURE,
    }));

    const claimed = await claimNextDueJob(NOW);
    expect(claimed).toMatchObject({
      id: 'claimed-prior',
      state: 'claimed',
      leaseBootId: getRuntimeBootId(),
    });
    expect(claimed?.leaseOwner).toBeTruthy();
    expect(claimed?.leaseOwner).not.toBe('old-worker');
  });

  it('treats legacy running leases without boot identity as prior-worker ownership', async () => {
    await db.jobs.put(job('legacy-running', {
      state: 'running',
      leaseOwner: 'legacy-worker',
      leaseUntil: FUTURE,
      runId: 'legacy-run',
    }));

    expect(await reclaimStaleLeases(NOW)).toBe(1);
    const recovered = await db.jobs.get('legacy-running');
    expect(recovered).toMatchObject({ state: 'reconciling', runId: 'legacy-run' });
    expect(recovered?.leaseOwner).toBeUndefined();
    expect(recovered?.leaseBootId).toBeUndefined();
    expect(recovered?.leaseUntil).toBeUndefined();
  });
});
