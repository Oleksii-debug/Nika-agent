import Dexie, { type Table } from 'dexie';

export type DurableJobState =
  | 'pending'
  | 'claimed'
  | 'running'
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

class NikaDatabase extends Dexie {
  jobs!: Table<DurableJob, string>;
  scheduleCursors!: Table<ScheduleCursor, string>;

  constructor() {
    super('nika-agent');
    this.version(1).stores({
      jobs: '&id,&occurrenceKey,agentId,state,dueAt,leaseUntil,[state+dueAt]',
      scheduleCursors: '&agentId,nextDueAt',
    });
  }
}

export const db = new NikaDatabase();
