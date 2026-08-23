import { appendLog, getAgents, getWorkflows } from '../src/storage';
import { sendToAgent } from '../src/runtime';
import { runWorkflow } from '../src/workflow';

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    void rebuildAlarms();
  });

  chrome.runtime.onStartup.addListener(() => {
    void rebuildAlarms();
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
      void runAgentNow(msg.agentId, msg.prompt).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }
    if (msg.type === 'nika.runWorkflow' && msg.workflowId) {
      void runWorkflowNow(msg.workflowId).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }
  });
});

async function rebuildAlarms(): Promise<void> {
  await chrome.alarms.clearAll();
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
  if (!name.startsWith('agent:')) return;
  await runAgentNow(name.slice('agent:'.length));
}

async function runAgentNow(agentId: string, prompt?: string): Promise<void> {
  const agent = (await getAgents()).find((candidate) => candidate.id === agentId);
  if (!agent || !agent.enabled) return;
  try {
    await sendToAgent(agent, prompt?.trim() || agent.defaultPrompt);
  } catch (error) {
    await appendLog({
      agentId,
      level: 'error',
      event: 'scheduled_run_failed',
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function runWorkflowNow(workflowId: string): Promise<void> {
  const workflow = (await getWorkflows()).find((candidate) => candidate.id === workflowId);
  if (!workflow || !workflow.enabled) return;
  await runWorkflow(workflow);
}
