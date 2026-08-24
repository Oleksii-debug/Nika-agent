import { classifyChatSurface } from '../src/chatgpt-state';
import type { ContentCommand, ContentResult, PromptPresenceResult, StateEvidence } from '../src/types';

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

const SELECTOR_PROFILE_ID = 'chatgpt-web-2026-08-g10';

const SELECTORS = {
  stop: [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop"]',
    'button[aria-label*="Зупин"]',
    'button[aria-label*="Припин"]',
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
    'button[aria-label*="Відправ"]',
  ],
  assistantMessage: [
    '[data-message-author-role="assistant"]',
    'article [data-message-author-role="assistant"]',
  ],
  userMessage: [
    '[data-message-author-role="user"]',
    'article [data-message-author-role="user"]',
  ],
  login: [
    'a[href*="/auth/login"]',
    'button[data-testid*="login"]',
    'a[data-testid*="login"]',
  ],
  verification: [
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="captcha"]',
    'input[name="cf-turnstile-response"]',
    '[data-sitekey]',
    '[class*="turnstile"]',
  ],
  surfaceMessages: [
    '[role="alert"]',
    '[role="dialog"]',
    '[aria-live="assertive"]',
    '[data-testid*="toast"]',
    '[data-testid*="error"]',
  ],
} as const;

