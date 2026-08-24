# Nika-agent: ChatGPT-specific adapter reuse and validation

Date: 2026-08-24

## Purpose

This cycle narrows research from generic browser automation to the site-specific `ChatGPTAdapter` layer. The goal is to determine whether existing open-source ChatGPT browser libraries can safely reduce selector/composer/response-handling work, and which patterns should be adopted without weakening Nika-agent's durability, idempotency, user-collision protection, evidence or accessibility contracts.

## Current Nika-agent baseline

The current `entrypoints/chatgpt.content.ts` already has a useful MVP:

- ChatGPT-only content script;
- selector fallbacks for Stop, composer, Send and assistant messages;
- `status`, `send` and `captureLatest` commands;
- Ukrainian/English aria-label fallbacks;
- Enter fallback if Send cannot be clicked.

However, this layer is still optimistic:

1. `isGenerating()` is equivalent to `Stop button exists`.
2. `sendPrompt()` returns success immediately after `.click()` or dispatched Enter, with no postcondition proving the exact user message appeared or generation began.
3. `setComposerText()` writes `textContent` directly for contenteditable/Lexical editors; React/Lexical compatibility is not independently validated.
4. `captureLatest()` uses `innerText` of the last assistant node without a durable response identity or freshness check.
5. There is no explicit login/rate-limit/error extraction in the content layer.
6. There is no stable/quiet-window check before response capture.
7. There is no check that the composer already contains user-authored text before automation overwrites it.

These are expected MVP gaps, but they should be closed before scaling to tens of chats.

## New high-value reference: `@kudoai/chatgpt.js`

Project/package:

- npm: https://www.npmjs.com/package/@kudoai/chatgpt.js
- current repository location: https://gitlab.com/kudoai/chatgpt-js
- archived GitHub mirror: https://github.com/KudoAI/chatgpt.js
- license: MIT

As of 2026-08-24 npm reports version `4.15.7`, published two days earlier. The GitHub repository was archived on 2026-08-10 because the project moved to GitLab; archival is therefore not evidence that the package is abandoned.

### Relevant browser APIs already implemented

The library exposes ChatGPT-specific DOM helpers including:

- `getChatBox()`;
- `getChatInput()`;
- `getSendButton()`;
- `getStopButton()`;
- `getContinueButton()`;
- `getLoginButton()`;
- `getErrorMsg()`;
- `getLastPrompt()`;
- `getLastResponse()`;
- `isIdle()`;
- `isTyping()`;
- `send()`;
- `stop()` / `response.stopGenerating()`;
- `response.getFromDOM()`;
- `response.getLast()`;
- `response.continue()`;
- `isLoaded()`.

It also provides a Manifest V3 Chrome starter/import pattern.

### Why this matters

This is the first mature, ChatGPT-specific MIT library found in the research that overlaps directly with Nika-agent's `ChatGPTAdapter` rather than merely generic browser automation.

It contains years of accumulated selector churn. Its recent release history demonstrates that ChatGPT selector breakage is a real maintenance burden: for example v4.15.3 updated conversation/reply selectors specifically to repair `code.isIdle()`, `exportChat()` and `response.getFromDOM()`. That is useful evidence for Nika-agent's architecture: all ChatGPT selectors must remain isolated in one replaceable adapter, and adapter health needs explicit tests.

### Recommendation: reference + compatibility oracle first, not hard runtime dependency

Do **not** immediately make `@kudoai/chatgpt.js` an authoritative runtime dependency.

Reasons:

1. Nika-agent needs stronger action semantics than a convenience DOM library: durable identity, preconditions, postconditions, evidence, mutation leases, fencing, user-collision protection and circuit breakers remain Nika responsibilities.
2. A generic library may change selector semantics independently of Nika's release cadence.
3. Nika needs a deliberately small permission/surface boundary; importing a broad ChatGPT utility library should not implicitly expand what workflows may do.
4. We need independent evidence that its `send()`/`isIdle()` behavior matches current ChatGPT UI variants and Ukrainian UI before trusting it as production authority.

Recommended first use:

- inspect/adapt its selector strategies under MIT terms;
- use it as an optional test oracle in development fixtures/manual browser proofs;
- compare Nika's `getComposer`, `detectState`, `getLatestResponse`, error detection and idle detection against it;
- selectively reuse small MIT-licensed patterns only after code-level review and attribution/license preservation.

