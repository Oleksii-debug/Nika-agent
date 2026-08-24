import { appendLog, getAgents, getWorkflows } from '../src/storage';
import { reconcileSendIntent, sendToAgent } from '../src/runtime';
import { getSendIntentForJob } from '../src/send-intents';
import { runWorkflow } from '../src/workflow';
import {
  ensureWorkflowWakeAlarm,
  failWorkflowRun,
  getRecoverableWorkflowRuns,
  getWorkflowRun,
  verifyWorkflowSnapshot,
  workflowRunIdFromAlarm,
} from '../src/workflow-state';
import {
  claimNextDueJob,
  enqueueManualAgent,
  getReconcilingJobs,
  markJobFailed,
  markJobNeedsReview,
  markJobPending,
  markJobReconciling,
  markJobRunning,
  markJobSucceeded,
  rebuildWakeAlarm,
  reconcileSchedules,
  synchronizeSchedules,
} from '../src/scheduler';
import type { RunSource } from '../src/types';

const activeManualWorkflows = new Set<string>();
const activeRecoveredWorkflowRuns = new Set<string>();
let draining = false;

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => { void initializeScheduler(); });
  chrome.runtime.onStartup.addListener(() => { void initializeScheduler(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['nika.agents']) void initializeScheduler();
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    const workflowRunId = workflowRunIdFromAlarm(alarm.name);
    if (workflowRunId) {
      void resumeWorkflowRun(workflowRunId);
      return;
    }
    if (alarm.name === 'nika.scheduler' || alarm.name === 'nika.scheduler.safety') void reconcileAndDrain();
  });
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!message || typeof message !== 'object') return;
    const msg = message as { type?: string; agentId?: string; workflowId?: string; prompt?: string; url?: string };
    if (msg.type === 'nika.chatIdleCandidate') {
      const sourceUrl = sender.tab?.url ?? msg.url;
      if (sourceUrl) void resumeIdleWaitsForUrl(sourceUrl);
      return;
    }
    if (msg.type === 'nika.runAgent' && msg.agentId) {
      void enqueueManualAgent(msg.agentId, msg.prompt).then(async () => { await drainJobs(); sendResponse({ ok: true }); }).catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }
    if (msg.type === 'nika.runWorkflow' && msg.workflowId) {
      void runManualWorkflow(msg.workflowId).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: String(error) }));
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
  await reconcileInterruptedSends(agents);
  await drainJobs();
  await resumeDurableWorkflows();
  await rebuildWakeAlarm();
}

async function resumeDurableWorkflows(): Promise<void> {
  const now = Date.now();
  for (const run of await getRecoverableWorkflowRuns()) {
    if (run.wakeAt) {
      const wakeAt = Date.parse(run.wakeAt);
      if (!Number.isFinite(wakeAt)) {
        const detail = `Persisted workflow wake timestamp is invalid: ${run.wakeAt}`;
        await failWorkflowRun(run.id, detail, true);
        await appendLog({ workflowId: run.workflowId, runId: run.id, source: run.source, level: 'error', event: 'workflow_resume_blocked', detail });
        continue;
      }
      if (wakeAt > now) {
        await ensureWorkflowWakeAlarm(run.id, run.wakeAt);
        continue;
      }
    }
    await resumeWorkflowRun(run.id);
  }
}

async function resumeIdleWaitsForUrl(url: string): Promise<void> {
  const agents = await getAgents();
  const matchingAgentIds = new Set(agents.filter((agent) => agent.enabled && sameChatUrl(agent.url, url)).map((agent) => agent.id));
  if (!matchingAgentIds.size) return;

  for (const run of await getRecoverableWorkflowRuns()) {
    if (run.waitKind !== 'wait_idle' || !run.currentStepId) continue;
    const step = run.workflowSnapshot.steps[run.nextStepIndex];
    if (!step || step.id !== run.currentStepId || step.type !== 'wait_idle') continue;
    if (!matchingAgentIds.has(step.agentId)) continue;
    await resumeWorkflowRun(run.id, true);
  }
}