const RATE_LIMIT_PATTERNS = [
  /too many requests/i,
  /rate[ -]?limit/i,
  /try again later/i,
  /you(?:'|’)ve reached.*limit/i,
  /забагато (?:спроб|запитів)/i,
  /спробуйте пізніше/i,
  /досяг(?:ли|нуто).*ліміт/i,
  /ліміт (?:запитів|повідомлень)/i,
];

const ACCESS_DENIED_PATTERNS = [
  /access denied/i,
  /access.*unavailable/i,
  /not available in your (?:country|region)/i,
  /account (?:has been )?(?:deactivated|disabled|suspended)/i,
  /доступ заборонено/i,
  /недоступн(?:о|ий).*регіон/i,
  /обліковий запис.*(?:деактивовано|вимкнено|призупинено)/i,
];

const PAGE_ERROR_PATTERNS = [
  /something went wrong/i,
  /unable to load/i,
  /failed to load/i,
  /network error/i,
  /щось пішло не так/i,
  /не вдалося завантажити/i,
  /помилка мережі/i,
];

const VERIFICATION_TEXT_PATTERNS = [
  /verify (?:that )?you are human/i,
  /security check/i,
  /complete the challenge/i,
  /перевір(?:те|ка), що ви людина/i,
  /перевірка безпеки/i,
  /пройдіть перевірку/i,
];

const LOGIN_TEXT_PATTERNS = [
  /^log in$/i,
  /^sign in$/i,
  /^увійти$/i,
  /^вхід$/i,
];

const IDLE_CANDIDATE_DEBOUNCE_MS = 3_000;
let lastRelevantMutationAt = Date.now();
let idleCandidateTimer: ReturnType<typeof setTimeout> | undefined;

function startMutationTracking(): void {
  const observer = new MutationObserver((records) => {
    if (!records.some((record) => isRelevantMutation(record))) return;
    lastRelevantMutationAt = Date.now();
    if (idleCandidateTimer) clearTimeout(idleCandidateTimer);
    idleCandidateTimer = setTimeout(() => {
      const evidence = inspectState();
      if (evidence.state !== 'idle' || !evidence.composerEditable || evidence.stopControlPresent) return;
      void chrome.runtime.sendMessage({
        type: 'nika.chatIdleCandidate',
        url: location.href,
        mutationAgeMs: evidence.mutationAgeMs,
      }).catch(() => undefined);
    }, IDLE_CANDIDATE_DEBOUNCE_MS);
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
}

function isRelevantMutation(record: MutationRecord): boolean {
  const target = record.target instanceof Element ? record.target : record.target.parentElement;
  if (!target) return false;
  return Boolean(target.closest('[data-message-author-role], main, form, [role="alert"], [role="dialog"], [aria-live]'));
}

function isVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return true;
  if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function firstElement<T extends Element>(selectors: readonly string[]): T | null {
  for (const selector of selectors) {
    const elements = Array.from(document.querySelectorAll<T>(selector));
    const element = elements.find((candidate) => isVisible(candidate));
    if (element) return element;
  }
  return null;
}

function allElements<T extends Element>(selectors: readonly string[]): T[] {
  for (const selector of selectors) {
    const elements = Array.from(document.querySelectorAll<T>(selector)).filter((candidate) => isVisible(candidate));
    if (elements.length) return elements;
  }
  return [];
}

function textOf(element: Element | undefined): string {
  return normalizeText(element instanceof HTMLElement ? element.innerText : element?.textContent ?? '');
}

function firstMatchingText(elements: Element[], patterns: readonly RegExp[]): string | undefined {
  for (const element of elements) {
    const text = textOf(element);
    if (text && patterns.some((pattern) => pattern.test(text))) return text.slice(0, 500);
  }
  return undefined;
}

function hasTextControl(patterns: readonly RegExp[]): boolean {
  const controls = Array.from(document.querySelectorAll<HTMLElement>('button, a')).filter((element) => isVisible(element));
  return controls.some((element) => {
    const label = normalizeText(element.getAttribute('aria-label') ?? element.innerText ?? element.textContent ?? '');
    return patterns.some((pattern) => pattern.test(label));
  });
}

function inspectState(): StateEvidence {
  const stop = firstElement<HTMLButtonElement>(SELECTORS.stop);
  const composer = firstElement<HTMLElement>(SELECTORS.composer);
  const send = firstElement<HTMLButtonElement>(SELECTORS.send);
  const assistant = allElements<HTMLElement>(SELECTORS.assistantMessage);
  const users = allElements<HTMLElement>(SELECTORS.userMessage);
  const surfaceMessages = allElements<HTMLElement>(SELECTORS.surfaceMessages);

  const composerEditable = Boolean(
    composer &&
      !(composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
        ? composer.disabled || composer.readOnly
        : composer.getAttribute('contenteditable') === 'false'),
  );
  const mutationAgeMs = Date.now() - lastRelevantMutationAt;
  const stopControlPresent = Boolean(stop && !stop.disabled);
  const loginControlPresent = Boolean(firstElement(SELECTORS.login)) || hasTextControl(LOGIN_TEXT_PATTERNS);
  const verificationText = firstMatchingText(surfaceMessages, VERIFICATION_TEXT_PATTERNS);
  const verificationPresent = Boolean(firstElement(SELECTORS.verification) || verificationText);
  const rateLimitText = firstMatchingText(surfaceMessages, RATE_LIMIT_PATTERNS);
  const accessDeniedText = firstMatchingText(surfaceMessages, ACCESS_DENIED_PATTERNS);
  const pageErrorText = firstMatchingText(surfaceMessages, PAGE_ERROR_PATTERNS);

  const classificationInput = {
    url: location.href,
    readyState: document.readyState,
    stopControlPresent,
    composerPresent: Boolean(composer),
    composerEditable,
    loginControlPresent,
    verificationPresent,
    ...(rateLimitText ? { rateLimitText } : {}),
    ...(accessDeniedText ? { accessDeniedText } : {}),
    ...(pageErrorText ? { pageErrorText } : {}),
  };
  const classification = classifyChatSurface(classificationInput);
  const confidence = classification.state === 'idle' && mutationAgeMs < 500 ? 'medium' : classification.confidence;

  const evidence: StateEvidence = {
    state: classification.state,
    composerPresent: Boolean(composer),
    composerEditable,
    sendControlPresent: Boolean(send && !send.disabled),
    stopControlPresent,
    assistantTurnCount: assistant.length,
    userTurnCount: users.length,
    mutationAgeMs,
    confidence,
    selectorProfile: SELECTOR_PROFILE_ID,
    pageUrl: location.href,
  };
  const latestAssistantText = textOf(assistant.at(-1));
  const latestUserText = textOf(users.at(-1));
  if (latestAssistantText) evidence.latestAssistantText = latestAssistantText;
  if (latestUserText) evidence.latestUserText = latestUserText;
  if (classification.blockerKind) evidence.blockerKind = classification.blockerKind;
  if (classification.blockerText) evidence.visibleError = classification.blockerText;
  return evidence;
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
  if (evidence.state !== 'idle') return { ok: false, error: describeUnsafeState(evidence), evidence };
  if (!setComposerText(prompt)) return { ok: false, error: 'Composer not found or text insertion was not acknowledged.', evidence };

  const baseline = baselineUserTurnCount ?? evidence.userTurnCount;
  const expectedHash = promptHash ?? (await hashText(prompt));
  await sleep(120);

  const preSubmitEvidence = inspectState();
  if (preSubmitEvidence.state !== 'idle') {
    return { ok: false, error: `Chat became unsafe before submit: ${describeUnsafeState(preSubmitEvidence)}`, evidence: preSubmitEvidence };
  }

  const send = firstElement<HTMLButtonElement>(SELECTORS.send);
  if (send && !send.disabled) {
    send.click();
  } else {
    const editor = firstElement<HTMLElement>(SELECTORS.composer);
    if (!editor) return { ok: false, error: 'Composer disappeared before submit.', evidence: preSubmitEvidence };
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  }

  const verification = await waitForPromptPresence(expectedHash, baseline, 5_000);
  const result: ContentResult = {
    ok: true,
    sendStatus: verification.presence === 'confirmed' ? 'confirmed' : 'ambiguous',
    presence: verification.presence,
    matches: verification.matches,
    userTurnCount: verification.userTurnCount,
  };
  if (verification.detail) result.detail = verification.detail;
  return result;
}

function describeUnsafeState(evidence: StateEvidence): string {
  const detail = evidence.visibleError ? `: ${evidence.visibleError}` : '';
  return `Chat is not send-safe: ${evidence.state}${detail}.`;
}

async function verifyPrompt(promptHash: string, baselineUserTurnCount: number): Promise<ContentResult> {
  const evidence = inspectState();
  if (evidence.state === 'logged_out' || evidence.state === 'rate_limited' || evidence.state === 'verification_required' || evidence.state === 'blocked') {
    return { ok: false, error: describeUnsafeState(evidence), evidence };
  }
  const presence = await findPromptPresence(promptHash, baselineUserTurnCount);
  const result: ContentResult = {
    ok: true,
    presence: presence.presence,
    matches: presence.matches,
    userTurnCount: presence.userTurnCount,
  };
  if (presence.detail) result.detail = presence.detail;
  return result;
}

async function waitForPromptPresence(promptHash: string, baselineUserTurnCount: number, timeoutMs: number): Promise<PromptPresenceResult> {
  const deadline = Date.now() + timeoutMs;
  let result = await findPromptPresence(promptHash, baselineUserTurnCount);
  while (result.presence === 'absent' && Date.now() < deadline) {
    await sleep(150);
    result = await findPromptPresence(promptHash, baselineUserTurnCount);
  }
  return result;
}

async function findPromptPresence(promptHash: string, baselineUserTurnCount: number): Promise<PromptPresenceResult> {
  const users = allElements<HTMLElement>(SELECTORS.userMessage);
  const candidates = users.slice(Math.max(0, baselineUserTurnCount));
  let matches = 0;
  for (const candidate of candidates) {
    if ((await hashText(textOf(candidate))) === promptHash) matches += 1;
  }
  const result: PromptPresenceResult = {
    presence: matches === 1 ? 'confirmed' : matches > 1 ? 'ambiguous' : 'absent',
    matches,
    userTurnCount: users.length,
  };
  if (matches > 1) result.detail = 'Multiple matching user turns appeared after the persisted baseline.';
  return result;
}

function captureLatest(): ContentResult {
  const evidence = inspectState();
  if (evidence.state !== 'idle') return { ok: false, error: describeUnsafeState(evidence), evidence };
  const messages = allElements<HTMLElement>(SELECTORS.assistantMessage);
  const latest = messages.at(-1);
  const text = textOf(latest);
  if (!text) return { ok: false, error: 'Assistant response not found.', evidence };
  return { ok: true, text, evidence };
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
