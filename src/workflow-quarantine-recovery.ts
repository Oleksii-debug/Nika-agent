import { getActiveAgentQuarantine } from './chat-quarantine';
import { db, type DurableWorkflowRun } from './db';
import { getAgents } from './storage';
import { canonicalTargetKey } from './target-claims';

export async function listQuarantineWorkflowWaiters(agentId: string): Promise<DurableWorkflowRun[]> {
  if (await getActiveAgentQuarantine(agentId)) return [];

  const matchingAgentIds = new Set<string>([agentId]);
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    const agents = await getAgents();
    const source = agents.find((agent) => agent.id === agentId);
    if (source) {
      const targetKey = canonicalTargetKey(source.url);
      for (const agent of agents) {
        if (canonicalTargetKey(agent.url) === targetKey) matchingAgentIds.add(agent.id);
      }
    }
  }

  const runs = await db.workflowRuns.where('state').equals('running').toArray();
  return runs.filter((run) => quarantineWorkflowWaitsOnAnyAgent(run, matchingAgentIds));
}

export function quarantineWorkflowWaitsOnAgent(run: DurableWorkflowRun, agentId: string): boolean {
  return quarantineWorkflowWaitsOnAnyAgent(run, new Set([agentId]));
}

function quarantineWorkflowWaitsOnAnyAgent(run: DurableWorkflowRun, agentIds: ReadonlySet<string>): boolean {
  if (run.state !== 'running' || run.waitKind !== 'quarantine' || !run.currentStepId) return false;
  const step = run.workflowSnapshot?.steps[run.nextStepIndex];
  if (!step || step.id !== run.currentStepId) return false;
  switch (step.type) {
    case 'send':
    case 'wait_idle':
    case 'capture':
    case 'forward':
      return agentIds.has(step.agentId);
    case 'delay':
      return false;
  }
}
