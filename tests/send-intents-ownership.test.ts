import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db';
import {
  getOrCreateSendIntent,
  SendIntentOwnershipError,
} from '../src/send-intents';

describe('durable send intent ownership', () => {
  beforeEach(async () => {
    await db.sendIntents.clear();
  });

  it('reuses the exact same durable intent after worker restart', async () => {
    const first = await getOrCreateSendIntent({
      jobId: 'job-1',
      agentId: 'agent-a',
      runId: 'run-1',
      prompt: 'Continue the production task.',
      baselineUserTurnCount: 7,
    });

    const resumed = await getOrCreateSendIntent({
      jobId: 'job-1',
      agentId: 'agent-a',
      runId: 'run-1',
      prompt: 'Continue   the production task.',
      baselineUserTurnCount: 99,
    });

    expect(resumed.id).toBe(first.id);
    expect(resumed.baselineUserTurnCount).toBe(7);
    expect(await db.sendIntents.where('jobId').equals('job-1').count()).toBe(1);
  });

  it('fails closed when a persisted job intent is rebound to another agent', async () => {
    await getOrCreateSendIntent({
      jobId: 'job-2',
      agentId: 'agent-a',
      runId: 'run-2',
      prompt: 'Do not duplicate this send.',
      baselineUserTurnCount: 3,
    });

    await expect(getOrCreateSendIntent({
      jobId: 'job-2',
      agentId: 'agent-b',
      runId: 'run-2',
      prompt: 'Do not duplicate this send.',
      baselineUserTurnCount: 3,
    })).rejects.toBeInstanceOf(SendIntentOwnershipError);
  });

  it('fails closed when the prompt changes for the same durable operation key', async () => {
    await getOrCreateSendIntent({
      jobId: 'workflow:run-3:step-send',
      agentId: 'agent-a',
      runId: 'run-3',
      prompt: 'Pinned prompt A',
      baselineUserTurnCount: 4,
    });

    await expect(getOrCreateSendIntent({
      jobId: 'workflow:run-3:step-send',
      agentId: 'agent-a',
      runId: 'run-3',
      prompt: 'Pinned prompt B',
      baselineUserTurnCount: 4,
    })).rejects.toThrow('SEND_INTENT_OWNERSHIP_MISMATCH');
  });

  it('fails closed when a persisted operation key is attached to another run', async () => {
    await getOrCreateSendIntent({
      jobId: 'job-4',
      agentId: 'agent-a',
      runId: 'run-original',
      prompt: 'Stable payload',
      baselineUserTurnCount: 5,
    });

    await expect(getOrCreateSendIntent({
      jobId: 'job-4',
      agentId: 'agent-a',
      runId: 'run-replacement',
      prompt: 'Stable payload',
      baselineUserTurnCount: 5,
    })).rejects.toThrow("run changed from 'run-original' to 'run-replacement'");
  });

  it('serializes concurrent creation for one durable job key', async () => {
    const input = {
      jobId: 'job-race',
      agentId: 'agent-a',
      runId: 'run-race',
      prompt: 'One irreversible operation',
      baselineUserTurnCount: 1,
    };

    const [left, right] = await Promise.all([
      getOrCreateSendIntent(input),
      getOrCreateSendIntent(input),
    ]);

    expect(left.id).toBe(right.id);
    expect(await db.sendIntents.where('jobId').equals('job-race').count()).toBe(1);
  });
});
