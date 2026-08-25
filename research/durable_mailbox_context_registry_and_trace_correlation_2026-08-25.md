# Durable mailbox, extension-context identity, and trace correlation

Date: 2026-08-25
Repository: `Oleksii-debug/Nika-agent`

## Executive decision

The next Nika-agent reliability layer should separate **transport**, **durable delivery state**, **live extension-context discovery**, and **observability**.

Recommended model:

`BrowserCommand / RuntimeEvent`

→ typed transport (`@webext-core/messaging` / Chrome messaging)

→ durable mailbox/effect state in Dexie

→ live context validation with `chrome.runtime.getContexts()` + `MessageSender.documentId/origin`

→ local trace correlation (`traceId/spanId/commandId/jobId/effectId/runtimeBootId`)

→ optional future exporter.

The important rule is:

> Chrome messaging tells Nika whether a message channel responded. It does not prove durable delivery or the external browser effect.

Likewise:

> A live extension context is useful evidence that a content script/side panel/offscreen document currently exists, but it is never durable workflow state.

This research also evaluates the newly mature `@tanstack/offline-transactions` package. It contains several excellent patterns for Nika, but should **not** become a production dependency because its current execution/retry/lifecycle assumptions conflict with ambiguity-sensitive browser mutations and MV3 service-worker semantics.

---

## 1. Live repository audit

The current `main` has already improved irreversible SEND safety:

- `send` uses retry policy `none`;
- `status` and `captureLatest` may use bounded read-only retries;
- a SEND transport failure becomes `SEND_UNCERTAIN` instead of automatic reload/replay;
- per-agent live serialization exists through `Map<string, Promise<void>>`.

However, the current runtime remains process-memory based in several critical places:

- `agentQueues` disappears when the MV3 service worker is terminated;
- `waitUntilIdle()` still polls every second using `setTimeout`-based sleep;
- the scheduler still maps schedules directly to per-agent alarms;
- storage is still `chrome.storage.local`, not the planned durable Job/Effect/Lease schema;
- successful content-script response still leads to `prompt_sent` without a durable observed SEND receipt.

The current package set is also still intentionally small: WXT, TypeScript, Vitest, and Chrome types. Dexie/XState/p-queue/webext-core are still research decisions, not merged runtime dependencies.

Therefore the most useful dependency research now is not another browser-control framework; it is whether an existing durable browser outbox can replace part of the planned Dexie runtime.

---

## 2. `@tanstack/offline-transactions`: strongest new durable-outbox reference

Current upstream package inspected on 2026-08-25:

- package: `@tanstack/offline-transactions`;
- upstream repository: `TanStack/db`;
- current repository package version observed: `1.0.50`;
- license: MIT;
- TypeScript;
- IndexedDB persistence;
- outbox pattern;
- Web Locks leader election;
- BroadcastChannel fallback;
- idempotency keys;
- retry/backoff;
- transaction replay after reload.

Sources:

- https://github.com/TanStack/db/tree/main/packages/offline-transactions
- https://www.npmjs.com/package/@tanstack/offline-transactions

Conceptually, this is very close to several Nika requirements:

`persist intent → durable outbox → claim execution authority → execute → record result → replay pending work after restart`.

### 2.1 What is genuinely reusable conceptually

The strongest patterns to adopt are:

1. **persist-before-dispatch**;
2. storage capability probe and explicit storage diagnostics;
3. explicit transaction/idempotency identity;
4. Web Locks as a live leader-election/mutual-exclusion primitive;
5. bounded distinction between live scheduling state and durable outbox state;
6. named mutation functions instead of arbitrary executable code;
7. durable retry metadata such as `retryCount`, `nextAttemptAt`, and `lastError`;
8. tracing hooks around scheduler/outbox/execution boundaries.

These fit Nika well.

### 2.2 Why it should not become Nika's runtime dependency

The current implementation has several mismatches that are important enough to reject direct adoption.

#### A. It is coupled to TanStack DB

The package's current `package.json` has a direct `@tanstack/db` dependency. Nika does not otherwise need TanStack DB collections, optimistic collection transactions, or their internal transaction stack.

