import type { ContentCommand, ContentResult, StateEvidence } from '../src/types';

export default defineContentScript({
  matches: ['https://chatgpt.com/*'],
  runAt: 'document_idle',
  main() {
    startMutationTracking();
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
  userMessage: [
    '[data-message-author-role="user"]',
    'article [data-message-author-role="user"]',
  ],
} as const;

let lastRelevantMutationAt = Date.now();

function startMutationTracking(): void {
  const observer = new MutationObserver((records) => {
    if (records.some((record) => isRelevantMutation(record))) lastRelevantMutationAt = Date.now();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
}

function isRelevantMutation(record: MutationRecord): boolean {
  const target = record.target instanceof Element ? record.target : record.target.parentElement;
  if (!target) return false;
  return Boolean(target.closest('[data-message-author-role], main, form'));
}

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

function textOf(element: Element | undefined): string {
  return (element instanceof HTMLElement ? element.innerText : element?.textContent ?? '').trim();
}

function inspectState(): StateEvidence {
  const stop = firstElement<HTMLButtonElement>(SELECTORS.stop);
  const composer = firstElement<HTMLElement>(SELECTORS.composer);
  const send = firstElement<HTMLButtonElement>(SELECTORS.send);
  const assistant = allElements<HTMLElement>(SELECTORS.assistantMessage);
  const users = allElements<HTMLElement>(SELECTORS.userMessage);
  const composerEditable = Boolean(
    composer &&
      !(composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement ? composer.disabled || composer.readOnly : composer.getAttribute('contenteditable') === 'false'),
  );
  const mutationAgeMs = Date.now() - lastRelevantMutationAt;
  const stopControlPresent = Boolean(stop && !stop.disabled);

  const state = stopControlPresent
    ? 'generating'
    : composer && composerEditable
      ? 'idle'
      : document.readyState !== 'complete'
        ? 'navigation_pending'
        : 'unknown';

  return {
    state,
    composerPresent: Boolean(composer),
    composerEditable,
    sendControlPresent: Boolean(send),
    stopControlPresent,
    assistantTurnCount: assistant.length,
    userTurnCount: users.length,
    latestAssistantText: textOf(assistant.at(-1)) || undefined,
    latestUserText: textOf(users.at(-1)) || undefined,
    mutationAgeMs,
    confidence: state === 'idle' && mutationAgeMs < 500 ? 'medium' : state === 'unknown' ? 'low' : 'high',
  };
}

function setComposerText(prompt: string): boolean {
  const editor = firstElement<HTMLElement>(SELECTORS.composer);
  if (!editor) return false;

  editor.focus({ preventScroll: true });
  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), 'value');
    descriptor?.set?.call(editor, prompt);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    return editor.value === prompt;
  }

  editor.textContent = prompt;
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
  return normalizeText(editor.innerText || editor.textContent || '') === normalizeText(prompt);
}

async function sendPrompt(prompt: string, promptHash?: string, baselineUserTurnCount?: number): Promise<ContentResult> {
  const evidence = inspectState();
  if (evidence.state !== 'idle') return { ok: false, error: `Chat is not send-safe: ${evidence.state}.`, evidence };
  if (!setComposerText(prompt)) return { ok: false, error: 'Composer not found or text insertion was not acknowledged.', evidence };

  const baseline = baselineUserTurnCount ?? evidence.userTurnCount;
  const expectedHash = promptHash ?? (await hashText(prompt));
  await sleep(120);

  const send = firstElement<HTMLButtonElement>(SELECTORS.send);
  if (send && !send.disabled) {
    send.click();
  } else {
    const editor = firstElement<HTMLElement>(SELECTORS.composer);
    if (!editor) return { ok: false, error: 'Composer disappeared before submit.' };
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  }

  const verification = await waitForPromptPresence(expectedHash, baseline, 5_000);
  return {
    ok: true,
    sendStatus: verification.presence === 'confirmed' ? 'confirmed' : 'ambiguous',
    presence: verification.presence,
    matches: verification.matches,
    userTurnCount: verification.userTurnCount,
    detail: verification.detail,
  };
}

async function verifyPrompt(promptHash: string, baselineUserTurnCount: number): Promise<ContentResult> {
  const result = await findPromptPresence(promptHash, baselineUserTurnCount);
  return { ok: true, presence: result.presence, matches: result.matches, userTurnCount: result.userTurnCount, detail: result.detail };
}

async function waitForPromptPresence(promptHash: string, baselineUserTurnCount: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let result = await findPromptPresence(promptHash, baselineUserTurnCount);
  while (result.presence === 'absent' && Date.now() < deadline) {
    await sleep(150);
    result = await findPromptPresence(promptHash, baselineUserTurnCount);
  }
  return result;
}

async function findPromptPresence(promptHash: string, baselineUserTurnCount: number) {
  const users = allElements<HTMLElement>(SELECTORS.userMessage);
  const candidates = users.slice(Math.max(0, baselineUserTurnCount));
  let matches = 0;
  for (const candidate of candidates) {
    if ((await hashText(textOf(candidate))) === promptHash) matches += 1;
  }
  return {
    presence: matches === 1 ? 'confirmed' as const : matches > 1 ? 'ambiguous' as const : 'absent' as const,
    matches,
    userTurnCount: users.length,
    detail: matches > 1 ? 'Multiple matching user turns appeared after the persisted baseline.' : undefined,
  };
}

function captureLatest(): ContentResult {
  const messages = allElements<HTMLElement>(SELECTORS.assistantMessage);
  const latest = messages.at(-1);
  const text = textOf(latest);
  if (!text) return { ok: false, error: 'Assistant response not found.' };
  return { ok: true, text };
}

async function handleCommand(command: ContentCommand): Promise<ContentResult> {
  switch (command.type) {
    case 'status': {
      const evidence = inspectState();
      return { ok: true, state: evidence.state, evidence };
    }
    case 'send':
      return sendPrompt(command.prompt, command.promptHash, command.baselineUserTurnCount);
    case 'verifyPrompt':
      return verifyPrompt(command.promptHash, command.baselineUserTurnCount);
    case 'captureLatest':
      return captureLatest();
  }
}

function normalizeText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

async function hashText(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeText(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
