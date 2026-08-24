import { describe, expect, it } from 'vitest';
import { classifyChatSurface } from '../src/chatgpt-state';

const base = {
  url: 'https://chatgpt.com/c/test',
  readyState: 'complete' as DocumentReadyState,
  stopControlPresent: false,
  composerPresent: true,
  composerEditable: true,
  loginControlPresent: false,
  verificationPresent: false,
};

describe('classifyChatSurface', () => {
  it('classifies a normal editable chat as idle', () => {
    expect(classifyChatSurface(base)).toMatchObject({ state: 'idle', confidence: 'high' });
  });

  it('prioritizes generation over an otherwise editable surface', () => {
    expect(classifyChatSurface({ ...base, stopControlPresent: true })).toMatchObject({ state: 'generating' });
  });

  it('fails closed on login', () => {
    expect(classifyChatSurface({ ...base, composerPresent: false, composerEditable: false, loginControlPresent: true })).toMatchObject({
      state: 'logged_out',
      blockerKind: 'login',
    });
  });

  it('fails closed on rate limiting even when the composer remains visible', () => {
    expect(classifyChatSurface({ ...base, rateLimitText: 'Too many requests. Try again later.' })).toMatchObject({
      state: 'rate_limited',
      blockerKind: 'rate_limit',
    });
  });

  it('fails closed on verification before any other state', () => {
    expect(classifyChatSurface({ ...base, stopControlPresent: true, verificationPresent: true })).toMatchObject({
      state: 'verification_required',
      blockerKind: 'verification',
    });
  });

  it('classifies access denial as blocked', () => {
    expect(classifyChatSurface({ ...base, composerPresent: false, composerEditable: false, accessDeniedText: 'Access denied' })).toMatchObject({
      state: 'blocked',
      blockerKind: 'access',
    });
  });

  it('does not treat a still-loading document as idle', () => {
    expect(classifyChatSurface({ ...base, readyState: 'interactive' })).toMatchObject({ state: 'navigation_pending' });
  });

  it('rejects unsupported hosts', () => {
    expect(classifyChatSurface({ ...base, url: 'https://example.com/' })).toMatchObject({ state: 'unsupported' });
  });
});
