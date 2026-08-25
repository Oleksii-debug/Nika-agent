import { appendLog, getAgents } from './storage';
import { captureAgentResponse, sendToAgent, waitForAgentIdle } from './runtime';
import {
  acquireAgentLease,
  createRunRecord,
  getRunRecord,
  releaseAgentLease,
  saveRunRecord,
} from './run-store';
import type { ChatAgent, RunRecord, WorkflowDefinition, WorkflowStep } from './types';

export const RUN_ALARM_PREFIX = 'run:';
const LEASE_RETRY_MS = 5_000;

export async function runWorkflow(workflow: WorkflowDefinition): Promise<string> {
  const run = await createRunRecord(workflow.id);
  await appendLog({ workflowId: workflow.id, runId: run.runId, level: 'info', event: 'workflow_started' });
  await executeRun(workflow, run);
  return run.runId;
}

export async function resumeWorkflow(workflow: WorkflowDefinition, runId: string): Promise<void> {
  const run = await getRunRecord(runId);
  if (!run) throw new Error(`Run '${runId}' was not found.`);
  if (run.workflowId !== workflow.id) throw new Error(`Run '${runId}' does not belong to workflow '${workflow.id}'.`);
  if (run.state === 'completed' || run.state === 'failed' || run.state === 'needs_reconciliation') return;
  await executeRun(workflow, run);
}

async function executeRun(workflow: WorkflowDefinition, run: RunRecord): Promise<void> {
  const agents = await getAgents();
  const byId = new Map(agents.map((agent) => [agent.id, agent]));

  if (run.state === 'sleeping' && run.wakeAt && Date.parse(run.wakeAt) > Date.now()) {
    scheduleRunWake(run.runId, Date.parse(run.wakeAt));
    return;
  }

  try {
    while (run.currentStepIndex < workflow.steps.length) {
      const step = workflow.steps[run.currentStepIndex];
      if (!step) break;

      if (run.stepState === 'executing') {
        if (isAmbiguousSideEffect(step)) {
          run.state = 'needs_reconciliation';
          run.error = `Step '${step.id}' was interrupted after dispatch began; automatic replay is blocked to prevent duplicate side effects.`;
          await saveRunRecord(run);
          await appendLog({
            workflowId: workflow.id,
            runId: run.runId,
            stepId: step.id,
            level: 'warning',
            event: 'workflow_reconciliation_required',
            detail: run.error,
          });
          return;
        }
        run.stepState = 'pending';
      }

      const targetAgentId = getTargetAgentId(step);
      if (targetAgentId) {
        const leased = await acquireAgentLease(targetAgentId, run.runId);
        if (!leased) {
          await sleepRun(run, LEASE_RETRY_MS, targetAgentId);
          return;
        }
      }

      try {
        run.state = 'running';
        run.wakeAt = undefined;
        run.currentStepId = step.id;
        run.targetChatId = targetAgentId;
        run.stepState = 'executing';
        run.error = undefined;
        await saveRunRecord(run);

        await appendLog({
          workflowId: workflow.id,
          runId: run.runId,
          stepId: step.id,
          level: 'info',
          event: 'workflow_step_started',
          detail: step.type,
        });

        const shouldYield = await executeStep(workflow, run, step, byId);
        if (shouldYield) return;

        run.stepState = 'completed';
        await saveRunRecord(run);
        await appendLog({
          workflowId: workflow.id,
          runId: run.runId,
          stepId: step.id,
          level: 'info',
          event: 'workflow_step_completed',
          detail: step.type,
        });

        run.currentStepIndex += 1;
        run.currentStepId = undefined;
        run.targetChatId = undefined;
        run.stepState = 'pending';
        await saveRunRecord(run);
      } finally {
        if (targetAgentId) await releaseAgentLease(targetAgentId, run.runId);
      }
    }

    run.state = 'completed';
    run.currentStepId = undefined;
    run.targetChatId = undefined;
    run.wakeAt = undefined;
    run.stepState = 'completed';
    await saveRunRecord(run);
    await appendLog({ workflowId: workflow.id, runId: run.runId, level: 'info', event: 'workflow_completed' });
  } catch (error) {
    run.state = 'failed';
    run.error = error instanceof Error ? error.message : String(error);
    await saveRunRecord(run);
    await appendLog({
      workflowId: workflow.id,
      runId: run.runId,
      stepId: run.currentStepId,
      level: 'error',
      event: 'workflow_failed',
      detail: run.error,
    });
    throw error;
  }
}