Pulling in a database framework only to obtain an outbox would create a second state model next to Dexie and XState.

Nika should keep one authoritative browser persistence model.

#### B. Default retry semantics are wrong for ChatGPT SEND

The current `TransactionExecutor` constructs `DefaultRetryPolicy(Number.POSITIVE_INFINITY, ...)` and automatically schedules failed transactions again unless an error is explicitly classified as non-retriable.

That is correct for a normal idempotent HTTP mutation with an idempotency key.

It is incorrect for ChatGPT web UI SEND.

A browser SEND can fail in the ambiguity window:

`click happened → ChatGPT accepted prompt → acknowledgement lost`.

A generic retry engine cannot distinguish this from a pre-submit transport failure.

For Nika:

`SEND_MESSAGE` must never enter a generic automatic retry policy after dispatch uncertainty.

It must enter `AMBIGUOUS` and reconcile through fresh DOM observation.

#### C. Retry scheduling uses in-memory `setTimeout`

The package's `TransactionExecutor` schedules future retry work with `setTimeout()`.

That is acceptable for a normal long-lived browser page.

It is not authoritative in an MV3 service worker, whose process can disappear.

For Nika:

`nextAttemptAt` must be durable;

`chrome.alarms` must wake the runtime;

`setTimeout`/p-queue timing can only refine pacing while the worker happens to be alive.

#### D. Default web connectivity detector is page-oriented

`WebOnlineDetector` listens to:

- `window.online`;
- `document.visibilitychange`;
- `navigator.onLine`.

In an MV3 service worker there is no `window` or `document`, so those listeners do not provide the same runtime behavior.

Nika also cannot equate `navigator.onLine === true` with “ChatGPT mutation is currently safe”. Site cooldown, login state, adapter health and rate-limit state are stronger signals.

#### E. Current scheduler is globally serial

The inspected current `KeyScheduler` has one `isRunning` boolean and therefore allows one transaction at a time for the executor.

Nika needs a different concurrency geometry:

- one WRITE at a time **per chat**;
- many distinct chats may be in progress concurrently;
- global SEND starts remain paced;
- READ work may run concurrently where safe.

So the current scheduler cannot simply replace `ChatActor + per-chat lease/fencing + global dispatcher`.

#### F. Mutation completion is earlier than Nika effect settlement

The current executor treats successful `mutationFn()` resolution as execution success, removes the transaction from the outbox and resolves the waiting transaction.

Nika requires another stage:

`mutation transport returned`

≠

`browser effect proven`.

For SEND, completion requires observation of the exact new user-message in the correct conversation/document.

The TanStack project itself has discussed the broader “write returned vs confirmation arrived” gap in its offline-transaction issue tracker. Nika's requirement is stricter because a duplicate browser mutation may be irreversible.

### Decision

`@tanstack/offline-transactions` = **strong source/reference and optional isolated spike**.

Not baseline dependency.

Do not replace Dexie + Effect Journal + lease/fencing + Nika-specific dispatcher with it.

---

## 3. What to reuse from TanStack without adopting the package

Recommended selective pattern mapping:

| TanStack pattern | Nika equivalent |
|---|---|
| Persistent outbox | `jobs` / `effects` Dexie tables |
| transaction idempotency key | `commandId` / `effectId` |
| Web Locks leader | live `nika:dispatcher` lock |
| `nextAttemptAt` | durable `notBefore` |
| storage diagnostics | `StorageHealth` |
| named mutation functions | `CapabilityManifest` |
| transaction trace attributes | `RuntimeTrace` / `runtimeEvents` |
| replay pending transactions | startup reconciliation |
| generic retry | **only** `RetryClass=READ_SAFE` or proven `NO_EFFECT` |

This extracts the mature ideas while preserving Nika's stricter browser-effect semantics.

---

## 4. Three different communication layers must not be conflated

Nika should explicitly distinguish:

### Layer A — one-shot command transport

Use for:

- health probes;
- status reads;
- snapshots;
- prepare/observe commands;
- short request/reply interactions.

Implementation:

- `@webext-core/messaging` over Chrome messaging;
- protocol/runtime validation before use.

