import { appendLog, getAgents } from './storage';
import { captureAgentResponse, sendToAgent } from './runtime';
import type { ChatAgent, WorkflowDefinition } from './types';

export async function runWorkflow(workflow: WorkflowDefinition): Promise<void> {
  const agents = await getAgents();
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const context = new Map<string, string>();

  await appendLog({ workflowId: workflow.id, level: 'info', event: 'workflow_started' });

  try {
    for (const step of workflow.steps) {
      switch (step.type) {
        case 'send': {
          const agent = requireAgent(byId, step.agentId);
          await sendToAgent(agent, interpolate(step.prompt, context));
          break;
        }
        case 'wait_idle': {
          const agent = requireAgent(byId, step.agentId);
          await captureAgentResponse({
            ...agent,
            completion: { ...agent.completion, timeoutMs: step.timeoutMs },
          });
          break;
        }
        case 'capture': {
          const agent = requireAgent(byId, step.agentId);
          context.set(step.outputKey, await captureAgentResponse(agent));
          break;
        }
        case 'forward': {
          const agent = requireAgent(byId, step.agentId);
          const captured = context.get(step.fromKey);
          if (!captured) throw new Error(`Workflow output '${step.fromKey}' is not available.`);
          await sendToAgent(agent, `${step.prefix ?? ''}${captured}`);
          break;
        }
        case 'delay':
          await sleep(step.milliseconds);
          break;
      }
    }
    await appendLog({ workflowId: workflow.id, level: 'info', event: 'workflow_completed' });
  } catch (error) {
    await appendLog({
      workflowId: workflow.id,
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
