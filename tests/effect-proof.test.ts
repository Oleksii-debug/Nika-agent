import { describe, expect, it } from 'vitest';
import { evaluateSendEffectProof } from '../src/effect-proof';

describe('SEND effect proof', () => {
  it('confirms exactly one matching post-baseline user turn', () => {
    const proof = evaluateSendEffectProof({
      baselinePageUrl: 'https://chatgpt.com/c/alpha',
      observedPageUrl: 'https://chatgpt.com/c/alpha',
      baselineUserTurnCount: 4,
      observedUserTurnCount: 5,
      matches: 1,
      observedAt: '2026-08-25T06:00:00.000Z',
    });

    expect(proof.outcome).toBe('confirmed');
  });

  it('proves no effect only when transcript count is unchanged and no prompt matches', () => {
    const proof = evaluateSendEffectProof({
      baselinePageUrl: 'https://chatgpt.com/c/alpha',
      observedPageUrl: 'https://chatgpt.com/c/alpha',
      baselineUserTurnCount: 4,
      observedUserTurnCount: 4,
      matches: 0,
    });

    expect(proof.outcome).toBe('no_effect');
  });

  it('fails closed when another user turn appears without the expected fingerprint', () => {
    const proof = evaluateSendEffectProof({
      baselinePageUrl: 'https://chatgpt.com/c/alpha',
      observedPageUrl: 'https://chatgpt.com/c/alpha',
      baselineUserTurnCount: 4,
      observedUserTurnCount: 5,
      matches: 0,
    });

    expect(proof.outcome).toBe('ambiguous');
    expect(proof.detail).toContain('without a unique matching user turn');
  });

  it('fails closed when conversation identity changes after baseline', () => {
    const proof = evaluateSendEffectProof({
      baselinePageUrl: 'https://chatgpt.com/c/alpha',
      observedPageUrl: 'https://chatgpt.com/c/beta',
      baselineUserTurnCount: 4,
      observedUserTurnCount: 5,
      matches: 1,
    });

    expect(proof.outcome).toBe('ambiguous');
    expect(proof.detail).toContain('Conversation/navigation identity changed');
  });

  it('fails closed on transcript regression or duplicate matching turns', () => {
    expect(evaluateSendEffectProof({
      baselineUserTurnCount: 4,
      observedUserTurnCount: 3,
      matches: 0,
    }).outcome).toBe('ambiguous');

    expect(evaluateSendEffectProof({
      baselineUserTurnCount: 4,
      observedUserTurnCount: 6,
      matches: 2,
    }).outcome).toBe('ambiguous');
  });
});
