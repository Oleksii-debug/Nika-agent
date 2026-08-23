import { appendLog, getAgents, getWorkflows } from '../src/storage';
import { sendToAgent } from '../src/runtime';
import { runWorkflow } from '../src/workflow';
import {
  claimNextDueJob,
  enqueueManualAgent,
  markJobFailed,
  markJobRunning,
  markJobSucceeded,
  rebuildWakeAlarm,
  reconcileSchedules,
  synchronizeSchedules,
} from '../src/scheduler';
import type { RunSource } from '../src/types';

const activeManualWorkflows = new Set<string>();
let draining = false;

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => { void initializeScheduler(); });
  chrome.runtime.onStartup.addListener(() => { void initializeScheduler(); });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['nika.agents']) void initializeScheduler();
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'nika.scheduler' || alarm.name === 'nika.scheduler.safety') void reconcileAndDrain();
  });

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return;
    const msg = message as { type?: string; agentId?: string; workflowId?: string; prompt?: string };
    if (msg.type === 'nika.runAgent' && msg.agentId) {
      void enqueueManualAgent(msg.agentId, msg.prompt)
        .then(async () => { await drainJobs(); sendResponse({ ok: true }); })
        .catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }
    if (msg.type === 'nika.runWorkflow' && msg.workflowId) {
      void runManualWorkflow(msg.workflowId)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }
  });

  void initializeScheduler();
});

async function initializeScheduler(): Promise<void> {
  const agents = await getAgents();
  await synchronizeSchedules(agents);
  await reconcileAndDrain();
}

async function reconcileAndDrain(): Promise<void> {
  const agents = await getAgents();
  await reconcileSchedules(agents);
  await drainJobs();
  await rebuildWakeAlarm();
}

async function drainJobs(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (true) {
      const job = await claimNextDueJob();
      if (!job) break;
      const agent = (await getAgents()).find((candidate) => candidate.id === job.agentId);
      if (!agent || !agent.enabled) {
        await markJobFailed(job.id, 'Target agent is missing or disabled.');
        continue;
      }

      const runId = crypto.randomUUID();
      await markJobRunning(job, runId);
      const runtimeContext = { runId, source: job.source as RunSource } as const;
      await appendLog({ agentId: agent.id, ...runtimeContext, level: 'info', event: 'agent_run_started', detail: `job:${job.id}` });
      try {
        await sendToAgent(agent, job.prompt?.trim() || agent.defaultPrompt, runtimeContext);
        await markJobSucceeded(job.id);
        await appendLog({ agentId: agent.id, ...runtimeContext, level: 'info', event: 'agent_run_completed', detail: `job:${job.id}` });
      } catch (error) {
        await markJobFailed(job.id, error);
        await appendLog({
          agentId: agent.id,
          ...runtimeContext,
          level: 'error',
          event: job.source === 'scheduled' ? 'scheduled_run_failed' : 'manual_run_failed',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    draining = false;
  }
}

async function runManualWorkflow(workflowId: string): Promise<void> {
  if (activeManualWorkflows.has(workflowId)) throw new Error('This workflow already has an active manual run.');
  activeManualWorkflows.add(workflowId);
  try {
    await runWorkflowNow(workflowId, 'manual');
  } finally {
    activeManualWorkflows.delete(workflowId);
  }
}

async function runWorkflowNow(workflowId: string, source: RunSource): Promise<void> {
  const workflow = (await getWorkflows()).find((candidate) => candidate.id === workflowId);
  if (!workflow || !workflow.enabled) return;
  await runWorkflow(workflow, { runId: crypto.randomUUID(), source });
}