Chrome one-time messaging is JSON-serialized in Chrome and has a documented message size limit. It is convenient, but there is no durable mailbox semantics.

### Layer B — live streaming/session transport

Use for:

- Side Panel live updates;
- optional diagnostic stream;
- LocalBridge/WebSocket later;
- high-frequency UI state while contexts are alive.

Possible implementation:

- `runtime.Port` / `tabs.connect()`;
- WebSocket for LocalBridge later.

A Port is a live connection, not durable state. It can disconnect when a tab/frame unloads or the receiving context disappears.

Chrome's lifecycle behavior also matters: since Chrome 114, merely opening a long-lived port no longer resets the service-worker idle timer; traffic across long-lived messaging does. Nika must not use an idle Port as a fake persistent background page.

### Layer C — durable mailbox/effect ledger

Use for:

- jobs not yet executed;
- browser intents received from a future server;
- effects prepared but not settled;
- handoffs;
- waits;
- cooldowns;
- command receipts requiring crash recovery.

Implementation:

- Dexie/IndexedDB.

This is the only layer that survives process death and is allowed to decide whether work still needs execution.

---

## 5. New primitive: `RuntimeContextRegistry`

Chrome 116+ provides `chrome.runtime.getContexts()`.

It can enumerate active extension contexts and filter by:

- context ID/type;
- document ID;
- document origin/URL;
- frame ID;
- tab ID;
- window ID;
- incognito state.

Relevant context types include:

- `BACKGROUND`;
- `TAB`;
- `POPUP`;
- `OFFSCREEN_DOCUMENT`;
- `SIDE_PANEL`;
- `DEVELOPER_TOOLS`.

This is highly useful for Nika.

### Proposed `RuntimeContextRegistry`

It should provide operations such as:

`listLiveContexts()`

`findTabContext(tabId, documentId?)`

`isSidePanelOpen(windowId?)`

`isOffscreenPresent()`

`validateSender(sender)`

`describeContext(contextId)`.

### What it solves

Before sending a command Nika can distinguish:

`tab exists but no matching content context`

from

`matching document context exists but messaging failed`.

That makes recovery decisions safer.

It also avoids creating duplicate offscreen/side-panel helper contexts when an equivalent context already exists.

### What it does NOT solve

`runtime.getContexts()` is a live process observation.

It must not be used as:

- workflow history;
- durable lease state;
- proof that a previous SEND happened;
- proof that a context will still exist one millisecond later.

Therefore context discovery always feeds into a fresh command/identity check, never directly into a mutation decision.

---

## 6. Sender identity should become part of protocol validation

Chrome `MessageSender` already exposes useful provenance:

- `documentId`;
- `documentLifecycle`;
- `frameId`;
- `origin`;
- `tab`.

Chrome's own messaging security guidance says content scripts should be considered less trustworthy than the extension service worker, and incoming values must be validated.

For Nika every message from a tab should therefore be checked against expected target identity.

Example validation chain:

`sender.tab.id == expectedTabId`

→ `sender.frameId == expectedFrameId`

→ `sender.documentId == expectedDocumentId`

→ `sender.origin allowed by SiteProfile`

→ `navigationEpoch compatible`

→ schema/protocol version valid.

If not:

`SENDER_IDENTITY_MISMATCH`

and no WRITE transition.

This is stronger than trusting only message payload fields, because a compromised or stale content context should not be allowed to claim arbitrary tab/document identity.

---

## 7. Durable command receipt model

Every cross-context command that matters should have stable IDs.

Recommended envelope:

```ts
interface RuntimeCommandEnvelopeV1<T> {
  protocolVersion: 1;
  commandId: string;
  traceId: string;
  parentSpanId?: string;
  jobId?: string;
  runId?: string;
  effectId?: string;
  target: TargetIdentity;
  issuedAt: string;
  payload: T;
}
```

And result:

```ts
interface RuntimeCommandResultV1<T> {
  protocolVersion: 1;
  commandId: string;
  traceId: string;
  spanId: string;
  outcome: ActionOutcome;
  evidence?: T;
}
```

