# Reuse Research

## Decision: WXT

Use WXT as the extension framework rather than hand-maintaining Manifest V3 boilerplate.

Why:
- MV3 support;
- TypeScript-first workflow;
- file-based entrypoints;
- Chrome/Edge and broader browser targets;
- dev reload/build/zip tooling;
- MIT license.

References:
- https://github.com/wxt-dev/wxt
- https://wxt.dev/

## Reference implementation: Dichrome

Dichrome is a recent Chromium extension that drives a signed-in ChatGPT web session without the OpenAI API. It validates the central Nika Agent product assumption: UI-driven ChatGPT integration can remain local to the user's browser session.

Reference:
- https://github.com/SillySerpent/Dichrome

License note: Dichrome is Apache-2.0. Nika Agent should study architecture and behavior; copying source requires preserving Apache-2.0 obligations.

## Reference implementation: browser automation prompt/response loop

The project below demonstrates the same core operational loop needed by Nika Agent: navigate to ChatGPT, submit a prompt, poll for completion and extract/copy the response.

Reference:
- https://github.com/chrisliu298/chatgpt

## Reference implementation: Nanobrowser

Nanobrowser demonstrates that substantial browser automation can live in an open-source Chrome extension with a multi-agent architecture. Nika Agent is narrower: it orchestrates already-created ChatGPT chats and deterministic workflows rather than using paid model APIs for browser planning.

Reference:
- https://github.com/nanobrowser

## Reuse policy

Prefer stable browser APIs and framework primitives before importing large automation stacks.

Adopt directly when useful:
- WXT build/entrypoint conventions;
- Chrome `alarms`, `tabs`, `storage` and content-script messaging APIs;
- native HTML controls for accessibility.

Study but do not vendor wholesale yet:
- Dichrome ChatGPT UI integration patterns;
- Nanobrowser multi-agent architecture;
- generic Playwright/Puppeteer code, because those primarily control an external browser process and are not necessary for the first in-browser architecture.

## Selector strategy

ChatGPT is not a public automation API and its DOM can change. Therefore selectors must remain isolated in the content adapter and use multiple semantic fallbacks (`data-testid`, `aria-label`, roles/contenteditable) rather than positional CSS selectors.
