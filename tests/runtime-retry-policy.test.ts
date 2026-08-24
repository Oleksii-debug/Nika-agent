import { describe, expect, it } from 'vitest';
import { retryPolicyForContentCommand } from '../src/runtime';

describe('content command retry policy', () => {
  it('never retries irreversible send commands', () => {
    expect(retryPolicyForContentCommand({ type: 'send', prompt: 'hello' })).toBe('none');
  });

  it('allows bounded transport retry only for read-only commands', () => {
    expect(retryPolicyForContentCommand({ type: 'status' })).toBe('read_only');
    expect(retryPolicyForContentCommand({ type: 'captureLatest' })).toBe('read_only');
  });

  it('keeps the mutation/read boundary explicit for future command additions', () => {
    const sendPolicy = retryPolicyForContentCommand({ type: 'send', prompt: 'mutation' });
    const readPolicies = [
      retryPolicyForContentCommand({ type: 'status' }),
      retryPolicyForContentCommand({ type: 'captureLatest' }),
    ];
    expect(sendPolicy).not.toBe('read_only');
    expect(readPolicies).toEqual(['read_only', 'read_only']);
  });
});
