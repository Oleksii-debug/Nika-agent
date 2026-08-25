import { expect, test, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHAT_URL = 'https://chatgpt.com/c/nika-browser-fixture';
const EXTENSION_PATH = resolve('.output/chrome-mv3');
const PROMPT = 'First line\nSecond line with   spacing\nThird line';

type EditorFixture = {
  name: string;
  attributes: string;
};

const EDITORS: EditorFixture[] = [
  { name: 'Lexical', attributes: 'data-lexical-editor="true"' },
  { name: 'ProseMirror', attributes: 'class="ProseMirror"' },
  { name: 'Draft.js', attributes: 'class="public-DraftEditor-content"' },
];

async function launchExtension(): Promise<{ context: BrowserContext; worker: Worker }> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'nika-pw-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  return { context, worker };
}

function fixtureHtml(editor: EditorFixture, rollback = false): string {
  return `<!doctype html>
<html><body>
  <main>
    <div id="prompt-textarea" contenteditable="true" ${editor.attributes}></div>
    <button data-testid="send-button" type="button">Send</button>
    <div id="turns"></div>
  </main>
  <script>
    window.__nikaSubmitCount = 0;
    const editor = document.querySelector('#prompt-textarea');
    const send = document.querySelector('[data-testid="send-button"]');
    ${rollback ? `editor.addEventListener('input', () => setTimeout(() => { editor.textContent = ''; }, 0));` : ''}
    send.addEventListener('click', () => {
      const submittedText = editor.textContent || '';
      window.__nikaSubmitCount += 1;
      const turn = document.createElement('div');
      turn.dataset.messageAuthorRole = 'user';
      turn.textContent = submittedText;
      document.querySelector('#turns').appendChild(turn);
      editor.textContent = '';
    });
  </script>
</body></html>`;
}

async function contentCommand(worker: Worker, command: Record<string, unknown>): Promise<Record<string, unknown>> {
  return worker.evaluate(async ({ url, command }) => {
    const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
    const tab = tabs.find((candidate) => candidate.url === url) ?? tabs[0];
    if (!tab?.id) {
      throw new Error(`Fixture tab not found for ${url}. candidates=${JSON.stringify(tabs.map(({ id, url: tabUrl }) => ({ id, url: tabUrl })))}`);
    }
    return chrome.tabs.sendMessage(tab.id, command);
  }, { url: CHAT_URL, command });
}

async function waitForContentScriptReady(worker: Worker): Promise<void> {
  await expect.poll(async () => {
    try {
      const result = await contentCommand(worker, { type: 'status' });
      return result.ok === true && result.state === 'idle';
    } catch {
      return false;
    }
  }, {
    timeout: 10_000,
    intervals: [50, 100, 200, 400],
    message: 'ChatGPT content script did not become idle on the fixture tab',
  }).toBe(true);
}

async function openFixture(context: BrowserContext, worker: Worker, editor: EditorFixture, rollback = false): Promise<Page> {
  const page = await context.newPage();
  await page.route('https://chatgpt.com/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixtureHtml(editor, rollback) });
  });
  await page.goto(CHAT_URL, { waitUntil: 'load' });
  await page.waitForSelector('#prompt-textarea');
  await waitForContentScriptReady(worker);
  return page;
}

for (const editor of EDITORS) {
  test(`${editor.name}: verified multiline composer write reaches one-shot submit`, async () => {
    const { context, worker } = await launchExtension();
    try {
      const page = await openFixture(context, worker, editor);
      const result = await contentCommand(worker, { type: 'send', prompt: PROMPT });

      expect(result, `unexpected SEND result: ${JSON.stringify(result)}`).toMatchObject({ ok: true, sendStatus: 'confirmed' });
      await expect.poll(() => page.evaluate(() => (window as typeof window & { __nikaSubmitCount?: number }).__nikaSubmitCount)).toBe(1);
      await expect(page.locator('[data-message-author-role="user"]')).toContainText('First line');
      await expect(page.locator('[data-message-author-role="user"]')).toContainText('Third line');
    } finally {
      await context.close();
    }
  });

  test(`${editor.name}: framework rollback blocks irreversible submit`, async () => {
    const { context, worker } = await launchExtension();
    try {
      const page = await openFixture(context, worker, editor, true);
      const result = await contentCommand(worker, { type: 'send', prompt: PROMPT });

      expect(result.ok, `unexpected rollback SEND result: ${JSON.stringify(result)}`).toBe(false);
      expect(String(result.error)).toContain('COMPOSER_WRITE_UNVERIFIED: EDITOR_REVERTED');
      expect(await page.evaluate(() => (window as typeof window & { __nikaSubmitCount?: number }).__nikaSubmitCount)).toBe(0);
      await expect(page.locator('[data-message-author-role="user"]')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
}
