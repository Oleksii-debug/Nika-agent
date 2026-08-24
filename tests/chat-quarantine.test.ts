import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db';
import {
  clearAgentQuarantine,
  getActiveAgentQuarantine,
  quarantineAgent,
  quarantineDisposition,
} from '../src/chat-quarantine';
import type { StateEvidence } from '../src/types';

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
});
