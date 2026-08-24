# Nika-agent — Hybrid transport, reuse and runtime decisions

Date: 2026-08-24

## Purpose

This research pass narrows implementation choices for Nika-agent. The objective is to reuse mature open-source patterns where this shortens delivery time, while keeping the core product deterministic, local-first and independent of a paid ChatGPT API.

## Executive decision

Keep the current WXT + TypeScript Manifest V3 extension as the product shell. Do not replace it with a generic browser-agent project.

Use a two-tier browser-control architecture:

1. `ContentScriptTransport` — default runtime for ChatGPT. Uses content scripts, DOM/ARIA semantics and native Chrome tabs/scripting APIs.
2. `LocalRelayTransport` — optional future escalation layer for harder browser-control cases. May use a localhost relay/native helper and `chrome.debugger`/CDP, but must implement the same transport interface.

The workflow layer must never know which transport is being used.

## Why this is the best fit

Nika-agent's common operations are simple and deterministic:

- locate an existing ChatGPT conversation;
- place text in the composer;
- submit;
- detect active generation;
- wait until the response is stable;
- capture the latest assistant response;
- route that response to another configured conversation;
- recover after tab/service-worker interruptions.

These do not require a generic LLM browser agent. A generic agent adds permissions, token use, nondeterminism and failure modes without improving the core Developer/Auditor workflow.

## Open-source projects worth reusing or studying

### 1. anomalyco/browser-control — strongest transport/session reference

License: MIT.

Architecture:

`agent/CLI -> localhost relay -> Chrome extension -> existing Chromium browser`

Useful patterns:

- controls the user's existing logged-in browser rather than launching a clean browser;
- adoption of existing tabs;
- explicit session identity and ownership;
- read-only sessions;
- compact page snapshots with stable refs;
- relay survives individual CLI/MCP client restarts;
- structured results, logs and warnings;
- browser-wide destructive CDP commands are deliberately restricted.

Decision for Nika-agent:

Do not copy the whole stack into baseline runtime. Study and selectively adapt the session/adoption/ownership model and structured snapshot/result protocol. Keep a future `LocalRelayTransport` interface compatible with this architecture.

### 2. Cereon Browser Operator — protocol boundary reference

License: MIT.

Architecture:

Manifest V3 extension exposing browser operations over a deliberately small command/result protocol.

Useful pattern:

`{ id, tool, args } -> { commandId, result }`

Decision:

Nika-agent should use the same concept internally. Browser operations should cross a typed command/result boundary instead of allowing workflow code to call DOM/Chrome primitives directly.

Suggested shape:

```ts
interface BrowserCommand<TArgs> {
  commandId: string;
  kind: string;
  args: TArgs;
}

interface ActionResult<TData = unknown> {
  ok: boolean;
  code: string;
  data?: TData;
  retryable: boolean;
  evidence?: ActionEvidence;
}
```

### 3. FSB — verification and progress reference

Useful patterns:

- DOM-first operation;
- ARIA/labels/forms in page representation;
- DOM deltas;
- post-action state verification;
- stuck-action repetition detection.

Decision:

Every mutating Nika action must have an explicit validator. `click()` or `sendMessage()` returning without an exception is not sufficient proof of success.

### 4. WebGenie — semantic page representation reference

Useful pattern:

Translate raw DOM into a compact interactive representation rather than exposing the full page tree to the automation layer.

Decision:

Maintain `SemanticSnapshotBuilder` as a first-class module. ChatGPT-specific code should identify controls by role, accessible name, stable attributes and local structure before CSS-class fallbacks.

### 5. OpenChrome — circuit-breaker/recovery reference

Useful patterns:

- real Chrome rather than clean automation profile;
- parallel isolated lanes;
- circuit breaker;
- automatic recovery runtime;
- token-efficient page serialization.

Decision:

Reuse the *pattern*, not the architecture wholesale. Nika's `ProgressGuard` and `RecoveryManager` should be deterministic and independent of an LLM.

### 6. Browser Agent Recorder — possible code-level reuse candidate

Before copying any module, perform a file-level license and dependency review. Candidate areas to inspect:

- local IndexedDB structures;
- typed browser/content protocol;
- selector/ref representation;
- recorder-style event normalization.