If later testing shows its DOM helpers are materially more resilient than our own and bundle/compatibility costs are acceptable, wrap it behind `ChatGPTAdapter` rather than letting workflows call it directly.

## ChatGPT Auto-Continue

Project: https://github.com/adamlui/chatgpt-auto-continue

This extension/userscript automatically continues cut-off ChatGPT responses and depends on `chatgpt.js`.

Value to Nika-agent:

- proof that a narrow ChatGPT-specific content automation can survive as a browser extension/userscript;
- useful reference for detecting a `Continue generating` state;
- useful for testing the distinction between `idle`, `cut_off_but_continuable`, and genuinely `completed`.

Do not merge its behavior into the core definition of `idle`: a cut-off response with a Continue control is terminal for one generation step but may not be terminal for the intended workflow.

Recommended explicit ChatGPT state extension:

- `LOADING`
- `IDLE`
- `GENERATING`
- `CONTINUABLE`
- `ERROR`
- `LOGIN_REQUIRED`
- `RATE_LIMITED`
- `BLOCKED_BY_USER`
- `UNKNOWN`

`WAIT_FOR_IDLE` should normally accept only a stable `IDLE` result, while a workflow may separately opt into `AUTO_CONTINUE_RESPONSE` for `CONTINUABLE`.

## `chrome-chatgpt-autosend`

Project: https://github.com/amxv/chrome-chatgpt-autosend
License: Apache-2.0

This is a tiny current ChatGPT autosend extension. It opens ChatGPT with prompt data in the URL, waits for the composer, submits, and stores a per-navigation marker in `sessionStorage` to avoid duplicate submission. It also keeps several send-button selectors plus an Enter fallback.

The codebase is small and not a mature general engine, but it validates two useful Nika patterns:

1. site-specific autosend should have a navigation/run dedupe marker;
2. submit should support a primary semantic control and a bounded fallback.

Nika must implement these more durably through its own idempotency ledger rather than `sessionStorage`, because Nika must survive browser/service-worker recovery and coordinate multiple workflows.

## New adapter design recommendation

The generic `BrowserTransport` should remain unaware of ChatGPT-specific selectors. Introduce a concrete site contract such as:

```ts
interface ChatGPTAdapter {
  inspect(): Promise<ChatGPTSnapshot>;
  detectState(snapshot?: ChatGPTSnapshot): Promise<ChatGPTState>;
  getComposer(snapshot?: ChatGPTSnapshot): Promise<ComposerState>;
  sendMessage(input: SendMessageInput): Promise<ActionResult<SendEvidence>>;
  waitForStableResponse(input: WaitInput): Promise<ActionResult<ResponseEvidence>>;
  captureLatestResponse(): Promise<ActionResult<CapturedResponse>>;
  continueResponse(): Promise<ActionResult<ContinueEvidence>>;
}
```

The adapter should own selector fallback and semantic detection. Workflow code should only see typed states and verified `ActionResult` values.

## Stronger `SEND_MESSAGE` contract

Current `sendPrompt()` should evolve from `dispatch -> ok` to a validated transaction.

### Preconditions

Before mutation:

- canonical URL/chat identity matches target;
- target is not `GENERATING`;
- target is not `LOGIN_REQUIRED`, `RATE_LIMITED`, `ERROR` or `UNKNOWN`;
- composer exists and is enabled;
- composer is empty, unless the existing content is provably owned by this same pending Nika operation;
- current mutation lease/fencing token is valid;
- idempotency ledger says the exact operation has not already completed.

### Composer input

Do not assume direct `.textContent = prompt` is sufficient for every ChatGPT editor implementation.

Use a tested input strategy family:

1. native value/input path for textarea/input;
2. contenteditable/Lexical-specific insertion path that triggers the framework-observed events;
3. bounded fallback;
4. verify `readComposerText() === requestedPrompt` before submit.

Never erase unrelated existing composer text. If unexpected text exists, return `BLOCKED_BY_USER`.

### Submission

Preferred order:

1. semantic/named Send control;
2. verified keyboard Enter fallback only if allowed for the current composer mode.

### Postconditions

A send is not successful until at least the following are observed:

- a new user message matching the intended prompt hash/text identity appears in the conversation;
- composer was cleared or changed to the expected post-submit state;
- generation starts, or a recognized immediate terminal error is surfaced.

Return `NO_EFFECT` if click/Enter occurred but no postcondition materialized.

## Stronger idle/stability detection

Do not replace the current Stop-button check with another single selector.

