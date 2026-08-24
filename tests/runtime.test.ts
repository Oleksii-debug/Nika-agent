import { describe, expect, it } from 'vitest';
import { withAgentLease } from '../src/runtime';

describe('withAgentLease', () => {
  it('serializes operations for the same agent', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withAgentLease('agent-a', async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
    });

    await Promise.resolve();

    const second = withAgentLease('agent-a', async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ]);
  });

  it('does not block different agents behind each other', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withAgentLease('agent-a', async () => {
      events.push('a:start');
      await firstGate;
      events.push('a:end');
    });

    const second = withAgentLease('agent-b', async () => {
      events.push('b:start');
      events.push('b:end');
    });

    await second;
    expect(events).toContain('b:end');
    expect(events).not.toContain('a:end');

    releaseFirst();
    await first;
  });

  it('releases the queue after a failed operation', async () => {
    await expect(
      withAgentLease('agent-a', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await expect(withAgentLease('agent-a', async () => 'ok')).resolves.toBe('ok');
  });
});
