import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAgent, RunRecord, WorkflowDefinition } from './types';

const mocks = vi.hoisted(() => ({
  appendLog: vi.fn(),
  getAgents: vi.fn(),
  captureAgentResponse: vi.fn(),
  sendToAgent: vi.fn(),
  waitForAgentIdle: vi.fn(),
  acquireAgentLease: vi.fn(),
  createRunRecord: vi.fn(),
  getRunRecord: vi.fn(),
  releaseAgentLease: vi.fn(),
  saveRunRecord: vi.fn(),
}));

vi.mock('./storage', () => ({
  appendLog: mocks.appendLog,
  getAgents: mocks.getAgents,
}));

vi.mock('./runtime', () => ({
  captureAgentResponse: mocks.captureAgentResponse,
  sendToAgent: mocks.sendToAgent,
  waitForAgentIdle: mocks.waitForAgentIdle,
}));

vi.mock('./run-store', () => ({
  acquireAgentLease: mocks.acquireAgentLease,
  createRunRecord: mocks.createRunRecord,
  getRunRecord: mocks.getRunRecord,
  releaseAgentLease: mocks.releaseAgentLease,
  saveRunRecord: mocks.saveRunRecord,
}));

import { interpolate, resumeWorkflow, runWorkflow } from './workflow';

const agent: ChatAgent = {
  id: 'developer',
  projectId: 'project',
  name: 'Developer',
  role: 'developer',
  url: 'https://chatgpt.com/c/developer',
  enabled: true,
  defaultPrompt: '',
  schedule: { kind: 'manual', enabled: true },
  completion: { waitForIdle: true, timeoutMs: 60_000, settleMs: 1_000 },
  tags: [],
};

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-1',
    workflowId: 'workflow',
    currentStepIndex: 0,
    stepState: 'pending',
    state: 'queued',
    context: {},
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
    retryCount: 0,
    correlationId: 'correlation-1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAgents.mockResolvedValue([agent]);
  mocks.appendLog.mockResolvedValue(undefined);
  mocks.sendToAgent.mockResolvedValue(undefined);
  mocks.waitForAgentIdle.mockResolvedValue(undefined);
  mocks.captureAgentResponse.mockResolvedValue('captured response');
  mocks.acquireAgentLease.mockResolvedValue(true);
  mocks.releaseAgentLease.mockResolvedValue(undefined);
  mocks.saveRunRecord.mockResolvedValue(undefined);
  mocks.createRunRecord.mockResolvedValue(makeRun());
});

describe('runWorkflow', () => {
  it('wait_idle waits without capturing a response', async () => {
    const workflow: WorkflowDefinition = {
      id: 'workflow',
      projectId: 'project',
      name: 'Wait only',
      enabled: true,
      steps: [{ id: 'wait-1', type: 'wait_idle', agentId: agent.id, timeoutMs: 12_345 }],
    };

    await runWorkflow(workflow);

    expect(mocks.waitForAgentIdle).toHaveBeenCalledWith(agent, 12_345);
    expect(mocks.captureAgentResponse).not.toHaveBeenCalled();
  });

  it('checkpoints an executing step before dispatching a side effect', async () => {
    const workflow: WorkflowDefinition = {
      id: 'workflow',
      projectId: 'project',
      name: 'Checkpoint',
      enabled: true,
      steps: [{ id: 'send-1', type: 'send', agentId: agent.id, prompt: 'Implement feature' }],
    };

    await runWorkflow(workflow);

    const dispatchOrder = mocks.saveRunRecord.mock.invocationCallOrder[0];
    const sendOrder = mocks.sendToAgent.mock.invocationCallOrder[0];
    expect(dispatchOrder).toBeLessThan(sendOrder);
    const checkpoint = mocks.saveRunRecord.mock.calls[0]?.[0] as RunRecord;
    expect(checkpoint.stepState).toBe('executing');
    expect(checkpoint.currentStepId).toBe('send-1');
  });

  it('passes a stable run id and step id into side-effecting runtime calls', async () => {
    const workflow: WorkflowDefinition = {
      id: 'workflow',
      projectId: 'project',
      name: 'Provenance',
      enabled: true,
      steps: [{ id: 'send-1', type: 'send', agentId: agent.id, prompt: 'Implement feature' }],
    };

    await runWorkflow(workflow);

    expect(mocks.sendToAgent).toHaveBeenCalledTimes(1);
    const provenance = mocks.sendToAgent.mock.calls[0]?.[2] as { runId?: string; stepId?: string } | undefined;
    expect(provenance).toEqual({ runId: 'run-1', stepId: 'send-1' });
  });

  it('blocks automatic replay when a send was interrupted in executing state', async () => {
    const workflow: WorkflowDefinition = {
      id: 'workflow',
      projectId: 'project',
      name: 'Recover send',
      enabled: true,
      steps: [{ id: 'send-1', type: 'send', agentId: agent.id, prompt: 'Implement feature' }],
    };
    const interrupted = makeRun({ state: 'running', stepState: 'executing', currentStepId: 'send-1' });
    mocks.getRunRecord.mockResolvedValue(interrupted);

    await resumeWorkflow(workflow, interrupted.runId);

    expect(mocks.sendToAgent).not.toHaveBeenCalled();
    expect(interrupted.state).toBe('needs_reconciliation');
    expect(mocks.saveRunRecord).toHaveBeenCalledWith(interrupted);
  });
});

describe('interpolate', () => {
  it('substitutes known values and preserves unresolved placeholders', () => {
    const context = new Map([['audit.result', 'approved']]);
    expect(interpolate('Result: {{audit.result}} / {{missing}}', context)).toBe(
      'Result: approved / {{missing}}',
    );
  });
});
