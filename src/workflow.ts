import { appendLog, getAgents } from './storage';
import { captureAgentResponse, inspectAgentState, isStablyIdle, sendToAgent } from './runtime';
import {
  checkpointStepCompleted,
  checkpointStepStarted,
  checkpointWorkflowWait,
  clearWorkflowWait,
  completeWorkflowRun,
  createWorkflowRun,
  failWorkflowRun,
  getWorkflowOutputs,
  getWorkflowRun,
  putWorkflowOutput,
  verifyWorkflowSnapshot,
} from './workflow-state';
import type { ChatAgent, RunSource, WorkflowDefinition } from './types';

const WAIT_IDLE_POLL_MS = 2_000;

export type WorkflowRunOptions = {
  runId?: string;
  source?: RunSource;
};

export type WorkflowRunResult = 'completed' | 'suspended';

export async function runWorkflow(workflow: WorkflowDefinition, options: WorkflowRunOptions = {}): Promise<WorkflowRunResult> {
  const source = options.source ?? 'workflow';
  const durable = await createWorkflowRun(workflow, source, options.runId);
  const runId = durable.id;

  if (!(await verifyWorkflowSnapshot(durable))) {
    const error = new Error('WORKFLOW_REVISION_INVALID: durable workflow snapshot is missing or does not match its revision hash.');
    await failWorkflowRun(runId, error, true);
    await appendLog({ workflowId: durable.workflowId, runId, source: durable.source, level: 'error', event: 'workflow_revision_invalid', detail: error.message });
    throw error;
  }

  const pinnedWorkflow = durable.workflowSnapshot;
  const agents = await getAgents();
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const context = await getWorkflowOutputs(runId);
  const persisted = await getWorkflowRun(runId);
  let index = persisted?.nextStepIndex ?? 0;

  if (index === 0 && !persisted?.currentStepId) {
    await appendLog({
      workflowId: pinnedWorkflow.id,
      runId,
      source: durable.source,
      level: 'info',
      event: 'workflow_started',
      detail: `revision:${durable.workflowRevision}`,
    });
  } else {
    await appendLog({
      workflowId: pinnedWorkflow.id,
      runId,
      source: durable.source,
      level: 'warning',
      event: 'workflow_resumed',
      detail: `revision:${durable.workflowRevision};step:${index}`,
    });
  }

  try {
    for (; index < pinnedWorkflow.steps.length; index += 1) {
      const step = pinnedWorkflow.steps[index];
      const runtimeContext = { workflowId: pinnedWorkflow.id, runId, stepId: step.id, source: durable.source } as const;
      const current = await getWorkflowRun(runId);
      let resumeAt = current?.currentStepId === step.id ? current.resumeAt : undefined;
      let waitDeadlineAt = current?.currentStepId === step.id ? current.waitDeadlineAt : undefined;

      if (!current?.currentStepId) {
        if (step.type === 'delay') resumeAt = new Date(Date.now() + Math.max(0, step.milliseconds)).toISOString();
        if (step.type === 'wait_idle') waitDeadlineAt = new Date(Date.now() + Math.max(1_000, step.timeoutMs)).toISOString();
        await checkpointStepStarted(runId, step.id, resumeAt);
        await appendLog({ ...runtimeContext, level: 'info', event: 'workflow_step_started', detail: step.type });
      } else if (current.currentStepId !== step.id) {
        throw new Error(`WORKFLOW_CHECKPOINT_MISMATCH: persisted step '${current.currentStepId}' does not match pinned step '${step.id}'.`);
      }

      switch (step.type) {
        case 'send': {
          const agent = requireAgent(byId, step.agentId);
          await sendToAgent(agent, interpolate(step.prompt, context), { ...runtimeContext, jobId: workflowSendKey(runId, step.id) });
          break;
        }
        case 'wait_idle': {
          const agent = requireAgent(byId, step.agentId);
          const deadline = waitDeadlineAt ? Date.parse(waitDeadlineAt) : Date.now() + Math.max(1_000, step.timeoutMs);
          if (!Number.isFinite(deadline)) throw new Error('WORKFLOW_WAIT_INVALID: persisted wait_idle deadline is invalid.');

          const evidence = await inspectAgentState(agent);
          if (isStablyIdle(evidence, agent.completion.settleMs)) {
            await clearWorkflowWait(runId);
            await appendLog({ agentId: agent.id, ...runtimeContext, level: 'info', event: 'agent_idle', detail: `state:${evidence.state}` });
            break;
          }

          if (Date.now() >= deadline) throw new Error('Timed out waiting for ChatGPT to become stably idle.');
          const mutationRemaining = evidence.state === 'idle'
            ? Math.max(250, agent.completion.settleMs - (evidence.mutationAgeMs ?? 0))
            : WAIT_IDLE_POLL_MS;
          const nextWake = Math.min(deadline, Date.now() + Math.min(WAIT_IDLE_POLL_MS, mutationRemaining));
          const wakeAt = new Date(nextWake).toISOString();
          await checkpointWorkflowWait(runId, 'wait_idle', wakeAt, new Date(deadline).toISOString());
          await appendLog({ agentId: agent.id, ...runtimeContext, level: 'info', event: 'workflow_wait_suspended', detail: `wait_idle;wakeAt:${wakeAt};state:${evidence.state}` });
          return 'suspended';
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
          if (!Number.isFinite(target)) throw new Error('WORKFLOW_WAIT_INVALID: persisted delay resume timestamp is invalid.');
          if (target > Date.now()) {
            const wakeAt = new Date(target).toISOString();
            await checkpointWorkflowWait(runId, 'delay', wakeAt);
            await appendLog({ ...runtimeContext, level: 'info', event: 'workflow_wait_suspended', detail: `delay;wakeAt:${wakeAt}` });
            return 'suspended';
          }
          await clearWorkflowWait(runId);
          break;
        }
      }

      await checkpointStepCompleted(runId, index + 1);
      await appendLog({ ...runtimeContext, level: 'info', event: 'workflow_step_completed', detail: step.type });
    }

    await completeWorkflowRun(runId);
    await appendLog({ workflowId: pinnedWorkflow.id, runId, source: durable.source, level: 'info', event: 'workflow_completed', detail: `revision:${durable.workflowRevision}` });
    return 'completed';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const needsReview = message.includes('SEND_AMBIGUOUS') || message.includes('WORKFLOW_CHECKPOINT_MISMATCH') || message.includes('WORKFLOW_REVISION_INVALID') || message.includes('WORKFLOW_WAIT_INVALID');
    await failWorkflowRun(runId, error, needsReview);
    await appendLog({ workflowId: pinnedWorkflow.id, runId, source: durable.source, level: 'error', event: needsReview ? 'workflow_needs_review' : 'workflow_failed', detail: message });
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
