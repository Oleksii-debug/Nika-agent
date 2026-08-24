import { db, type DurableWorkflowRun } from './db';

export async function listQuarantineWorkflowWaiters(agentId: string): Promise<DurableWorkflowRun[]> {
  const runs = await db.workflowRuns.where('state').equals('running').toArray();
  return runs.filter((run) => quarantineWorkflowWaitsOnAgent(run, agentId));
}

export function quarantineWorkflowWaitsOnAgent(run: DurableWorkflowRun, agentId: string): boolean {
  if (run.state !== 'running' || run.waitKind !== 'quarantine' || !run.currentStepId) return false;
  const step = run.workflowSnapshot.steps[run.nextStepIndex];
  if (!step || step.id !== run.currentStepId || step.type === 'delay') return false;
  return step.agentId === agentId;
}