async function resumeWorkflowRun(runId: string, ignoreWakeAt = false): Promise<void> {
  if (activeRecoveredWorkflowRuns.has(runId)) return;
  const run = await getWorkflowRun(runId);
  if (!run || run.state !== 'running') return;

  if (!(await verifyWorkflowSnapshot(run))) {
    const detail = 'Pinned workflow snapshot is missing or failed revision verification; automatic resume is blocked.';
    await failWorkflowRun(run.id, detail, true);
    await appendLog({ workflowId: run.workflowId, runId: run.id, source: run.source, level: 'error', event: 'workflow_resume_blocked', detail });
    return;
  }

  if (!ignoreWakeAt && run.wakeAt) {
    const wakeAt = Date.parse(run.wakeAt);
    if (!Number.isFinite(wakeAt)) {
      const detail = `Persisted workflow wake timestamp is invalid: ${run.wakeAt}`;
      await failWorkflowRun(run.id, detail, true);
      await appendLog({ workflowId: run.workflowId, runId: run.id, source: run.source, level: 'error', event: 'workflow_resume_blocked', detail });
      return;
    }
    if (wakeAt > Date.now()) {
      await ensureWorkflowWakeAlarm(run.id, run.wakeAt);
      return;
    }
  }

  activeRecoveredWorkflowRuns.add(run.id);
  void runWorkflow(run.workflowSnapshot, { runId: run.id, source: run.source })
    .catch(() => undefined)
    .finally(() => activeRecoveredWorkflowRuns.delete(run.id));
}

async function reconcileInterruptedSends(agents: Awaited<ReturnType<typeof getAgents>>): Promise<void> {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  for (const job of await getReconcilingJobs()) {
    const agent = byId.get(job.agentId);
    if (!agent || !agent.enabled) {
      await markJobNeedsReview(job.id, 'Cannot reconcile interrupted send because target agent is missing or disabled.');
      continue;
    }
    const intent = await getSendIntentForJob(job.id);
    if (!intent) {
      await markJobPending(job.id, 'No persisted send intent exists; execution stopped before the irreversible send phase.');
      continue;
    }
    if (intent.state === 'confirmed') {
      await markJobSucceeded(job.id);
      await appendLog({ agentId: agent.id, runId: job.runId, source: job.source as RunSource, level: 'info', event: 'send_reconciled_confirmed', detail: `job:${job.id}` });
      continue;
    }
    const presence = await reconcileSendIntent(agent, intent);
    if (presence === 'confirmed') {
      await markJobSucceeded(job.id);
      await appendLog({ agentId: agent.id, runId: job.runId, source: job.source as RunSource, level: 'info', event: 'send_reconciled_confirmed', detail: `job:${job.id}` });
    } else if (presence === 'absent') {
      await markJobPending(job.id, 'Persisted intent was absent from post-baseline user turns; safe replay permitted with the same intent.');
      await appendLog({ agentId: agent.id, runId: job.runId, source: job.source as RunSource, level: 'warning', event: 'send_reconciled_absent', detail: `job:${job.id}` });
    } else {
      await markJobNeedsReview(job.id, 'Interrupted send produced ambiguous DOM evidence; automatic replay blocked.');
      await appendLog({ agentId: agent.id, runId: job.runId, source: job.source as RunSource, level: 'error', event: 'send_reconciliation_ambiguous', detail: `job:${job.id}` });
    }
  }
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
      const runId = job.runId ?? crypto.randomUUID();
      await markJobRunning(job, runId);
      const runtimeContext = { runId, source: job.source as RunSource, jobId: job.id } as const;
      await appendLog({ agentId: agent.id, ...runtimeContext, level: 'info', event: 'agent_run_started', detail: `job:${job.id}` });
      try {
        await sendToAgent(agent, job.prompt?.trim() || agent.defaultPrompt, runtimeContext);
        await markJobSucceeded(job.id);
        await appendLog({ agentId: agent.id, ...runtimeContext, level: 'info', event: 'agent_run_completed', detail: `job:${job.id}` });
      } catch (error) {
        const intent = await getSendIntentForJob(job.id);
        if (intent && (intent.state === 'dispatching' || intent.state === 'ambiguous')) {
          await markJobReconciling(job.id, error instanceof Error ? error.message : String(error));
        } else {
          await markJobFailed(job.id, error);
        }
        await appendLog({ agentId: agent.id, ...runtimeContext, level: 'error', event: job.source === 'scheduled' ? 'scheduled_run_failed' : 'manual_run_failed', detail: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    draining = false;
  }
}

async function runManualWorkflow(workflowId: string): Promise<void> {
  if (activeManualWorkflows.has(workflowId)) throw new Error('This workflow already has an active manual run.');
  activeManualWorkflows.add(workflowId);
  try { await runWorkflowNow(workflowId, 'manual'); } finally { activeManualWorkflows.delete(workflowId); }
}

async function runWorkflowNow(workflowId: string, source: RunSource): Promise<void> {
  const workflow = (await getWorkflows()).find((candidate) => candidate.id === workflowId);
  if (!workflow || !workflow.enabled) return;
  await runWorkflow(workflow, { runId: crypto.randomUUID(), source });
}

function sameChatUrl(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.origin === right.origin && left.pathname.replace(/\/$/, '') === right.pathname.replace(/\/$/, '');
  } catch {
    return a === b;
  }
}
