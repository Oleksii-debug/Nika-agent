import type { LocatorCandidate, SiteProfile } from '../types';

export const CHATGPT_SITE_PROFILE: SiteProfile = {
  id: 'chatgpt-web',
  version: 1,
  matches: ['https://chatgpt.com/*'],
  locators: {
    stop: [
      { strategy: 'testid', value: 'stop-button', confidence: 'primary' },
      { strategy: 'aria', value: 'Stop', confidence: 'fallback' },
      { strategy: 'aria', value: 'Зупин', confidence: 'fallback' },
    ],
    composer: [
      { strategy: 'css', value: '#prompt-textarea', confidence: 'primary' },
      { strategy: 'css', value: 'textarea[data-id="root"]', confidence: 'fallback' },
      { strategy: 'css', value: 'div[contenteditable="true"][data-lexical-editor="true"]', confidence: 'fallback' },
    ],
    send: [
      { strategy: 'testid', value: 'send-button', confidence: 'primary' },
      { strategy: 'aria', value: 'Send', confidence: 'fallback' },
      { strategy: 'aria', value: 'Надісл', confidence: 'fallback' },
    ],
    assistantMessage: [
      { strategy: 'css', value: '[data-message-author-role="assistant"]', confidence: 'primary' },
      { strategy: 'css', value: 'article [data-message-author-role="assistant"]', confidence: 'fallback' },
    ],
    userMessage: [
      { strategy: 'css', value: '[data-message-author-role="user"]', confidence: 'primary' },
      { strategy: 'css', value: 'article [data-message-author-role="user"]', confidence: 'fallback' },
    ],
  },
};

export function locatorToSelector(locator: LocatorCandidate): string {
  switch (locator.strategy) {
    case 'testid':
      return `[data-testid="${cssEscape(locator.value)}"]`;
    case 'aria':
      return `[aria-label*="${cssEscape(locator.value)}"]`;
    case 'css':
      return locator.value;
  }
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}