async function executeStep(
  workflow: WorkflowDefinition,
  run: RunRecord,
  step: WorkflowStep,
  byId: Map<string, ChatAgent>,
): Promise<boolean> {
  const provenance = { runId: run.runId, stepId: step.id };
  const context = new Map(Object.entries(run.context));

  switch (step.type) {
    case 'send': {
      const agent = requireAgent(byId, step.agentId);
      await sendToAgent(agent, interpolate(step.prompt, context), provenance);
      return false;
    }
    case 'wait_idle': {
      const agent = requireAgent(byId, step.agentId);
      await waitForAgentIdle(agent, step.timeoutMs);
      return false;
    }
    case 'capture': {
      const agent = requireAgent(byId, step.agentId);
      run.context[step.outputKey] = await captureAgentResponse(agent, provenance);
      return false;
    }
    case 'forward': {
      const agent = requireAgent(byId, step.agentId);
      const captured = run.context[step.fromKey];
      if (!captured) throw new Error(`Workflow output '${step.fromKey}' is not available.`);
      await sendToAgent(agent, `${step.prefix ?? ''}${captured}`, provenance);
      return false;
    }
    case 'delay': {
      const wakeAt = Date.now() + Math.max(0, step.milliseconds);
      run.currentStepIndex += 1;
      run.currentStepId = undefined;
      run.targetChatId = undefined;
      run.stepState = 'pending';
      run.state = 'sleeping';
      run.wakeAt = new Date(wakeAt).toISOString();
      await saveRunRecord(run);
      scheduleRunWake(run.runId, wakeAt);
      await appendLog({
        workflowId: workflow.id,
        runId: run.runId,
        stepId: step.id,
        level: 'info',
        event: 'workflow_step_completed',
        detail: `delay until ${run.wakeAt}`,
      });
      return true;
    }
  }
}

async function sleepRun(run: RunRecord, milliseconds: number, targetAgentId?: string): Promise<void> {
  const wakeAt = Date.now() + milliseconds;
  run.state = 'sleeping';
  run.stepState = 'pending';
  run.targetChatId = targetAgentId;
  run.wakeAt = new Date(wakeAt).toISOString();
  await saveRunRecord(run);
  scheduleRunWake(run.runId, wakeAt);
}

function scheduleRunWake(runId: string, when: number): void {
  chrome.alarms.create(`${RUN_ALARM_PREFIX}${runId}`, { when: Math.max(Date.now() + 100, when) });
}

function getTargetAgentId(step: WorkflowStep): string | undefined {
  switch (step.type) {
    case 'send':
    case 'wait_idle':
    case 'capture':
    case 'forward':
      return step.agentId;
    case 'delay':
      return undefined;
  }
}

function isAmbiguousSideEffect(step: WorkflowStep): boolean {
  return step.type === 'send' || step.type === 'forward';
}

function requireAgent(map: Map<string, ChatAgent>, id: string): ChatAgent {
  const agent = map.get(id);
  if (!agent) throw new Error(`Agent '${id}' was not found.`);
  if (!agent.enabled) throw new Error(`Agent '${agent.name}' is disabled.`);
  return agent;
}

export function interpolate(input: string, context: ReadonlyMap<string, string>): string {
  return input.replace(/\{\{([\w.-]+)\}\}/g, (_match, key: string) => context.get(key) ?? `{{${key}}}`);
}
