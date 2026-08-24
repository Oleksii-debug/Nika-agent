import { appendLog, getAgents } from './storage';
import { captureAgentResponse, sendToAgent, waitForAgentIdle } from './runtime';
import type { ChatAgent, RunSource, WorkflowDefinition } from './types';

export type WorkflowRunOptions = {
  runId?: string;
  source?: RunSource;
};

export async function runWorkflow(workflow: WorkflowDefinition, options: WorkflowRunOptions = {}): Promise<void> {
  const agents = await getAgents();
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const context = new Map<string, string>();
  const runId = options.runId ?? crypto.randomUUID();
  const source = options.source ?? 'workflow';

  await appendLog({ workflowId: workflow.id, runId, source, level: 'info', event: 'workflow_started' });

  try {
    for (const step of workflow.steps) {
      const runtimeContext = { workflowId: workflow.id, runId, stepId: step.id, source } as const;
      await appendLog({
        ...runtimeContext,
        level: 'info',
        event: 'workflow_step_started',
        detail: step.type,
      });

      switch (step.type) {
        case 'send': {
          const agent = requireAgent(byId, step.agentId);
          await sendToAgent(agent, interpolate(step.prompt, context), runtimeContext);
          break;
        }
        case 'wait_idle': {
          const agent = requireAgent(byId, step.agentId);
          await waitForAgentIdle(agent, step.timeoutMs, runtimeContext);
          break;
        }
        case 'capture': {
          const agent = requireAgent(byId, step.agentId);
          context.set(step.outputKey, await captureAgentResponse(agent, runtimeContext));
          break;
        }
        case 'forward': {
          const agent = requireAgent(byId, step.agentId);
          const captured = context.get(step.fromKey);
          if (!captured) throw new Error(`Workflow output '${step.fromKey}' is not available.`);
          await sendToAgent(agent, `${step.prefix ?? ''}${captured}`, runtimeContext);
          break;
        }
        case 'delay':
          await sleep(step.milliseconds);
          break;
      }

      await appendLog({
        ...runtimeContext,
        level: 'info',
        event: 'workflow_step_completed',
        detail: step.type,
      });
    }
    await appendLog({ workflowId: workflow.id, runId, source, level: 'info', event: 'workflow_completed' });
  } catch (error) {
    await appendLog({
      workflowId: workflow.id,
      runId,
      source,
      level: 'error',
      event: 'workflow_failed',
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function requireAgent(map: Map<string, ChatAgent>, id: string): ChatAgent {
  const agent = map.get(id);
  if (!agent) throw new Error(`Agent '${id}' was not found.`);
  if (!agent.enabled) throw new Error(`Agent '${agent.name}' is disabled.`);
  return agent;
}

function interpolate(input: string, context: Map<string, string>): string {
  return input.replace(/\{\{([\w.-]+)\}\}/g, (_match, key: string) => context.get(key) ?? `{{${key}}}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
