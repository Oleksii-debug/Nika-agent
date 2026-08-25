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

export interface ExecutionProvenance {
  runId?: string;
  stepId?: string;
}

export interface ExecutionLog {
  id: string;
  timestamp: string;
  agentId?: string;
  workflowId?: string;
  runId?: string;
  stepId?: string;
  level: 'info' | 'warning' | 'error';
  event: string;
  detail?: string;
}

export type LocatorStrategy = 'testid' | 'aria' | 'css';

export interface LocatorCandidate {
  strategy: LocatorStrategy;
  value: string;
  confidence: 'primary' | 'fallback';
}

export interface SiteProfile {
  id: string;
  version: number;
  matches: string[];
  locators: {
    composer: LocatorCandidate[];
    send: LocatorCandidate[];
    stop: LocatorCandidate[];
    assistantMessage: LocatorCandidate[];
    userMessage: LocatorCandidate[];
  };
}

export interface ChatSnapshot {
  siteProfileId: string;
  siteProfileVersion: number;
  navigationEpoch: number;
  href: string;
  title: string;
  state: 'generating' | 'idle';
  composerAvailable: boolean;
  sendAvailable: boolean;
  assistantMessageCount: number;
  userMessageCount: number;
}

export type SendReceipt = {
  navigationEpoch: number;
  userMessageCountBefore: number;
  userMessageCountAfter: number;
  submittedAt: string;
};

export type ContentCommand =
  | { type: 'status' }
  | { type: 'snapshot' }
  | { type: 'send'; prompt: string }
  | { type: 'captureLatest' };

export type ContentResult =
  | { ok: true; state?: 'generating' | 'idle'; text?: string; snapshot?: ChatSnapshot; receipt?: SendReceipt }
  | { ok: false; error: string; code?: string; snapshot?: ChatSnapshot };
