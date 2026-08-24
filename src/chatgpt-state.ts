import type { ChatState } from './types';

export type ChatBlockerKind = 'login' | 'rate_limit' | 'verification' | 'access' | 'page_error';

export type ChatSurfaceSignals = {
  url: string;
  readyState: DocumentReadyState;
  stopControlPresent: boolean;
  composerPresent: boolean;
  composerEditable: boolean;
  loginControlPresent: boolean;
  verificationPresent: boolean;
  rateLimitText?: string;
  accessDeniedText?: string;
  pageErrorText?: string;
};

export type ChatSurfaceClassification = {
  state: ChatState;
  confidence: 'high' | 'medium' | 'low';
  blockerKind?: ChatBlockerKind;
  blockerText?: string;
};

export function classifyChatSurface(signals: ChatSurfaceSignals): ChatSurfaceClassification {
  if (!isSupportedChatGptUrl(signals.url)) {
    return { state: 'unsupported', confidence: 'high' };
  }

  if (signals.verificationPresent) {
    return {
      state: 'verification_required',
      confidence: 'high',
      blockerKind: 'verification',
      blockerText: 'Human verification or anti-bot challenge detected.',
    };
  }

  if (signals.rateLimitText) {
    return {
      state: 'rate_limited',
      confidence: 'high',
      blockerKind: 'rate_limit',
      blockerText: signals.rateLimitText,
    };
  }

  if (signals.loginControlPresent && !signals.composerPresent) {
    return {
      state: 'logged_out',
      confidence: 'high',
      blockerKind: 'login',
      blockerText: 'ChatGPT authentication is required.',
    };
  }

  if (signals.accessDeniedText) {
    return {
      state: 'blocked',
      confidence: 'high',
      blockerKind: 'access',
      blockerText: signals.accessDeniedText,
    };
  }

  if (signals.pageErrorText && !signals.composerPresent) {
    return {
      state: 'blocked',
      confidence: 'medium',
      blockerKind: 'page_error',
      blockerText: signals.pageErrorText,
    };
  }

  if (signals.readyState !== 'complete') {
    return { state: 'navigation_pending', confidence: 'high' };
  }

  if (signals.stopControlPresent) {
    return { state: 'generating', confidence: 'high' };
  }

  if (signals.composerPresent && signals.composerEditable) {
    return { state: 'idle', confidence: 'high' };
  }

  return { state: 'unknown', confidence: 'low' };
}

export function isSupportedChatGptUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'chatgpt.com' || url.hostname.endsWith('.chatgpt.com'));
  } catch {
    return false;
  }
}
