import Dexie, { type Table } from 'dexie';
import type { WorkflowDefinition } from './types';

export type DurableJobState =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'reconciling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'needs_review';

export type DurableJob = {
  id: string;
  occurrenceKey: string;
  agentId: string;
  prompt?: string;
  source: 'manual' | 'scheduled';
  dueAt: string;
  state: DurableJobState;
  attempt: number;
  maxAttempts: number;
  leaseOwner?: string;
  leaseUntil?: string;
  runId?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type ScheduleCursor = {
  agentId: string;
  nextDueAt?: string;
  lastMaterializedAt?: string;
  updatedAt: string;
};

export type SendIntentState = 'persisted' | 'dispatching' | 'confirmed' | 'absent' | 'ambiguous';

export type SendIntent = {
  id: string;
  jobId?: string;
  agentId: string;
  runId?: string;
  prompt: string;
  promptHash: string;
  baselineUserTurnCount: number;
  state: SendIntentState;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
  detail?: string;
};

export type TargetClaimOwnerKind = 'job' | 'workflow';

export type DurableTargetClaim = {
  agentId: string;
  ownerKind: TargetClaimOwnerKind;
  ownerId: string;
  operationId: string;
  acquiredAt: string;
  updatedAt: string;
};

export type WorkflowRunState = 'running' | 'completed' | 'failed' | 'needs_review';
export type WorkflowWaitKind = 'delay' | 'wait_idle' | 'target';

export type DurableWorkflowRun = {
  id: string;
  workflowId: string;
  workflowRevision: string;
  workflowSnapshot: WorkflowDefinition;
  source: 'manual' | 'scheduled' | 'workflow';
  state: WorkflowRunState;
  nextStepIndex: number;
  currentStepId?: string;
  resumeAt?: string;
  wakeAt?: string;
  waitKind?: WorkflowWaitKind;
  waitDeadlineAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type WorkflowOutput = {
  id: string;
  runId: string;
  key: string;
  value: string;
  capturedAt: string;
};

class NikaDatabase extends Dexie {
  jobs!: Table<DurableJob, string>;
  scheduleCursors!: Table<ScheduleCursor, string>;
  sendIntents!: Table<SendIntent, string>;
  targetClaims!: Table<DurableTargetClaim, string>;
  workflowRuns!: Table<DurableWorkflowRun, string>;
  workflowOutputs!: Table<WorkflowOutput, string>;

  constructor() {
    super('nika-agent');
    this.version(1).stores({
      jobs: '&id,&occurrenceKey,agentId,state,dueAt,leaseUntil,[state+dueAt]',
      scheduleCursors: '&agentId,nextDueAt',
    });
    this.version(2).stores({
      jobs: '&id,&occurrenceKey,agentId,state,dueAt,leaseUntil,[state+dueAt]',
      scheduleCursors: '&agentId,nextDueAt',
      sendIntents: '&id,jobId,agentId,runId,state,createdAt,[jobId+state]',
    });
    this.version(3).stores({
      jobs: '&id,&occurrenceKey,agentId,state,dueAt,leaseUntil,[state+dueAt]',
      scheduleCursors: '&agentId,nextDueAt',
      sendIntents: '&id,jobId,agentId,runId,state,createdAt,[jobId+state]',
      workflowRuns: '&id,workflowId,state,updatedAt,[workflowId+state]',
      workflowOutputs: '&id,[runId+key],runId,key,capturedAt',
    });
    this.version(4)
      .stores({
        jobs: '&id,&occurrenceKey,agentId,state,dueAt,leaseUntil,[state+dueAt]',
        scheduleCursors: '&agentId,nextDueAt',
        sendIntents: '&id,jobId,agentId,runId,state,createdAt,[jobId+state]',
        workflowRuns: '&id,workflowId,workflowRevision,state,updatedAt,[workflowId+state]',
        workflowOutputs: '&id,[runId+key],runId,key,capturedAt',
      })
      .upgrade(async (transaction) => {
        const now = new Date().toISOString();
        await transaction.table('workflowRuns').toCollection().modify((run: Record<string, unknown>) => {
          if (run.workflowSnapshot && run.workflowRevision) return;
          run.workflowRevision = 'legacy-unpinned';
          if (run.state === 'running') run.state = 'needs_review';
          run.lastError = 'Workflow run predates immutable definition pinning; automatic resume is unsafe.';
          run.updatedAt = now;
        });
      });
    this.version(5).stores({
      jobs: '&id,&occurrenceKey,agentId,state,dueAt,leaseUntil,[state+dueAt]',
      scheduleCursors: '&agentId,nextDueAt',
      sendIntents: '&id,jobId,agentId,runId,state,createdAt,[jobId+state]',
      workflowRuns: '&id,workflowId,workflowRevision,state,updatedAt,wakeAt,[workflowId+state],[state+wakeAt]',
      workflowOutputs: '&id,[runId+key],runId,key,capturedAt',
    });
    this.version(6).stores({
      jobs: '&id,&occurrenceKey,agentId,state,dueAt,leaseUntil,[state+dueAt]',
      scheduleCursors: '&agentId,nextDueAt',
      sendIntents: '&id,jobId,agentId,runId,state,createdAt,[jobId+state]',
      targetClaims: '&agentId,ownerKind,ownerId,operationId,updatedAt,[ownerKind+ownerId]',
      workflowRuns: '&id,workflowId,workflowRevision,state,updatedAt,wakeAt,[workflowId+state],[state+wakeAt]',
      workflowOutputs: '&id,[runId+key],runId,key,capturedAt',
    });
  }
}

export const db = new NikaDatabase();
