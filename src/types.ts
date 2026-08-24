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

export type RunSource = 'manual' | 'scheduled' | 'workflow';

export interface ExecutionLog {
  id: string;
  timestamp: string;
  agentId?: string | undefined;
  workflowId?: string | undefined;
  runId?: string | undefined;
  stepId?: string | undefined;
  source?: RunSource | undefined;
  level: 'info' | 'warning' | 'error';
  event: string;
  detail?: string | undefined;
}

export type ChatState =
  | 'idle'
  | 'generating'
  | 'blocked'
  | 'logged_out'
  | 'rate_limited'
  | 'verification_required'
  | 'navigation_pending'
  | 'unsupported'
  | 'unknown';

export type ChatBlockerKind = 'login' | 'rate_limit' | 'verification' | 'access' | 'page_error';

export type StateEvidence = {
  state: ChatState;
  composerPresent: boolean;
  composerEditable: boolean;
  sendControlPresent: boolean;
  stopControlPresent: boolean;
  assistantTurnCount: number;
  userTurnCount: number;
  latestAssistantText?: string;
  latestUserText?: string;
  mutationAgeMs?: number;
  visibleError?: string;
  blockerKind?: ChatBlockerKind;
  selectorProfile?: string;
  pageUrl?: string;
  confidence: 'high' | 'medium' | 'low';
};

export type PromptPresenceResult = {
  presence: 'confirmed' | 'absent' | 'ambiguous';
  matches: number;
  userTurnCount: number;
  detail?: string;
};

export type ContentCommand =
  | { type: 'status' }
  | { type: 'send'; prompt: string; promptHash?: string; baselineUserTurnCount?: number }
  | { type: 'verifyPrompt'; promptHash: string; baselineUserTurnCount: number }
  | { type: 'captureLatest' };

export type ContentResult =
  | {
      ok: true;
      state?: ChatState;
      evidence?: StateEvidence;
      text?: string;
      sendStatus?: 'confirmed' | 'ambiguous';
      userTurnCount?: number;
      presence?: PromptPresenceResult['presence'];
      matches?: number;
      detail?: string;
    }
  | { ok: false; error: string; evidence?: StateEvidence };