Use a composite detector:

- Stop/generating control state;
- composer/send control state;
- latest assistant response mutation timestamp;
- latest response identity/text fingerprint;
- error/login/rate-limit controls;
- a quiet window after the last relevant DOM mutation.

Recommended stability flow:

`GENERATING -> stop disappears -> assistant DOM quiet for 800-1500ms -> re-snapshot -> unchanged fingerprint -> IDLE/STABLE`.

The quiet window should be configurable/tested, not treated as a universal truth.

## Stronger response capture

`captureLatest()` should return a structured object, not only text:

```ts
interface CapturedResponse {
  responseId: string;
  text: string;
  normalizedText: string;
  textHash: string;
  conversationUrl: string;
  capturedAt: number;
  snapshotId: string;
}
```

Response identity should prefer a stable DOM/message identifier when available and combine it with a normalized text hash as fallback.

Capture must reject:

- empty response;
- same response already consumed by this workflow edge;
- response still changing during the stability window;
- assistant node not belonging to the expected conversation.

Do not use clipboard/Copy as primary capture. Keep Copy only as compatibility/manual fallback.

## Error classification

Add site-specific detection before retry logic. At minimum distinguish:

- authentication/login required;
- conversation not found/deleted;
- rate limit / temporary capacity;
- network/session error;
- content/policy terminal UI state where visible;
- inaccessible/unknown DOM;
- user editing collision.

Retries should be driven by normalized error codes, not by generic exceptions.

## Site adapter health gate

Because ChatGPT UI selector changes can affect every target chat simultaneously, add a global adapter health probe.

Before a large batch begins, run a read-only health check against one or more known ChatGPT tabs:

- composer discoverable;
- state detector returns a known state;
- conversation identity parse succeeds;
- latest message surface can be read if present.

If these fail consistently across independent tabs, open the global ChatGPT adapter circuit breaker and stop mutating the remaining batch. This is safer than allowing 50-100 independent jobs to fail destructively.

## Dependency/reuse decision

### Adopt now

No new mandatory runtime dependency from this cycle.

### Evaluate as optional dev/test dependency

`@kudoai/chatgpt.js`.

Use it first for comparative tests and selector/behavior research.

### Reference/adapt under license review

- `@kudoai/chatgpt.js` — MIT;
- `chatgpt-auto-continue` — inspect project license before any code reuse; its primary dependency is MIT `chatgpt.js`;
- `chrome-chatgpt-autosend` — Apache-2.0.

### Do not outsource to these projects

- durable workflow state;
- mutation leases/fencing;
- idempotency;
- scheduler;
- cross-chat routing;
- post-action evidence;
- NVDA-first management UI;
- global circuit breaker.

These remain Nika-owned product behavior.

## Concrete next code slices

1. Extract selectors and all site behavior from `entrypoints/chatgpt.content.ts` into a dedicated `sites/chatgpt/` adapter boundary.
2. Add `ChatGPTState` with explicit `CONTINUABLE`, `LOGIN_REQUIRED`, `RATE_LIMITED`, `ERROR`, `UNKNOWN`, `BLOCKED_BY_USER`.
3. Add `readComposerText()` and forbid overwriting unexpected content.
4. Replace optimistic SEND with precondition/postcondition validation and structured `ActionResult`.
5. Add user-message post-send identity/hash verification.
6. Add MutationObserver-backed quiet-window stability detector.
7. Add structured response identity/hash and consumed-response dedupe.
8. Add explicit error UI detection.
9. Add a read-only global `ChatGPTAdapterHealth` probe and global breaker integration.
10. Add compatibility tests comparing selected Nika DOM behaviors with current `chatgpt.js` where practical.
11. Add fixture/E2E cases for Ukrainian and English accessible labels.
12. Test direct Lexical/contenteditable assignment against real ChatGPT and replace it if framework events do not reliably commit the text.

## Bottom line

The broad browser-control research remains valid, but the current highest-leverage reuse opportunity is now site-specific: `chatgpt.js` contains a maintained MIT ChatGPT DOM abstraction that is directly relevant to Nika's weakest current layer.

The correct integration strategy is **not** "replace Nika with chatgpt.js". It is:

`Nika durable workflow + Nika validation/evidence -> Nika ChatGPTAdapter -> selectively reused/tested ChatGPT DOM knowledge`.

This preserves Nika's safety and recovery architecture while avoiding needless rediscovery of ChatGPT selector behavior.
