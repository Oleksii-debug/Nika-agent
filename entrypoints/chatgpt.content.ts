import type { ChatSnapshot, ContentCommand, ContentResult, LocatorCandidate } from '../src/types';
import { CHATGPT_SITE_PROFILE, locatorToSelector } from '../src/sites/chatgpt';

export default defineContentScript({
  matches: CHATGPT_SITE_PROFILE.matches,
  runAt: 'document_idle',
  main() {
    installNavigationEpochTracker();
    chrome.runtime.onMessage.addListener((message: ContentCommand, _sender, sendResponse) => {
      void handleCommand(message)
        .then(sendResponse)
        .catch((error) => sendResponse(failure('UNHANDLED_CONTENT_ERROR', error)));
      return true;
    });
  },
});

let navigationEpoch = 0;
let lastHref = location.href;

function installNavigationEpochTracker(): void {
  const update = () => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      navigationEpoch += 1;
    }
  };

  addEventListener('popstate', update, { passive: true });
  addEventListener('hashchange', update, { passive: true });
  addEventListener('pageshow', update, { passive: true });

  const observer = new MutationObserver(update);
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function queryFirst<T extends Element>(locators: readonly LocatorCandidate[]): T | null {
  for (const locator of locators) {
    try {
      const element = document.querySelector<T>(locatorToSelector(locator));
      if (element) return element;
    } catch {
      // A broken fallback must not prevent later locator candidates from being tried.
    }
  }
  return null;
}

function queryAll<T extends Element>(locators: readonly LocatorCandidate[]): T[] {
  for (const locator of locators) {
    try {
      const elements = Array.from(document.querySelectorAll<T>(locatorToSelector(locator)));
      if (elements.length) return elements;
    } catch {
      // Continue through the ordered locator recipe.
    }
  }
  return [];
}

function isGenerating(): boolean {
  return Boolean(queryFirst<HTMLButtonElement>(CHATGPT_SITE_PROFILE.locators.stop));
}

function getSnapshot(): ChatSnapshot {
  return {
    siteProfileId: CHATGPT_SITE_PROFILE.id,
    siteProfileVersion: CHATGPT_SITE_PROFILE.version,
    navigationEpoch,
    href: location.href,
    title: document.title,
    state: isGenerating() ? 'generating' : 'idle',
    composerAvailable: Boolean(queryFirst(CHATGPT_SITE_PROFILE.locators.composer)),
    sendAvailable: Boolean(queryFirst(CHATGPT_SITE_PROFILE.locators.send)),
    assistantMessageCount: queryAll(CHATGPT_SITE_PROFILE.locators.assistantMessage).length,
    userMessageCount: queryAll(CHATGPT_SITE_PROFILE.locators.userMessage).length,
  };
}

function setComposerText(prompt: string): boolean {
  const editor = queryFirst<HTMLElement>(CHATGPT_SITE_PROFILE.locators.composer);
  if (!editor) return false;

  editor.focus();
  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), 'value');
    descriptor?.set?.call(editor, prompt);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    return editor.value === prompt;
  }

  editor.textContent = prompt;
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
  return (editor.textContent ?? '').trim() === prompt.trim();
}

async function sendPrompt(prompt: string): Promise<ContentResult> {
  const normalized = prompt.trim();
  if (!normalized) return failure('EMPTY_PROMPT', 'Prompt is empty.');

  const before = getSnapshot();
  if (before.state === 'generating') {
    return failure('CHAT_BUSY', 'Chat is currently generating.', before);
  }
  if (!before.composerAvailable) {
    return failure('COMPOSER_NOT_FOUND', 'Composer not found.', before);
  }
  if (!setComposerText(normalized)) {
    return failure('COMPOSER_WRITE_FAILED', 'Composer did not accept the prompt.', getSnapshot());
  }

  await sleep(80);
  const send = queryFirst<HTMLButtonElement>(CHATGPT_SITE_PROFILE.locators.send);
  if (send && !send.disabled) {
    send.click();
  } else {
    const editor = queryFirst<HTMLElement>(CHATGPT_SITE_PROFILE.locators.composer);
    if (!editor) return failure('COMPOSER_DISAPPEARED', 'Composer disappeared before submit.', getSnapshot());
    editor.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
    }));
  }

  const after = await waitForSendPostcondition(before, 5_000);
  if (!after) {
    return failure(
      'SEND_POSTCONDITION_FAILED',
      'Submit action did not produce a new user message or generation state.',
      getSnapshot(),
    );
  }

  return {
    ok: true,
    snapshot: after,
    receipt: {
      navigationEpoch: after.navigationEpoch,
      userMessageCountBefore: before.userMessageCount,
      userMessageCountAfter: after.userMessageCount,
      submittedAt: new Date().toISOString(),
    },
  };
}

async function waitForSendPostcondition(before: ChatSnapshot, timeoutMs: number): Promise<ChatSnapshot | null> {
  const satisfied = (): ChatSnapshot | null => {
    const current = getSnapshot();
    if (current.navigationEpoch !== before.navigationEpoch) return null;
    if (current.userMessageCount > before.userMessageCount || current.state === 'generating') return current;
    return null;
  };

  const immediate = satisfied();
  if (immediate) return immediate;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);

    const observer = new MutationObserver(() => {
      const current = satisfied();
      if (!current) return;
      clearTimeout(timeout);
      observer.disconnect();
      resolve(current);
    });

    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  });
}

function captureLatest(): ContentResult {
  const messages = queryAll<HTMLElement>(CHATGPT_SITE_PROFILE.locators.assistantMessage);
  const latest = messages.at(-1);
  const text = latest?.innerText?.trim();
  if (!text) return failure('ASSISTANT_RESPONSE_NOT_FOUND', 'Assistant response not found.', getSnapshot());
  return { ok: true, text, snapshot: getSnapshot() };
}

async function handleCommand(command: ContentCommand): Promise<ContentResult> {
  switch (command.type) {
    case 'status': {
      const snapshot = getSnapshot();
      return { ok: true, state: snapshot.state, snapshot };
    }
    case 'snapshot':
      return { ok: true, snapshot: getSnapshot() };
    case 'send':
      return sendPrompt(command.prompt);
    case 'captureLatest':
      return captureLatest();
  }
}

function failure(code: string, error: unknown, snapshot?: ChatSnapshot): ContentResult {
  return {
    ok: false,
    code,
    error: error instanceof Error ? error.message : String(error),
    snapshot,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
