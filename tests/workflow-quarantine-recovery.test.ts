import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearAgentQuarantine } from '../src/chat-quarantine';
import { db, type DurableWorkflowRun } from '../src/db';
import {
  listClearedQuarantineWorkflowWaiters,
  listQuarantineWorkflowWaiters,
  quarantineWorkflowTargetAgentId,
  quarantineWorkflowWaitsOnAgent,
} from '../src/workflow-quarantine-recovery';
import type { WorkflowDefinition } from '../src/types';

function workflow(id: string, agentId: string): WorkflowDefinition {
  return {
    id,
    projectId: 'default',
    name: id,
    enabled: true,
    steps: [
      { id: 'send-1', type: 'send', agentId, prompt: 'Continue' },
      { id: 'wait-1', type: 'wait_idle', agentId, timeoutMs: 60_000 },
    ],
  };
}

function run(overrides: Partial<DurableWorkflowRun> & Pick<DurableWorkflowRun, 'id'>): DurableWorkflowRun {
  const { id, ...rest } = overrides;
  const snapshot = workflow(`wf-${id}`, 'agent-a');
  return {
    id,
    workflowId: snapshot.id,
    workflowRevision: 'test-revision',
    workflowSnapshot: snapshot,
    source: 'workflow',
    state: 'running',
    nextStepIndex: 0,
    currentStepId: 'send-1',
    waitKind: 'quarantine',
    createdAt: '2026-08-24T10:00:00.000Z',
    updatedAt: '2026-08-24T10:00:00.000Z',
    ...rest,
  };
}

describe('workflow quarantine recovery', () => {
  beforeEach(async () => {
    await Promise.all([db.workflowRuns.clear(), db.agentQuarantines.clear()]);
  });

  it('selects only running quarantine waits whose pinned current step targets the cleared agent', async () => {
    await db.workflowRuns.bulkPut([
      run({ id: 'matching' }),
      run({ id: 'other-agent', workflowSnapshot: workflow('wf-other', 'agent-b') }),
      run({ id: 'ordinary-wait', waitKind: 'wait_idle' }),
      run({ id: 'finished', state: 'completed' }),
    ]);

    expect((await listQuarantineWorkflowWaiters('agent-a')).map((item) => item.id)).toEqual(['matching']);
  });

  it('refuses to wake while durable quarantine is still active', async () => {
    await db.workflowRuns.put(run({ id: 'blocked' }));
    await db.agentQuarantines.put({
      agentId: 'agent-a',
      state: 'logged_out',
      blockerKind: 'login',
      mode: 'manual',
      createdAt: '2026-08-24T10:00:00.000Z',
      updatedAt: '2026-08-24T10:00:00.000Z',
    });

    expect(await listQuarantineWorkflowWaiters('agent-a')).toEqual([]);
    expect(await listClearedQuarantineWorkflowWaiters()).toEqual([]);
  });

  it('discovers a cleared quarantine wait during ordinary reconciliation without a popup wake', async () => {
    await db.workflowRuns.put(run({ id: 'restart-recovery' }));
    await db.agentQuarantines.put({
      agentId: 'agent-a',
      state: 'logged_out',
      blockerKind: 'login',
      mode: 'manual',
      createdAt: '2026-08-24T10:00:00.000Z',
      updatedAt: '2026-08-24T10:00:00.000Z',
    });

    expect(await listClearedQuarantineWorkflowWaiters()).toEqual([]);

    // Use the public clear operation because the preceding read may lazily migrate
    // the legacy per-agent record to canonical physical-target authority.
    // This models operator clear followed by MV3 worker loss before
    // nika.quarantineCleared is delivered.
    await clearAgentQuarantine('agent-a');

    expect((await listClearedQuarantineWorkflowWaiters()).map((item) => item.id)).toEqual(['restart-recovery']);
  });

  it('ordinary reconciliation excludes malformed quarantine checkpoints even after clear', async () => {
    const mismatch = run({ id: 'mismatch', currentStepId: 'wait-1' });
    const missing = run({ id: 'missing' });
    delete missing.currentStepId;
    await db.workflowRuns.bulkPut([mismatch, missing]);

    expect(await listClearedQuarantineWorkflowWaiters()).toEqual([]);
    expect(quarantineWorkflowTargetAgentId(mismatch)).toBeUndefined();
    expect(quarantineWorkflowTargetAgentId(missing)).toBeUndefined();
  });

  it('rejects mismatched or missing durable current-step checkpoints', () => {
    expect(quarantineWorkflowWaitsOnAgent(run({ id: 'mismatch', currentStepId: 'wait-1' }), 'agent-a')).toBe(false);
    const missing = run({ id: 'missing' });
    delete missing.currentStepId;
    expect(quarantineWorkflowWaitsOnAgent(missing, 'agent-a')).toBe(false);
    expect(quarantineWorkflowWaitsOnAgent(run({ id: 'wrong-index', nextStepIndex: 1 }), 'agent-a')).toBe(false);
  });

  it('supports every ChatGPT-touching workflow step while excluding delay', () => {
    const steps: WorkflowDefinition['steps'] = [
      { id: 'send', type: 'send', agentId: 'agent-a', prompt: 'x' },
      { id: 'wait', type: 'wait_idle', agentId: 'agent-a', timeoutMs: 1_000 },
      { id: 'capture', type: 'capture', agentId: 'agent-a', outputKey: 'out' },
      { id: 'forward', type: 'forward', agentId: 'agent-a', fromKey: 'out' },
      { id: 'delay', type: 'delay', milliseconds: 1_000 },
    ];

    for (const step of steps) {
      const snapshot: WorkflowDefinition = { id: `wf-${step.id}`, projectId: 'default', name: step.id, enabled: true, steps: [step] };
      const candidate = run({ id: step.id, workflowSnapshot: snapshot, currentStepId: step.id });
      expect(quarantineWorkflowWaitsOnAgent(candidate, 'agent-a')).toBe(step.type !== 'delay');
    }
  });
});