The transport response is still not the durable receipt for a browser mutation.

For READ:

transport result can normally complete the command.

For WRITE:

transport result only advances:

`DISPATCHING → PENDING_OBSERVATION`.

Only effect proof advances:

`PENDING_OBSERVATION → SETTLED_SUCCESS`.

---

## 8. Observability: use trace semantics without adopting a large telemetry SDK yet

OpenTelemetry JavaScript is mature for Node and the core trace/metrics APIs, but its browser client instrumentation is still explicitly documented as experimental/mostly unspecified.

For Nika this argues against loading the full browser OpenTelemetry SDK into every extension context now.

There are additional practical risks:

- automatic instrumentation may generate excessive volume;
- content can contain private ChatGPT text;
- extension service-worker telemetry has unusual lifecycle boundaries;
- Nika needs local debugging even when completely offline.

The better baseline is a tiny local trace model compatible with W3C/OpenTelemetry identifiers.

### Recommended fields

`traceId` — entire workflow/job causal chain.

`spanId` — one operation.

`parentSpanId` — parent operation.

`runtimeBootId` — current MV3 worker JS incarnation.

`contextId` — current Chrome extension context when known.

`commandId` — cross-context request identity.

`jobId`

`runId`

`effectId`

`chatId`

`tabId/documentId/navigationEpoch`.

W3C Trace Context uses a 16-byte Trace ID and 8-byte Span ID. Nika can use the same shapes now so a future server/LocalBridge can export real `traceparent` values without changing stored history.

### Do not send browser trace data anywhere by default

V1 should store bounded trace/event metadata locally in Dexie.

Response/prompt bodies should not automatically become trace attributes.

Use hashes/IDs and short sanitized diagnostics by default.

A later `TraceExporter` interface can support:

- local JSON export;
- FailureBundle export;
- future OpenTelemetry collector;
- future Nika Server.

---

## 9. Useful pattern from TanStack telemetry code

Interestingly, current `@tanstack/offline-transactions` source retains span-shaped wrappers such as:

- `withSpan`;
- `withNestedSpan`;
- `withSyncSpan`;

while the actual tracer is currently a no-op.

This is a good pattern for Nika:

instrument code against a tiny stable `RuntimeTracer` interface first;

keep default implementation local/no-op or Dexie-backed;

only later plug in OpenTelemetry/Sentry/other exporters if required.

This avoids binding core runtime logic to a telemetry vendor.

---

## 10. Side Panel event delivery

The Side Panel should not require the service worker to push every state update reliably.

Preferred architecture:

`Dexie authoritative state`

→ Side Panel reads projection/liveQuery

plus

`runtime.Port` or messaging event = low-latency hint.

If the event is missed because a context disappeared, Side Panel simply re-queries the durable projection.

Therefore UI messages can be **at-most-hints**, while execution state remains durable.

This greatly simplifies reconnect behavior.

---

## 11. Context lifecycle reconciliation

On each background boot:

1. create new `runtimeBootId`;
2. enumerate critical active contexts with `runtime.getContexts()`;
3. reconcile registered target bindings;
4. scan durable Jobs/Effects/Waits;
5. reopen only work that is safe to resume;
6. mark in-flight ambiguity-sensitive effects for observation before any retry;
7. emit `RUNTIME_BOOTED` and reconciliation summary.

On content context handshake:

1. content sends protocol/adapter/site-profile version;
2. service worker validates actual `MessageSender` identity;
3. service worker binds handshake to `documentId/navigationEpoch`;
4. stale bindings are invalidated;
5. capability health is recorded.

On disconnect/navigation:

- live connection disappears;
- durable job/effect does not disappear;
- target binding becomes stale/unready;
- reconciliation later resolves the new document.

---

## 12. Dependency decision matrix

### Adopt / continue toward

**Dexie**

Authoritative durable browser storage.

**@webext-core/messaging v4**

Typed request/reply/event transport, not durability.

**XState**

Workflow/effect state machines.

**p-queue**

Live admission/backpressure only.

### Native Chrome APIs

**chrome.runtime.getContexts**

Live extension-context discovery.

