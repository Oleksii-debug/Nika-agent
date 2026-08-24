import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db';
import {
  clearAgentQuarantine,
  getActiveAgentQuarantine,
  quarantineAgent,
  quarantineDisposition,
} from '../src/chat-quarantine';
import type { ChatAgent, StateEvidence } from '../src/types';

let storedAgents: ChatAgent[] = [];

function agent(id: string, url: string): ChatAgent {
  return {
    id,
    projectId: 'default',
    name: id,
    role: 'developer',
    url,
    enabled: true,
    defaultPrompt: 'Continue',
    schedule: { kind: 'manual', enabled: true },
    completion: { waitForIdle: true, timeoutMs: 60_000, settleMs: 2_500 },
    tags: [],
  };
}

function evidence(blockerKind: NonNullable<StateEvidence['blockerKind']>, state: StateEvidence['state']): StateEvidence {
  return {
    state,
    blockerKind,
    composerPresent: false,
    composerEditable: false,
    sendControlPresent: false,
    stopControlPresent: false,
    assistantTurnCount: 0,
    userTurnCount: 0,
    visibleError: blockerKind,
    pageUrl: 'https://chatgpt.com/c/test',
    confidence: 'high',
  };
}

describe('durable chat quarantine', () => {
  beforeEach(async () => {
    storedAgents = [];
    (globalThis as typeof globalThis & { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: async () => ({ 'nika.agents': storedAgents }),
          set: async (value: Record<string, unknown>) => {
            if (Array.isArray(value['nika.agents'])) storedAgents = value['nika.agents'] as ChatAgent[];
          },
        },
      },
    };
    await db.agentQuarantines.clear();
  });

  it('requires manual recovery for login, verification, and access blockers', () => {
    expect(quarantineDisposition(evidence('login', 'logged_out'))?.mode).toBe('manual');
    expect(quarantineDisposition(evidence('verification', 'verification_required'))?.mode).toBe('manual');
    expect(quarantineDisposition(evidence('access', 'blocked'))?.mode).toBe('manual');
  });

  it('applies bounded cooldown to rate-limit and page errors', () => {
    expect(quarantineDisposition(evidence('rate_limit', 'rate_limited'))).toMatchObject({ mode: 'cooldown', cooldownMs: 3_600_000 });
    expect(quarantineDisposition(evidence('page_error', 'blocked'))).toMatchObject({ mode: 'cooldown', cooldownMs: 900_000 });
  });

  it('persists manual quarantine until explicitly cleared', async () => {
    const now = new Date('2026-08-24T08:00:00.000Z');
    await quarantineAgent('agent-login', evidence('login', 'logged_out'), now);

    expect(await getActiveAgentQuarantine('agent-login', new Date(now.getTime() + 24 * 60 * 60_000))).toMatchObject({
      mode: 'manual',
      blockerKind: 'login',
    });

    await clearAgentQuarantine('agent-login');
    expect(await getActiveAgentQuarantine('agent-login')).toBeUndefined();
  });

  it('automatically expires cooldown quarantine after resumeAt', async () => {
    const now = new Date('2026-08-24T08:00:00.000Z');
    const quarantine = await quarantineAgent('agent-rate', evidence('rate_limit', 'rate_limited'), now);
    expect(quarantine?.resumeAt).toBe('2026-08-24T09:00:00.000Z');
    expect(await getActiveAgentQuarantine('agent-rate', new Date('2026-08-24T08:59:59.000Z'))).toBeDefined();
    expect(await getActiveAgentQuarantine('agent-rate', new Date('2026-08-24T09:00:00.000Z'))).toBeUndefined();
    expect(await db.agentQuarantines.get('agent-rate')).toBeUndefined();
  });

  it('projects one physical target quarantine across URL aliases and clears them together', async () => {
    storedAgents = [
      agent('agent-a', 'https://chatgpt.com/c/shared'),
      agent('agent-b', 'https://chatgpt.com/c/shared/?model=gpt-5#latest'),
      agent('agent-c', 'https://chatgpt.com/c/other'),
    ];

    await quarantineAgent('agent-a', evidence('verification', 'verification_required'));

    expect(await getActiveAgentQuarantine('agent-b')).toMatchObject({
      agentId: 'agent-b',
      blockerKind: 'verification',
      mode: 'manual',
    });
    expect(await getActiveAgentQuarantine('agent-c')).toBeUndefined();
    expect(await db.agentQuarantines.get('agent-a')).toBeDefined();
    expect(await db.agentQuarantines.get('agent-b')).toBeDefined();

    await clearAgentQuarantine('agent-b');
    expect(await getActiveAgentQuarantine('agent-a')).toBeUndefined();
    expect(await db.agentQuarantines.get('agent-a')).toBeUndefined();
    expect(await db.agentQuarantines.get('agent-b')).toBeUndefined();
  });
});
