import Dexie, { type Table } from 'dexie';

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

export type SendIntentState =
  | 'persisted'
  | 'dispatching'
  | 'confirmed'
  | 'absent'
  | 'ambiguous';

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

class NikaDatabase extends Dexie {
  jobs!: Table<DurableJob, string>;
  scheduleCursors!: Table<ScheduleCursor, string>;
  sendIntents!: Table<SendIntent, string>;

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
  }
}

export const db = new NikaDatabase();
