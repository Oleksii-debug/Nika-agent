import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, type DurableWorkflowRun } from '../src/db';
import { listQuarantineWorkflowWaiters, quarantineWorkflowWaitsOnAgent } from '../src/workflow-quarantine-recovery';
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
  const snapshot = workflow(`wf-${overrides.id}`, 'agent-a');
  return {
    id: overrides.id,
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
    ...overrides,
  };
}

describe('workflow quarantine recovery', () => {
  beforeEach(async () => {
    await db.workflowRuns.clear();
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
