import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureAgentResponse, sendToAgent, waitForAgentIdle } from '../src/runtime';
import type { ChatAgent, ContentCommand } from '../src/types';

const agent: ChatAgent = {
  id: 'agent-1',
  projectId: 'project-1',
  name: 'Developer',
  role: 'developer',
  url: 'https://chatgpt.com/c/test-chat',
  enabled: true,
  defaultPrompt: 'Continue.',
  schedule: { kind: 'manual', enabled: false },
  completion: { waitForIdle: true, timeoutMs: 10_000, settleMs: 0 },
  tags: [],
};

type ChromeHarness = {
  commands: ContentCommand[];
  sendMessage: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
};

function installChromeHarness(
  sendImplementation: (command: ContentCommand) => unknown | Promise<unknown>,
): ChromeHarness {
  const commands: ContentCommand[] = [];
  const sendMessage = vi.fn(async (_tabId: number, command: ContentCommand) => {
    commands.push(command);
    return await sendImplementation(command);
  });
  const reload = vi.fn(async () => undefined);

  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(async () => [{ id: 7, url: agent.url, status: 'complete' }]),
      create: vi.fn(),
      get: vi.fn(async () => ({ id: 7, url: agent.url, status: 'complete' })),
      reload,
      sendMessage,
      onUpdated: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
      },
    },
  });

  return { commands, sendMessage, reload };
}

describe('runtime safety semantics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('waitForAgentIdle checks status without capturing a response', async () => {
    const harness = installChromeHarness((command) => {
      if (command.type === 'status') return { ok: true, state: 'idle' };
      throw new Error(`Unexpected command: ${command.type}`);
    });

    await waitForAgentIdle(agent, 2_000, { runId: 'run-1', stepId: 'wait-1' });

    expect(harness.commands).toEqual([{ type: 'status' }]);
    expect(harness.commands.some((command) => command.type === 'captureLatest')).toBe(false);
  });

  it('does not retry an ambiguous side-effecting send transport failure', async () => {
    const harness = installChromeHarness((command) => {
      if (command.type === 'status') return { ok: true, state: 'idle' };
      if (command.type === 'send') throw new Error('message port disconnected');
      return { ok: true };
    });

    await expect(sendToAgent({ ...agent, completion: { ...agent.completion, waitForIdle: false } }, 'Ship it')).rejects.toThrow(
      'message port disconnected',
    );

    expect(harness.commands.filter((command) => command.type === 'send')).toHaveLength(1);
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it('bounds retries for safe capture transport failures and terminates', async () => {
    const harness = installChromeHarness((command) => {
      if (command.type === 'status') return { ok: true, state: 'idle' };
      if (command.type === 'captureLatest') throw new Error('content script unavailable');
      return { ok: true };
    });

    const capture = captureAgentResponse(agent);
    const rejection = expect(capture).rejects.toThrow('content script unavailable');
    await vi.runAllTimersAsync();
    await rejection;

    expect(harness.commands.filter((command) => command.type === 'captureLatest')).toHaveLength(3);
    expect(harness.reload).toHaveBeenCalledTimes(2);
  });
});