**MessageSender.documentId/origin/frameId/tab**

Sender provenance.

**runtime.Port**

Optional live streaming/hints, not durable state.

**Web Locks**

Live dispatcher mutex only.

### Reference / isolated spike

**@tanstack/offline-transactions**

Excellent source of outbox, idempotency, storage-probe and leader-election patterns. Do not adopt as Nika execution runtime.

### Do not add now

**full OpenTelemetry browser SDK**

Browser instrumentation is still experimental; local Nika trace model is sufficient now.

**generic BroadcastChannel leader-election dependency**

Nika targets modern Chrome and already has Web Locks; durable lease/fencing remains in Dexie anyway.

---

## 13. Recommended new primitives

```text
RuntimeContextRegistry
RuntimeContextIdentity
SenderIdentityValidator
RuntimeCommandEnvelopeV1
RuntimeCommandResultV1
DurableMailbox
CommandReceiptRepository
RuntimeTraceContext
RuntimeTracer
TraceExporter
RuntimeBootIdentity
```

Do not make all of them large classes. Several can be small typed modules/interfaces.

---

## 14. Tests to add

### Context identity

- old content document sends a late reply after SPA/navigation → reject;
- same tab, new `documentId` → stale command cannot commit;
- sender origin differs from SiteProfile allowed origin → reject;
- Side Panel closes/reopens → no execution state lost;
- service worker restart → new `runtimeBootId` but same durable `effectId`.

### Transport vs durability

- one-shot READ transport failure → bounded retry allowed;
- WRITE response lost after dispatch → effect becomes ambiguous/pending observation;
- Port disconnect → durable job stays present;
- duplicate command with same `commandId/effectId` → return existing durable receipt, never re-dispatch blindly.

### Scheduler/runtime

- live Web Lock prevents two dispatcher loops;
- killing lock owner allows another live context to enter later;
- durable fencing rejects stale owner after lock loss;
- `setTimeout` loss does not lose `notBefore` because alarm reconciliation reads Dexie.

### Trace correlation

- one workflow keeps same `traceId` across worker reboot;
- each boot gets different `runtimeBootId`;
- content command/result preserves `commandId`;
- no prompt/response body appears in trace metadata by default.

---

## 15. Implementation order after this research

1. Add Dexie and define durable schema first.
2. Add `RuntimeBootIdentity`.
3. Add `RuntimeCommandEnvelopeV1` / `ResultV1`.
4. Add sender provenance validation.
5. Add `RuntimeContextRegistry` using `chrome.runtime.getContexts()`.
6. Add `jobs/effects/commandReceipts/runtimeEvents` tables.
7. Replace `prompt_sent` semantics with durable effect settlement.
8. Replace `agentQueues` authority with durable lease/fencing; retain live queue only as optimization.
9. Add one scheduler wake/reconciliation path.
10. Introduce tiny local `RuntimeTracer` with W3C-compatible IDs.
11. Let Side Panel consume durable projections and use live events only as hints.
12. Only after these are proven, evaluate an exporter or server-side tracing integration.

---

## Final conclusion

`@tanstack/offline-transactions` is the most interesting newly evaluated ready-made durable browser mutation system because it independently validates several Nika design choices: persisted outbox, idempotency identity, leader election, storage diagnostics, FIFO execution and replay.

However, Nika's hardest operation is not an ordinary offline HTTP mutation. It is a browser UI side effect whose result can become ambiguous after dispatch. The current TanStack executor's automatic/infinite retry and `setTimeout`-driven lifecycle are therefore not safe replacements for Nika's Effect Journal.

The correct reuse boundary is:

**reuse the patterns, not the executor.**

At the same time Chrome now gives Nika a useful missing primitive through `runtime.getContexts()` and sender `documentId/origin` metadata. Those APIs should become the live context/provenance layer around the durable runtime.

The resulting architecture is:

`typed command transport`

→ `validated live context identity`

→ `durable Job/Effect mailbox`

→ `verified browser effect`

→ `local causal trace`

with every layer independently restart-safe and no layer pretending that successful message delivery is proof of successful web mutation.
