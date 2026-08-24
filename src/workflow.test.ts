import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAgent, WorkflowDefinition } from './types';

const mocks = vi.hoisted(() => ({
  appendLog: vi.fn(),
  getAgents: vi.fn(),
  captureAgentResponse: vi.fn(),
  sendToAgent: vi.fn(),
  waitForAgentIdle: vi.fn(),
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

import { interpolate, runWorkflow } from './workflow';

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAgents.mockResolvedValue([agent]);
  mocks.appendLog.mockResolvedValue(undefined);
  mocks.sendToAgent.mockResolvedValue(undefined);
  mocks.waitForAgentIdle.mockResolvedValue(undefined);
  mocks.captureAgentResponse.mockResolvedValue('captured response');
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
    expect(provenance?.runId).toEqual(expect.any(String));
    expect(provenance?.stepId).toBe('send-1');

    const startedLog = mocks.appendLog.mock.calls.find(
      ([entry]) => (entry as { event?: string }).event === 'workflow_started',
    )?.[0] as { runId?: string } | undefined;
    expect(startedLog?.runId).toBe(provenance?.runId);
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