Do not vendor a repository wholesale.

## Existing Nika stack remains correct

Current repository uses:

- WXT 0.21.4
- TypeScript 5.9
- Vitest 3.2

Keep WXT. Current WXT remains an actively documented MV2/MV3 extension framework with TypeScript, file-based entrypoints, HMR and automated packaging.

Recommended runtime dependencies remain:

- `dexie` — durable IndexedDB storage;
- `xstate` — persisted workflow/state-machine model;
- `@webext-core/messaging` — typed background/content/UI messaging;
- `dom-accessibility-api` — semantic accessible names/roles;
- `p-queue` — in-memory dispatcher/backpressure only.

Important boundary: `p-queue` is not persistence. Dexie is the source of truth.

## Scheduler decision confirmed against current Chrome documentation

Use one or a very small number of Chrome alarms as wake-up triggers, not one alarm for every logical schedule.

Chrome's alarms behavior matters:

- an alarm does not wake a sleeping device;
- missed repeating alarms fire at most once after wake and are then rescheduled;
- alarms may be delayed;
- minimum production interval is approximately 30 seconds;
- `persistAcrossSessions` exists in Chrome 150+;
- important alarms should still be checked/recreated on service-worker startup for compatibility and resilience.

Therefore:

`Dexie schedules -> reconciliation -> chrome.alarms wake-up -> due-job scan -> dispatcher`

Missed-run policies belong to Nika's data model, not to `chrome.alarms`:

- `SKIP`
- `RUN_ONCE_NOW`
- `CATCH_UP_LIMITED`
- `RESCHEDULE_FROM_NOW`

Default for recurring ChatGPT prompts: `RUN_ONCE_NOW`.

## Browser transport interface

Recommended boundary:

```ts
interface BrowserTransport {
  resolveTarget(chatId: ChatId): Promise<TargetHandle>;
  ensureReady(target: TargetHandle): Promise<ActionResult<TargetHandle>>;
  snapshot(target: TargetHandle): Promise<ActionResult<SemanticSnapshot>>;
  perform(target: TargetHandle, command: BrowserAction): Promise<ActionResult>;
}
```

Implementations:

- `ContentScriptTransport` — required baseline;
- `DebuggerTransport` — optional future extension-only escalation;
- `LocalRelayTransport` — optional Windows/local helper escalation.

A workflow must be portable across transports.

## ChatGPT adapter contract

The ChatGPT adapter must own all site-specific behavior:

```ts
interface ChatGPTAdapter {
  inspect(): Promise<ChatGPTState>;
  sendMessage(text: string, context: SendContext): Promise<ActionResult<SendReceipt>>;
  waitForIdle(policy: IdlePolicy): Promise<ActionResult<StableResponseState>>;
  captureLatestResponse(): Promise<ActionResult<CapturedResponse>>;
}
```

The workflow layer must not contain ChatGPT selectors or button names.

## Stable completion detection

Do not define completion as only "Stop button disappeared".

Recommended state fusion:

1. observe generating/Stop state;
2. observe assistant-response DOM mutations;
3. record timestamp of last relevant mutation;
4. require generation indicator to become idle;
5. require a configurable quiet window, initially around 1 second;
6. capture response;
7. validate response identity and stability.

This prevents forwarding a partially streamed answer.

## Human-collision protection

Before every mutating action, compare live state with the expected precondition.

For `SEND_MESSAGE`:

- if composer contains user-authored text not belonging to the workflow, return `BLOCKED_BY_USER`;
- never erase or overwrite that text;
- release or defer the job according to workflow policy.

Default focus policy: `NEVER_FOCUS`.

Background automation should not steal the user's active window/tab unless a step explicitly requires it.

## Concurrency model

Separate four concerns:

- Scheduler: when a logical job is due.
- Dispatcher: how many jobs execute concurrently.
- Lease: who currently owns mutation rights to one chat.
- Workflow: which business step executes next.

Recommended baseline:

- global dispatcher concurrency configurable, initial default 4;
- one mutating workflow per chat at a time;
- read-only inspections may run concurrently where safe;
- durable per-chat lease with `ownerRunId`, expiry, heartbeat and fencing token;
- stale workflow cannot mutate a chat after another workflow acquired a newer fencing token.

