import type { ContentCommand, ContentResult } from '../src/types';

export default defineContentScript({
  matches: ['https://chatgpt.com/*'],
  runAt: 'document_idle',
  main() {
    chrome.runtime.onMessage.addListener((message: ContentCommand, _sender, sendResponse) => {
      void handleCommand(message).then(sendResponse);
      return true;
    });
  },
});

const SELECTORS = {
  stop: [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop"]',
    'button[aria-label*="Зупин"]',
  ],
  composer: [
    '#prompt-textarea',
    'textarea[data-id="root"]',
    'div[contenteditable="true"][data-lexical-editor="true"]',
    'textarea',
  ],
  send: [
    'button[data-testid="send-button"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="Надісл"]',
  ],
  assistantMessage: [
    '[data-message-author-role="assistant"]',
    'article [data-message-author-role="assistant"]',
  ],
} as const;

function firstElement<T extends Element>(selectors: readonly string[]): T | null {
  for (const selector of selectors) {
    const element = document.querySelector<T>(selector);
    if (element) return element;
  }
  return null;
}

function allElements<T extends Element>(selectors: readonly string[]): T[] {
  for (const selector of selectors) {
    const elements = Array.from(document.querySelectorAll<T>(selector));
    if (elements.length) return elements;
  }
  return [];
}

function isGenerating(): boolean {
  return Boolean(firstElement<HTMLButtonElement>(SELECTORS.stop));
}

function setComposerText(prompt: string): boolean {
  const editor = firstElement<HTMLElement>(SELECTORS.composer);
  if (!editor) return false;

  editor.focus();
  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(editor),
      'value',
    );
    descriptor?.set?.call(editor, prompt);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  editor.textContent = prompt;
  editor.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: prompt,
    }),
  );
  return true;
}

async function sendPrompt(prompt: string): Promise<ContentResult> {
  if (isGenerating()) return { ok: false, error: 'Chat is currently generating.' };
  if (!setComposerText(prompt)) return { ok: false, error: 'Composer not found.' };

  await sleep(120);
  const send = firstElement<HTMLButtonElement>(SELECTORS.send);
  if (send && !send.disabled) {
    send.click();
    return { ok: true };
  }

  const editor = firstElement<HTMLElement>(SELECTORS.composer);
  if (!editor) return { ok: false, error: 'Composer disappeared before submit.' };
  editor.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
    }),
  );
  return { ok: true };
}

function captureLatest(): ContentResult {
  const messages = allElements<HTMLElement>(SELECTORS.assistantMessage);
  const latest = messages.at(-1);
  const text = latest?.innerText?.trim();
  if (!text) return { ok: false, error: 'Assistant response not found.' };
  return { ok: true, text };
}

async function handleCommand(command: ContentCommand): Promise<ContentResult> {
  switch (command.type) {
    case 'status':
      return { ok: true, state: isGenerating() ? 'generating' : 'idle' };
    case 'send':
      return sendPrompt(command.prompt);
    case 'captureLatest':
      return captureLatest();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
