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
    'div#prompt-textarea[contenteditable="true"]',
    'div[contenteditable="true"][data-lexical-editor="true"]',
    'div.ProseMirror[contenteditable="true"]',
    'textarea[data-id="root"]',
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
  assistantBody: [
    '.markdown',
    '[data-message-author-role="assistant"] .markdown',
    '[class*="prose"]',
  ],
  userMessage: [
    '[data-message-author-role="user"]',
    'article [data-message-author-role="user"]',
  ],
} as const;

function firstElement<T extends Element>(selectors: readonly string[], root: ParentNode = document): T | null {
  for (const selector of selectors) {
    const element = root.querySelector<T>(selector);
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

function getComposer(): HTMLElement | null {
  const editor = firstElement<HTMLElement>(SELECTORS.composer);
  if (!editor || !isVisible(editor)) return null;
  return editor;
}

function isVisible(element: Element): boolean {
  const html = element as HTMLElement;
  const style = getComputedStyle(html);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  return html.getClientRects().length > 0;
}

function getComposerText(editor: HTMLElement): string {
  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    return editor.value.trim();
  }
  return (editor.innerText || editor.textContent || '').trim();
}

function setComposerText(prompt: string): boolean {
  const editor = getComposer();
  if (!editor) return false;

  editor.focus();

  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    const prototype = editor instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    descriptor?.set?.call(editor, prompt);
    editor.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return editor.value === prompt;
  }

  selectEditorContents(editor);
  const beforeInput = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    composed: true,
    inputType: 'insertText',
    data: prompt,
  });
  editor.dispatchEvent(beforeInput);

  let inserted = false;
  try {
    inserted = document.execCommand('insertText', false, prompt);
  } catch {
    inserted = false;
  }

  if (!inserted || getComposerText(editor) !== prompt.trim()) {
    editor.textContent = prompt;
  }

  editor.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    composed: true,
    inputType: 'insertText',
    data: prompt,
  }));

  return getComposerText(editor) === prompt.trim();
}

function selectEditorContents(editor: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
}

async function sendPrompt(prompt: string): Promise<ContentResult> {
  if (!prompt.trim()) return { ok: false, error: 'Prompt is empty.' };
  if (isGenerating()) return { ok: false, error: 'Chat is currently generating.' };

  const initialUserMessages = allElements<HTMLElement>(SELECTORS.userMessage).length;
  if (!setComposerText(prompt)) return { ok: false, error: 'Composer not found or text injection failed.' };

  await sleep(150);
  const editor = getComposer();
  if (!editor) return { ok: false, error: 'Composer disappeared before submit.' };

  const send = firstElement<HTMLButtonElement>(SELECTORS.send);
  if (send && isVisible(send) && !send.disabled) {
    send.click();
  } else {
    dispatchEnter(editor);
  }

  const submitted = await waitForSubmission(initialUserMessages, editor, 4_000);
  if (!submitted) {
    return { ok: false, error: 'Prompt submission could not be verified.' };
  }

  return { ok: true };
}

function dispatchEnter(editor: HTMLElement): void {
  const init: KeyboardEventInit = {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
  editor.dispatchEvent(new KeyboardEvent('keydown', init));
  editor.dispatchEvent(new KeyboardEvent('keypress', init));
  editor.dispatchEvent(new KeyboardEvent('keyup', init));
}

async function waitForSubmission(
  initialUserMessages: number,
  originalEditor: HTMLElement,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isGenerating()) return true;
    if (allElements<HTMLElement>(SELECTORS.userMessage).length > initialUserMessages) return true;

    const currentEditor = getComposer() ?? originalEditor;
    if (!getComposerText(currentEditor)) return true;
    await sleep(100);
  }
  return false;
}

function captureLatest(): ContentResult {
  const messages = allElements<HTMLElement>(SELECTORS.assistantMessage);
  const latest = messages.at(-1);
  if (!latest) return { ok: false, error: 'Assistant response not found.' };

  const body = firstElement<HTMLElement>(SELECTORS.assistantBody, latest);
  const text = (body?.innerText || latest.innerText || '').trim();
  if (!text) return { ok: false, error: 'Assistant response was empty.' };
  return { ok: true, text };
}

async function handleCommand(command: ContentCommand): Promise<ContentResult> {
  switch (command.type) {
    case 'status': {
      if (isGenerating()) return { ok: true, state: 'generating' };
      if (!getComposer()) return { ok: false, error: 'ChatGPT composer is not ready.' };
      return { ok: true, state: 'idle' };
    }
    case 'send':
      return sendPrompt(command.prompt);
    case 'captureLatest':
      return captureLatest();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
