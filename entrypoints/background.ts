import { appendLog, getAgents, getWorkflows } from '../src/storage';
import { acquireAgentLease, purgeExpiredLeases, releaseAgentLease, startLeaseHeartbeat } from '../src/db';
import { sendToAgent } from '../src/runtime';
import { recoverInterruptedWorkflows, resumeWorkflowRun, runWorkflow } from '../src/workflow';

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    void initializeRuntime();
  });

  chrome.runtime.onStartup.addListener(() => {
    void initializeRuntime();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes['nika.agents'] || changes['nika.workflows'])) {
      void rebuildAlarms();
    }
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    void handleAlarm(alarm.name);
  });

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return;
    const msg = message as { type?: string; agentId?: string; workflowId?: string; prompt?: string };
    if (msg.type === 'nika.runAgent' && msg.agentId) {
      void runAgentNow(msg.agentId, msg.prompt, 'manual').then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }
    if (msg.type === 'nika.runWorkflow' && msg.workflowId) {
      void runWorkflowNow(msg.workflowId).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }
  });
});

async function initializeRuntime(): Promise<void> {
  await purgeExpiredLeases();
  await rebuildAlarms();
  await recoverInterruptedWorkflows();
}

async function rebuildAlarms(): Promise<void> {
  const alarms = await chrome.alarms.getAll();
  await Promise.all(
    alarms.filter((alarm) => alarm.name.startsWith('agent:')).map((alarm) => chrome.alarms.clear(alarm.name)),
  );

  const agents = await getAgents();
  for (const agent of agents) {
    if (!agent.enabled || !agent.schedule.enabled) continue;
    if (agent.schedule.kind === 'interval') {
      chrome.alarms.create(`agent:${agent.id}`, { periodInMinutes: Math.max(1, agent.schedule.minutes) });
    } else if (agent.schedule.kind === 'once') {
      const when = Date.parse(agent.schedule.at);
      if (Number.isFinite(when) && when > Date.now()) chrome.alarms.create(`agent:${agent.id}`, { when });
    }
  }
}

async function handleAlarm(name: string): Promise<void> {
  if (name.startsWith('agent:')) {
    await runAgentNow(name.slice('agent:'.length), undefined, 'scheduled');
    return;
  }
  if (name.startsWith('run:')) {
    await resumeWorkflowRun(name.slice('run:'.length));
  }
}

async function runAgentNow(agentId: string, prompt?: string, source: 'manual' | 'scheduled' = 'manual'): Promise<void> {
  const agent = (await getAgents()).find((candidate) => candidate.id === agentId);
  if (!agent || !agent.enabled) return;

  const ownerRunId = `direct:${crypto.randomUUID()}`;
  const lease = await acquireAgentLease(agent.id, ownerRunId);
  if (!lease) {
    const message = `Agent '${agent.name}' is busy; concurrent ${source} start rejected.`;
    await appendLog({ agentId, runId: ownerRunId, level: 'warning', event: 'agent_run_conflict', detail: message });
    throw new Error(message);
  }

  let leaseLost = false;
  const stopHeartbeat = startLeaseHeartbeat([lease], () => {
    leaseLost = true;
  });

  try {
    await sendToAgent(agent, prompt?.trim() || agent.defaultPrompt, { runId: ownerRunId });
    if (leaseLost) throw new Error(`Execution lease for agent '${agent.id}' was lost.`);
  } catch (error) {
    await appendLog({
      agentId,
      runId: ownerRunId,
      level: 'error',
      event: source === 'scheduled' ? 'scheduled_run_failed' : 'manual_run_failed',
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    stopHeartbeat();
    await releaseAgentLease(lease);
  }
}

async function runWorkflowNow(workflowId: string): Promise<void> {
  const workflow = (await getWorkflows()).find((candidate) => candidate.id === workflowId);
  if (!workflow || !workflow.enabled) return;
  await runWorkflow(workflow);
}
