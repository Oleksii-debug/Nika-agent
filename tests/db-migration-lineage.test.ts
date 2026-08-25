import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db';

const DB_NAME = 'nika-agent';

async function resetDatabase(): Promise<void> {
  db.close();
  await Dexie.delete(DB_NAME);
}

describe('IndexedDB migration lineage', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(async () => {
    await resetDatabase();
  });

  it('fails legacy running workflow runs closed when immutable snapshots did not exist', async () => {
    const legacy = new Dexie(DB_NAME);
    legacy.version(3).stores({
      jobs: '&id,&occurrenceKey,agentId,state,dueAt,leaseUntil,[state+dueAt]',
      scheduleCursors: '&agentId,nextDueAt',
      sendIntents: '&id,jobId,agentId,runId,state,createdAt,[jobId+state]',
      workflowRuns: '&id,workflowId,state,updatedAt,[workflowId+state]',
      workflowOutputs: '&id,[runId+key],runId,key,capturedAt',
    });
    await legacy.open();

    await legacy.table('workflowRuns').put({
      id: 'legacy-running-run',
      workflowId: 'workflow-legacy',
      source: 'manual',
      state: 'running',
      nextStepIndex: 1,
      currentStepId: 'step-2',
      createdAt: '2026-08-20T08:00:00.000Z',
      updatedAt: '2026-08-20T08:05:00.000Z',
    });
    legacy.close();

    await db.open();
    const migrated = await db.workflowRuns.get('legacy-running-run');

    expect(migrated).toBeDefined();
    expect(migrated?.state).toBe('needs_review');
    expect(migrated?.workflowRevision).toBe('legacy-unpinned');
    expect(migrated?.lastError).toContain('predates immutable definition pinning');
  });

  it('preserves terminal legacy workflow runs while marking their revision lineage explicitly', async () => {
    const legacy = new Dexie(DB_NAME);
    legacy.version(3).stores({
      jobs: '&id,&occurrenceKey,agentId,state,dueAt,leaseUntil,[state+dueAt]',
      scheduleCursors: '&agentId,nextDueAt',
      sendIntents: '&id,jobId,agentId,runId,state,createdAt,[jobId+state]',
      workflowRuns: '&id,workflowId,state,updatedAt,[workflowId+state]',
      workflowOutputs: '&id,[runId+key],runId,key,capturedAt',
    });
    await legacy.open();

    await legacy.table('workflowRuns').put({
      id: 'legacy-completed-run',
      workflowId: 'workflow-legacy',
      source: 'manual',
      state: 'completed',
      nextStepIndex: 2,
      createdAt: '2026-08-20T08:00:00.000Z',
      updatedAt: '2026-08-20T08:05:00.000Z',
      completedAt: '2026-08-20T08:05:00.000Z',
    });
    legacy.close();

    await db.open();
    const migrated = await db.workflowRuns.get('legacy-completed-run');

    expect(migrated).toBeDefined();
    expect(migrated?.state).toBe('completed');
    expect(migrated?.workflowRevision).toBe('legacy-unpinned');
    expect(migrated?.lastError).toContain('predates immutable definition pinning');
  });
});
