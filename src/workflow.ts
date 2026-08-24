import { appendLog, getAgents, getWorkflows } from './storage';
import { acquireAgentLease, getRecoverableRuns, getRun, putRun, releaseAgentLease, updateRun } from './db';
import { captureAgentResponse, sendToAgent, waitForAgentIdle } from './runtime';
import type { AgentLease, ChatAgent, RunRecord, WorkflowDefinition, WorkflowStep } from './types';

export async function runWorkflow(workflow: WorkflowDefinition): Promise<string> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: crypto.randomUUID(),
    workflowId: workflow.id,
    correlationId: crypto.randomUUID(),
    currentStepIndex: 0,
    stepPhase: 'pending',
    state: 'running',
    context: {},
    createdAt: now,
    updatedAt: now,
    retryCount: 0,
  };
  await putRun(run);
  await appendLog({ workflowId: workflow.id, runId: run.runId, correlationId: run.correlationId, level: 'info', event: 'workflow_started' });
  await executeRun(workflow, run);
  return run.runId;
}

export async function resumeWorkflowRun(runId: string): Promise<void> {
  const run = await getRun(runId);
  if (!run || run.state === 'completed' || run.state === 'failed' || run.state === 'needs_attention') return;

  const workflow = (await getWorkflows()).find((candidate) => candidate.id === run.workflowId);
  if (!workflow || !workflow.enabled) {
    await updateRun(runId, { state: 'failed', lastError: 'Workflow is missing or disabled.' });
    return;
  }

  const current = workflow.steps[run.currentStepIndex];
  if (run.stepPhase === 'started' && current && isSideEffecting(current)) {
    await markAmbiguousSideEffect(run, current);
    return;
  }

  await executeRun(workflow, run);
}

export async function recoverInterruptedWorkflows(): Promise<void> {
  const runs = await getRecoverableRuns();
  for (const run of runs) {
    if (run.state === 'waiting' && run.wakeAt) {
      const when = Date.parse(run.wakeAt);
      if (Number.isFinite(when) && when > Date.now()) {
        chrome.alarms.create(`run:${run.runId}`, { when });
        continue;
      }
    }
    await resumeWorkflowRun(run.runId);
  }
}

async function executeRun(workflow: WorkflowDefinition, initialRun: RunRecord): Promise<void> {
  const agents = await getAgents();
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const context = new Map(Object.entries(initialRun.context));
  const leases: AgentLease[] = [];

  try {
    for (const agentId of workflowAgentIds(workflow)) {
      const lease = await acquireAgentLease(agentId, initialRun.runId);
      if (!lease) throw new Error(`Agent '${agentId}' is already executing another run.`);
      leases.push(lease);
    }

    for (let index = initialRun.currentStepIndex; index < workflow.steps.length; index += 1) {
      const step = workflow.steps[index];
      const meta = { runId: initialRun.runId, stepId: step.id, correlationId: initialRun.correlationId };
      const targetChatId = 'agentId' in step ? step.agentId : undefined;

      await updateRun(initialRun.runId, {
        currentStepIndex: index,
        currentStepId: step.id,
        currentStepType: step.type,
        targetChatId,
        stepPhase: 'started',
        state: 'running',
        wakeAt: undefined,
      });
      await appendLog({ workflowId: workflow.id, ...meta, agentId: targetChatId, level: 'info', event: 'workflow_step_started', detail: step.type });

      switch (step.type) {
        case 'send': {
          const agent = requireAgent(byId, step.agentId);
          await sendToAgent(agent, interpolate(step.prompt, context), meta);
          break;
        }
        case 'wait_idle': {
          const agent = requireAgent(byId, step.agentId);
          await waitForAgentIdle(agent, step.timeoutMs, meta);
          break;
        }
        case 'capture': {
          const agent = requireAgent(byId, step.agentId);
          context.set(step.outputKey, await captureAgentResponse(agent, meta));
          break;
        }
        case 'forward': {
          const agent = requireAgent(byId, step.agentId);
          const captured = context.get(step.fromKey);
          if (!captured) throw new Error(`Workflow output '${step.fromKey}' is not available.`);
          await sendToAgent(agent, `${step.prefix ?? ''}${captured}`, meta);
          break;
        }
        case 'delay': {
          const wakeAt = new Date(Date.now() + Math.max(0, step.milliseconds)).toISOString();
          await updateRun(initialRun.runId, {
            context: Object.fromEntries(context),
            currentStepIndex: index + 1,
            stepPhase: 'completed',
            state: 'waiting',
            wakeAt,
          });
          chrome.alarms.create(`run:${initialRun.runId}`, { when: Date.parse(wakeAt) });
          await appendLog({ workflowId: workflow.id, ...meta, level: 'info', event: 'workflow_delayed', detail: wakeAt });
          return;
        }
      }

      await updateRun(initialRun.runId, {
        context: Object.fromEntries(context),
        currentStepIndex: index + 1,
        stepPhase: 'completed',
      });
      await appendLog({ workflowId: workflow.id, ...meta, agentId: targetChatId, level: 'info', event: 'workflow_step_completed', detail: step.type });
    }

    await updateRun(initialRun.runId, { state: 'completed', wakeAt: undefined });
    await appendLog({ workflowId: workflow.id, runId: initialRun.runId, correlationId: initialRun.correlationId, level: 'info', event: 'workflow_completed' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const latest = await getRun(initialRun.runId);
    const current = latest ? workflow.steps[latest.currentStepIndex] : undefined;
    const ambiguous = latest?.stepPhase === 'started' && current && isSideEffecting(current);

    await updateRun(initialRun.runId, { state: ambiguous ? 'needs_attention' : 'failed', lastError: message });
    await appendLog({
      workflowId: workflow.id,
      runId: initialRun.runId,
      stepId: latest?.currentStepId,
      correlationId: initialRun.correlationId,
      agentId: latest?.targetChatId,
      level: 'error',
      event: ambiguous ? 'workflow_side_effect_ambiguous' : 'workflow_failed',
      detail: message,
    });
    throw error;
  } finally {
    await Promise.allSettled(leases.map((lease) => releaseAgentLease(lease)));
  }
}

async function markAmbiguousSideEffect(run: RunRecord, step: WorkflowStep): Promise<void> {
  const message = `Run interrupted during side-effecting '${step.type}' step; automatic replay is blocked to prevent duplicate prompts.`;
  await updateRun(run.runId, { state: 'needs_attention', lastError: message });
  await appendLog({
    workflowId: run.workflowId,
    runId: run.runId,
    stepId: step.id,
    correlationId: run.correlationId,
    agentId: 'agentId' in step ? step.agentId : undefined,
    level: 'error',
    event: 'workflow_side_effect_ambiguous',
    detail: message,
  });
}

function workflowAgentIds(workflow: WorkflowDefinition): string[] {
  return [...new Set(workflow.steps.flatMap((step) => ('agentId' in step ? [step.agentId] : [])))].sort();
}

function isSideEffecting(step: WorkflowStep): boolean {
  return step.type === 'send' || step.type === 'forward';
}

function requireAgent(map: Map<string, ChatAgent>, id: string): ChatAgent {
  const agent = map.get(id);
  if (!agent) throw new Error(`Agent '${id}' was not found.`);
  if (!agent.enabled) throw new Error(`Agent '${agent.name}' is disabled.`);
  return agent;
}

export function interpolate(input: string, context: Map<string, string>): string {
  return input.replace(/\{\{([\w.-]+)\}\}/g, (_match, key: string) => context.get(key) ?? `{{${key}}}`);
}
