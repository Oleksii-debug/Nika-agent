export type AgentRole = 'developer' | 'auditor' | 'coordinator' | 'researcher' | 'custom';

export type ScheduleSpec =
  | { kind: 'interval'; minutes: number; enabled: boolean }
  | { kind: 'once'; at: string; enabled: boolean }
  | { kind: 'manual'; enabled: boolean };

export type CompletionPolicy = {
  waitForIdle: boolean;
  timeoutMs: number;
  settleMs: number;
};

export interface ChatAgent {
  id: string;
  projectId: string;
  name: string;
  role: AgentRole;
  url: string;
  enabled: boolean;
  defaultPrompt: string;
  schedule: ScheduleSpec;
  completion: CompletionPolicy;
  tags: string[];
}

export type WorkflowStep =
  | { id: string; type: 'send'; agentId: string; prompt: string }
  | { id: string; type: 'wait_idle'; agentId: string; timeoutMs: number }
  | { id: string; type: 'capture'; agentId: string; outputKey: string }
  | { id: string; type: 'forward'; fromKey: string; agentId: string; prefix?: string }
  | { id: string; type: 'delay'; milliseconds: number };

export interface WorkflowDefinition {
  id: string;
  projectId: string;
  name: string;
  enabled: boolean;
  steps: WorkflowStep[];
}

export interface ExecutionMeta {
  runId?: string;
  stepId?: string;
  correlationId?: string;
}

export interface ExecutionLog {
  id: string;
  timestamp: string;
  agentId?: string;
  workflowId?: string;
  runId?: string;
  stepId?: string;
  correlationId?: string;
  level: 'info' | 'warning' | 'error';
  event: string;
  detail?: string;
}

export type RunState = 'running' | 'waiting' | 'completed' | 'failed' | 'needs_attention';
export type RunStepPhase = 'pending' | 'started' | 'completed';

export interface RunRecord {
  runId: string;
  workflowId: string;
  correlationId: string;
  currentStepIndex: number;
  currentStepId?: string;
  currentStepType?: WorkflowStep['type'];
  stepPhase: RunStepPhase;
  state: RunState;
  targetChatId?: string;
  context: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  wakeAt?: string;
  retryCount: number;
  lastError?: string;
}

export interface AgentLease {
  agentId: string;
  ownerRunId: string;
  fencingToken: string;
  acquiredAt: string;
  expiresAt: string;
}

export type ContentCommand =
  | { type: 'status' }
  | { type: 'send'; prompt: string }
  | { type: 'captureLatest' };

export type ContentResult =
  | { ok: true; state?: 'generating' | 'idle'; text?: string }
  | { ok: false; error: string };
