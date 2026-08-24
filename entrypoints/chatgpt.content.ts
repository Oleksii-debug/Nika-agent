import {
  ADAPTER_VERSION,
  PROTOCOL_VERSION,
  SITE_PROFILE_VERSION,
  errorResult,
  parseBrowserCommand,
  successResult,
} from '../src/protocol';
import type { ContentCommand, ContentResult } from '../src/types';

export default defineContentScript({
  matches: ['https://chatgpt.com/*'],
  runAt: 'document_idle',
  main() {
    chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
      void handleUnknownCommand(message).then(sendResponse);
      return true;
    });
  },
});

const DOCUMENT_EPOCH = crypto.randomUUID();

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
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), 'value');
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

async function sendPrompt(commandId: string, prompt: string): Promise<ContentResult> {
  if (isGenerating()) return errorResult(commandId, 'CHAT_GENERATING', 'Chat is currently generating.');
  if (!setComposerText(prompt)) return errorResult(commandId, 'TARGET_UNAVAILABLE', 'Composer not found.');

  await sleep(120);
  const send = firstElement<HTMLButtonElement>(SELECTORS.send);
  if (send) {
    if (send.disabled) return errorResult(commandId, 'TARGET_NOT_ACTIONABLE', 'Send button is disabled.');
    send.click();
    return successResult(commandId);
  }

  const editor = firstElement<HTMLElement>(SELECTORS.composer);
  if (!editor) return errorResult(commandId, 'TARGET_UNAVAILABLE', 'Composer disappeared before submit.');
  editor.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
    }),
  );
  return successResult(commandId);
}

function captureLatest(commandId: string): ContentResult {
  const messages = allElements<HTMLElement>(SELECTORS.assistantMessage);
  const latest = messages.at(-1);
  const text = latest?.innerText?.trim();
  if (!text) return errorResult(commandId, 'EMPTY_RESPONSE', 'Assistant response not found.');
  return successResult(commandId, { text });
}

async function handleUnknownCommand(input: unknown): Promise<ContentResult> {
  const commandId = extractCommandId(input);
  const protocolVersion = extractProtocolVersion(input);
  if (protocolVersion !== undefined && protocolVersion !== PROTOCOL_VERSION) {
    return errorResult(commandId, 'PROTOCOL_VERSION_UNSUPPORTED', `Unsupported protocol version: ${protocolVersion}`);
  }

  const command = parseBrowserCommand(input);
  if (!command) return errorResult(commandId, 'INVALID_COMMAND', 'Invalid browser command payload.');

  try {
    return await handleCommand(command);
  } catch (error) {
    return errorResult(
      command.commandId,
      'INTERNAL_ERROR',
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function handleCommand(command: ContentCommand): Promise<ContentResult> {
  switch (command.type) {
    case 'status':
      return successResult(command.commandId, { state: isGenerating() ? 'generating' : 'idle' });
    case 'send':
      return sendPrompt(command.commandId, command.prompt);
    case 'captureLatest':
      return captureLatest(command.commandId);
    case 'runtime.health':
      return successResult(command.commandId, {
        health: {
          protocolVersion: PROTOCOL_VERSION,
          adapterVersion: ADAPTER_VERSION,
          siteProfileVersion: SITE_PROFILE_VERSION,
          documentEpoch: DOCUMENT_EPOCH,
          observedUrl: location.href,
          capabilities: ['READ', 'WRITE', 'OBSERVE'],
          state: isGenerating() ? 'generating' : 'idle',
        },
      });
  }
}

function extractCommandId(input: unknown): string {
  if (input && typeof input === 'object' && 'commandId' in input && typeof input.commandId === 'string') {
    return input.commandId;
  }
  return 'invalid';
}

function extractProtocolVersion(input: unknown): number | undefined {
  if (input && typeof input === 'object' && 'protocolVersion' in input && typeof input.protocolVersion === 'number') {
    return input.protocolVersion;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
