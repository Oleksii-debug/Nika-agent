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

/**
 * Returns quarantine-suspended runs whose durable blocker has disappeared.
 * Startup/safety reconciliation uses this as the wake authority; popup messages
 * remain a latency optimization rather than a correctness dependency.
 */
export async function listClearedQuarantineWorkflowWaiters(): Promise<DurableWorkflowRun[]> {
  const runs = await db.workflowRuns.where('state').equals('running').toArray();
  const candidates = runs.filter((run) => run.waitKind === 'quarantine');
  if (!candidates.length) return [];

  const cleared: DurableWorkflowRun[] = [];
  const quarantineByAgent = new Map<string, boolean>();

  for (const run of candidates) {
    const agentId = quarantineWorkflowTargetAgentId(run);
    if (!agentId) continue;

    let blocked = quarantineByAgent.get(agentId);
    if (blocked === undefined) {
      blocked = Boolean(await getActiveAgentQuarantine(agentId));
      quarantineByAgent.set(agentId, blocked);
    }
    if (!blocked) cleared.push(run);
  }

  return cleared;
}

export function quarantineWorkflowWaitsOnAgent(run: DurableWorkflowRun, agentId: string): boolean {
  return quarantineWorkflowWaitsOnAnyAgent(run, new Set([agentId]));
}

export function quarantineWorkflowTargetAgentId(run: DurableWorkflowRun): string | undefined {
  if (run.state !== 'running' || run.waitKind !== 'quarantine' || !run.currentStepId) return undefined;
  const step = run.workflowSnapshot?.steps[run.nextStepIndex];
  if (!step || step.id !== run.currentStepId) return undefined;
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

function quarantineWorkflowWaitsOnAnyAgent(run: DurableWorkflowRun, agentIds: ReadonlySet<string>): boolean {
  const agentId = quarantineWorkflowTargetAgentId(run);
  return agentId ? agentIds.has(agentId) : false;
}
