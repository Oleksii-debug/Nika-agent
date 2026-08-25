import { describe, expect, it } from 'vitest';
import { describeRouteMismatch, getChatRouteIdentity, sameChatRoute } from '../src/route-identity';

describe('ChatGPT route identity', () => {
  it('treats query/hash UI state as the same physical conversation', () => {
    expect(sameChatRoute(
      'https://chatgpt.com/c/abc-123',
      'https://chatgpt.com/c/abc-123/?model=gpt-5#composer',
    )).toBe(true);
  });

  it('fails closed when the conversation pathname changes', () => {
    expect(sameChatRoute(
      'https://chatgpt.com/c/abc-123',
      'https://chatgpt.com/c/other-conversation',
    )).toBe(false);
  });

  it('does not accept non-ChatGPT or non-https mutation targets', () => {
    expect(getChatRouteIdentity('http://chatgpt.com/c/abc')).toBeNull();
    expect(getChatRouteIdentity('https://example.com/c/abc')).toBeNull();
  });

  it('normalizes duplicate and trailing slashes deterministically', () => {
    expect(getChatRouteIdentity('https://chatgpt.com//c//abc///')?.key)
      .toBe('https://chatgpt.com/c/abc');
  });

  it('produces an operator-diagnostic mismatch without exposing transient query state', () => {
    expect(describeRouteMismatch(
      'https://chatgpt.com/c/expected?model=x',
      'https://chatgpt.com/c/observed?model=y',
    )).toBe('ROUTE_IDENTITY_MISMATCH: expected=https://chatgpt.com/c/expected observed=https://chatgpt.com/c/observed');
  });
});