## Idempotency

Critical actions require durable idempotency records.

For SEND:

- run ID;
- action ID;
- chat ID;
- normalized message hash;
- pre-send response/message identity;
- post-send receipt/evidence;
- status.

For CAPTURE/FORWARD:

- source chat;
- source response identity/hash;
- destination chat;
- routing rule;
- delivery receipt.

Service-worker restart must never produce an accidental second send/forward.

## Recovery ladder

Use bounded deterministic recovery:

1. primary semantic locator;
2. alternate semantic locator;
3. rebuild semantic snapshot;
4. re-resolve target tab;
5. reinject/reconnect content script;
6. reload target only if workflow policy allows it;
7. retry with bounded backoff;
8. mark `NEEDS_USER` or `FAILED`.

Add `ProgressGuard` fingerprints to detect:

- same state + same action repeated;
- no relevant DOM change across attempts;
- A -> B -> A -> B oscillation;
- excessive recovery count.

Never allow infinite retry loops.

## Side panel/full-page UI decision

Keep two surfaces:

### Side panel

Operational control:

- current runs;
- queue;
- active chat;
- Run now;
- Pause/Resume;
- Stop;
- recent errors;
- compact status.

### Full extension page

Configuration:

- Projects;
- Chats;
- Templates;
- Workflows;
- Schedules;
- Runs/Logs;
- Settings.

For NVDA, workflow editing must be form/list based. Drag-and-drop may be offered later as an optional visual enhancement but can never be the only way to reorder or configure steps.

## What not to import into baseline

Do not make these baseline dependencies:

- Selenium;
- Puppeteer runtime;
- generic LLM browser agent loops;
- cloud browser services;
- OCR/coordinate clicking;
- Chrome debugger permission;
- native Windows helper.

They are escalation/fallback options only.

## Immediate implementation order

1. Add the approved runtime dependencies after developer review.
2. Define domain IDs and typed command/result protocol.
3. Create Dexie schema and migrations.
4. Implement typed extension messaging.
5. Implement `SemanticSnapshotBuilder`.
6. Implement `TabRegistry` + `ensureTargetReady`.
7. Implement baseline `ContentScriptTransport`.
8. Implement `ChatGPTAdapter` with no selectors leaking outside the adapter.
9. Implement validator-driven `SEND_MESSAGE` and response capture.
10. Implement stable `WAIT_FOR_IDLE` using MutationObserver + quiet window.
11. Implement durable lease/fencing + idempotency ledger.
12. Integrate XState persisted workflow runs.
13. Implement schedule reconciliation and due-job dispatcher.
14. Implement `ProgressGuard` and bounded recovery.
15. Add NVDA-first side panel/full-page workflow UI.
16. Add Playwright E2E for real Chrome behavior.
17. Only after baseline passes acceptance tests, prototype optional `DebuggerTransport` or local relay.

## Mandatory acceptance tests

- user switches to Unigram/Word while Nika continues on target ChatGPT tabs;
- target tab is closed, discarded or reloaded and workflow recovers safely;
- service worker dies after SEND, resumes and does not duplicate SEND;
- response is still streaming and is not captured/forwarded early;
- same source response cannot be forwarded twice unintentionally;
- two workflows targeting the same chat cannot both mutate it;
- stale lease owner is rejected via fencing token;
- user text in composer is never overwritten;
- scheduler recovers correctly after PC sleep;
- all primary configuration and run controls are keyboard/NVDA operable.

## Final recommendation from this pass

The fastest robust route is **not** to transplant an existing browser-agent product. Build Nika-agent on the current WXT base, reuse mature libraries for infrastructure, and selectively borrow proven patterns from MIT/Apache browser-control projects.

Baseline architecture:

`WXT UI/service worker -> durable scheduler/workflows -> BrowserTransport -> ChatGPTAdapter -> semantic DOM/content script -> existing logged-in Chrome`

Optional future escalation:

`same workflows -> LocalRelayTransport/DebuggerTransport -> existing Chrome`

This keeps the first complete product smaller, safer and faster while preserving a clear path to stronger browser control later.