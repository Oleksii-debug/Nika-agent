import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAgent, ContentCommand, ContentResult } from './types';

const appendLog = vi.hoisted(() => vi.fn());
vi.mock('./storage', () => ({ appendLog }));

import { retryPolicyForContentCommand, sendToAgent } from './runtime';

const agent: ChatAgent = {
  id: 'developer',
  projectId: 'project',
  name: 'Developer',
  role: 'developer',
  url: 'https://chatgpt.com/c/developer',
  enabled: true,
  defaultPrompt: '',
  schedule: { kind: 'manual', enabled: true },
  completion: { waitForIdle: false, timeoutMs: 60_000, settleMs: 1_000 },
  tags: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  appendLog.mockResolvedValue(undefined);
});

describe('content command retry policy', () => {
  it('never retries irreversible send while keeping bounded retry for read-only commands', () => {
    expect(retryPolicyForContentCommand({ type: 'send', prompt: 'once' })).toBe('none');
    expect(retryPolicyForContentCommand({ type: 'status' })).toBe('read_only');
    expect(retryPolicyForContentCommand({ type: 'captureLatest' })).toBe('read_only');
  });
});

describe('agent execution queue', () => {
  it('does not start a second operation for the same agent until the first finishes', async () => {
    let releaseFirst!: (value: ContentResult) => void;
    const firstResult = new Promise<ContentResult>((resolve) => {
      releaseFirst = resolve;
    });

    const sendMessage = vi
      .fn<(tabId: number, command: ContentCommand) => Promise<ContentResult>>()
      .mockImplementationOnce(async () => firstResult)
      .mockResolvedValue({ ok: true });

    vi.stubGlobal('chrome', {
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 7, url: agent.url }]),
        create: vi.fn(),
        sendMessage,
      },
    });

    const first = sendToAgent(agent, 'first');
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    const second = sendToAgent(agent, 'second');
    await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    releaseFirst({ ok: true });
    await first;
    await second;

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0]?.[1]).toEqual({ type: 'send', prompt: 'first' });
    expect(sendMessage.mock.calls[1]?.[1]).toEqual({ type: 'send', prompt: 'second' });
  });
});
