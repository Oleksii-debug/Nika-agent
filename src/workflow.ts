import { appendLog, getAgents } from './storage';
import { captureAgentResponse, sendToAgent, waitForAgentIdle } from './runtime';
import {
  checkpointStepCompleted,
  checkpointStepStarted,
  completeWorkflowRun,
  createWorkflowRun,
  failWorkflowRun,
  getWorkflowOutputs,
  getWorkflowRun,
  putWorkflowOutput,
} from './workflow-state';
import type { ChatAgent, RunSource, WorkflowDefinition } from './types';

export type WorkflowRunOptions = {
  runId?: string;
  source?: RunSource;
};

export async function runWorkflow(workflow: WorkflowDefinition, options: WorkflowRunOptions = {}): Promise<void> {
  const source = options.source ?? 'workflow';
  const durable = await createWorkflowRun(workflow.id, source, options.runId);
  const runId = durable.id;
  const agents = await getAgents();
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const context = await getWorkflowOutputs(runId);
  const persisted = await getWorkflowRun(runId);
  let index = persisted?.nextStepIndex ?? 0;

  if (index === 0 && !persisted?.currentStepId) {
    await appendLog({ workflowId: workflow.id, runId, source, level: 'info', event: 'workflow_started' });
  } else {
    await appendLog({ workflowId: workflow.id, runId, source, level: 'warning', event: 'workflow_resumed', detail: `step:${index}` });
  }

  try {
    for (; index < workflow.steps.length; index += 1) {
      const step = workflow.steps[index];
      const runtimeContext = { workflowId: workflow.id, runId, stepId: step.id, source } as const;
      const current = await getWorkflowRun(runId);
      let resumeAt = current?.currentStepId === step.id ? current.resumeAt : undefined;

      if (!current?.currentStepId) {
        if (step.type === 'delay') resumeAt = new Date(Date.now() + step.milliseconds).toISOString();
        await checkpointStepStarted(runId, step.id, resumeAt);
        await appendLog({ ...runtimeContext, level: 'info', event: 'workflow_step_started', detail: step.type });
      }

      switch (step.type) {
        case 'send': {
          const agent = requireAgent(byId, step.agentId);
          await sendToAgent(agent, interpolate(step.prompt, context), { ...runtimeContext, jobId: workflowSendKey(runId, step.id) });
          break;
        }
        case 'wait_idle': {
          const agent = requireAgent(byId, step.agentId);
          await waitForAgentIdle(agent, step.timeoutMs, runtimeContext);
          break;
        }
        case 'capture': {
          const agent = requireAgent(byId, step.agentId);
          const existing = context.get(step.outputKey);
          if (!existing) {
            const captured = await captureAgentResponse(agent, runtimeContext);
            await putWorkflowOutput(runId, step.outputKey, captured);
            context.set(step.outputKey, captured);
          }
          break;
        }
        case 'forward': {
          const agent = requireAgent(byId, step.agentId);
          const captured = context.get(step.fromKey);
          if (!captured) throw new Error(`Workflow output '${step.fromKey}' is not available.`);
          await sendToAgent(agent, `${step.prefix ?? ''}${captured}`, { ...runtimeContext, jobId: workflowSendKey(runId, step.id) });
          break;
        }
        case 'delay': {
          const target = resumeAt ? Date.parse(resumeAt) : Date.now();
          if (Number.isFinite(target) && target > Date.now()) await sleep(target - Date.now());
          break;
        }
      }

      await checkpointStepCompleted(runId, index + 1);
      await appendLog({ ...runtimeContext, level: 'info', event: 'workflow_step_completed', detail: step.type });
    }

    await completeWorkflowRun(runId);
    await appendLog({ workflowId: workflow.id, runId, source, level: 'info', event: 'workflow_completed' });
  } catch (error) {
    const needsReview = error instanceof Error && error.message.includes('SEND_AMBIGUOUS');
    await failWorkflowRun(runId, error, needsReview);
    await appendLog({ workflowId: workflow.id, runId, source, level: 'error', event: needsReview ? 'workflow_needs_review' : 'workflow_failed', detail: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

function workflowSendKey(runId: string, stepId: string): string {
  return `workflow:${runId}:${stepId}`;
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
