# Nika-agent — real-browser relays, snapshot refs and recovery patterns

Date: 2026-08-24
Status: research decision record

## Purpose

This cycle narrows the research to browser-control systems that already operate against a real authenticated Chrome session and therefore overlap most directly with Nika-agent's intended runtime. The goal is not to replace the current WXT/TypeScript extension architecture with a generic agent framework. The goal is to extract concrete reusable patterns for tab/session ownership, authenticated local relays, semantic snapshots, deterministic verification, recovery and parallel lanes.

## Repositories reviewed

### anomalyco/browser-control — MIT

Repository: https://github.com/anomalyco/browser-control

Important pattern: `agent/CLI -> local relay -> browser extension -> existing Chromium profile`.

Useful properties:
- reuses the user's actual Chromium profile, cookies, login sessions and installed extensions;
- detached localhost relay survives individual CLI/MCP calls;
- explicit session IDs instead of relying on whichever tab happens to be active;
- read-only sessions reject mouse/keyboard CDP commands while still allowing inspection;
- session-owned tabs are isolated from other Browser Control sessions;
- broad Chrome privileges are kept behind an explicit trust boundary rather than hidden;
- health/doctor/status commands are first-class instead of forcing the caller to infer connection state.

Nika conclusion:
- strong reference for a future optional `LocalRelayTransport`;
- do not add `chrome.debugger` to the baseline ChatGPT path yet;
- reuse the *session ownership model* and the distinction between read-only inspection and mutation authority immediately in our own domain model.

### bpc-oss/chrome-faithful — MIT

Repository: https://github.com/bpc-oss/chrome-faithful

This project is particularly relevant to Nika because it treats exact browser profile identity as an authority boundary.

Useful properties:
- exact `profileName` routing and rejection of duplicate live registrations;
- authenticated loopback bridge (`127.0.0.1`) with a generated secret;
- one-use bootstrap/scoped session grants;
- exact-profile startup and confirmation that the expected extension registration appeared before declaring success;
- offscreen document owns a persistent WebSocket because a Manifest V3 service worker may suspend;
- live self-test before browser work;
- minimized-window operation through CDP focus emulation;
- explicit separation between projected safe tools and unrestricted raw CDP;
- fail-closed recovery and structured human handoff for verification challenges.

Nika conclusion:
- the exact-profile registration pattern is worth copying conceptually if Nika later supports several Chrome profiles/accounts;
- localhost transport, if added, must be authenticated; no unauthenticated `ws://127.0.0.1` control plane;
- an offscreen document may be appropriate specifically for a persistent relay socket, but not as Nika's scheduler/workflow source of truth;
- a transport must not report `CONNECTED` merely because a socket exists: it should pass a small browser self-test first.

### shaun0927/openchrome — MIT

Repository: https://github.com/shaun0927/openchrome

OpenChrome is valuable less as a dependency and more as a reliability reference. It wraps browser control in deterministic guardrails rather than forcing an LLM to reason about every failure.

Useful properties:
- one Chrome process with multiple isolated tab lanes;
- circuit breaker at element/page/global levels;
- automatic recovery runtime;
- outcome classifier after actions (`SUCCESS`, silent/no-effect style outcomes, wrong-target outcomes);
- deterministic outcome contracts and before/after evidence;
- declarative YAML playbooks where each step is one tool call plus an outcome contract;
- parallel worker lanes with explicit ownership rather than ad-hoc concurrent clicking.

Nika conclusion:
- extend our `CircuitBreaker` design from one breaker into three scopes: target element/action, one chat/tab, and global ChatGPT adapter;
- `ActionResult` must classify *what actually happened*, not merely whether `click()`/`dispatchEvent()` returned without throwing;
- workflow steps should support explicit postconditions/outcome contracts;
- a global breaker should pause all mutations when the ChatGPT site adapter appears broadly incompatible after a UI change.

### freshtechbro/opendevbrowser — MIT

Repository: https://github.com/freshtechbro/opendevbrowser

The most reusable idea here is the snapshot/ref/action pipeline:

`AX tree -> compact snapshot -> stable refs -> action -> new snapshot`

Useful properties:
- accessibility-tree snapshot is mapped to short refs;
- action targets a ref, then resolves it back to the live DOM/backend node;
- extension relay attaches to an existing logged-in browser;
- local relay discovery/pairing is explicit;
- pairing/reconnect uses exponential backoff through `chrome.alarms`, not an immortal background loop;
- snapshot size has explicit `maxChars`/`maxNodes` budgets;
- extension/daemon protocol and runtime implementation are separated;
- very high automated test coverage is treated as part of the runtime contract.

Nika conclusion:
- formalize `SemanticSnapshot` as a bounded object with `maxNodes` and text-size budgets;
- refs must be ephemeral snapshot refs, not persisted as durable identities across reloads;
- every mutating operation that depends on a ref should verify the snapshot generation/fingerprint before resolving the ref;
- use exponential reconnect/backoff for an optional local relay, but keep durable job state in Dexie.

### webbrain-one/webbrain — GPL-3.0-or-later for current releases

Repository: https://github.com/webbrain-one/webbrain

Current WebBrain releases are GPL-3.0-or-later, so its code should be treated as reference-only unless licensing is deliberately accepted.

Useful product patterns:
- accessibility-tree-first reading instead of brittle CSS selectors;
- successful runs can be compiled into reusable value-free workflows;
- scheduled tasks and watches are first-class concepts;
- per-tab conversation state;
- explicit `/teach` flow for converting demonstrated browser behavior into a reusable workflow;
- side-panel UI designed around reading, stop/control and current-page context.

Nika conclusion:
- do not copy current WebBrain code into Nika-agent;
- the concept `demonstrate once -> normalize to reusable workflow template` fits a later workflow recorder/teaching feature;
- site-specific adapters remain preferable to generic LLM control for stable workflows such as ChatGPT send/wait/capture/forward.

## Consolidated architecture decisions

### 1. Keep the current baseline transport extension-native

For ChatGPT-specific automation the baseline remains:

`WXT content script -> ChatGPTAdapter -> semantic DOM -> Chrome APIs`

Do not add a relay, CDP or native helper merely to send text, detect generation completion or capture an assistant response.

### 2. Define a transport escalation boundary now

Even though the second transport is not implemented yet, freeze the interface:

```text
BrowserTransport
  inspectTarget(...)
  execute(command)
  healthCheck()
  recoverTarget(...)

ContentScriptTransport     # default
LocalRelayTransport        # optional future
DebuggerTransport          # optional advanced future
```

Workflow and scheduler code must not contain direct `chrome.debugger` assumptions.

### 3. Add three-scope circuit breakers

Recommended scopes:

```text
ACTION/TARGET breaker
  e.g. composer locator or SEND postcondition repeatedly fails

CHAT breaker
  DEV17 tab repeatedly cannot recover, reload or confirm identity

GLOBAL ADAPTER breaker
  many unrelated chats fail the same ChatGPT semantic contract
```

Global breaker is essential for UI-rollout failures: if ChatGPT changes the composer across the site, Nika should stop mass mutation rather than failing 70 chats independently.

### 4. Introduce OutcomeContract as a first-class type

Each mutating action should have an explicit postcondition contract. Example for `SEND_MESSAGE`:

```text
preconditions:
- target conversation identity confirmed
- composer is available
- composer is empty or owned by this run
- chat is not generating

postconditions:
- exact new user message identity/text hash is visible
- composer cleared
- generation began OR a terminal response/error state appeared
```

Suggested normalized outcomes:

```text
SUCCESS
NO_EFFECT
WRONG_TARGET
AMBIGUOUS
BLOCKED_BY_USER
SITE_INCOMPATIBLE
RETRYABLE_TRANSIENT
NEEDS_USER
```

`ActionResult.ok=true` alone is insufficient for audit/recovery.

### 5. Snapshot refs are short-lived capabilities, not durable IDs

A `SemanticSnapshot` should carry:

```text
snapshotId
tabId
chatId
url
createdAt
pageFingerprint
nodes[]
```

Each node gets a short `ref` plus semantic data. A ref is valid only for the snapshot generation that created it.

Before acting with a ref:
- verify tab/chat binding;
- verify page fingerprint/snapshot generation is still acceptable;
- resolve against live DOM;
- validate semantic role/name/state again;
- act;
- build/inspect a fresh post-action snapshot.

Never persist a ref in a long-lived workflow checkpoint.

### 6. Budget snapshot size

Do not serialize the whole ChatGPT DOM.

For the ChatGPT adapter, snapshot only:
- composer;
- send control;
- generating/stop control;
- newest user message;
- newest assistant message;
- response action controls;
- important error/rate-limit/login controls.

Add hard `maxNodes` and `maxTextChars` budgets. If the adapter cannot produce a valid bounded snapshot, return a structured incompatibility/error instead of dumping raw DOM.

### 7. Separate inspection authority from mutation authority

Adopt capability-style access:

```text
READ
WRITE
RECOVERY
```

Dashboard/status collection can use READ while a workflow owns WRITE. Reload/rebind operations require RECOVERY authority. This keeps monitoring from accidentally competing with an active writer.

### 8. Optional local relay must be authenticated and self-testing

If/when Nika adds a server/local helper:
- bind only loopback by default;
- require a generated secret/token;
- do not trust Origin alone;
- perform protocol/version handshake;
- perform browser self-test before reporting ready;
- expose connection state and error codes to Nika UI;
- use bounded reconnect with backoff;
- never store durable workflow truth in the relay process.

### 9. Offscreen document has one legitimate future role

Chrome Faithful demonstrates a valid MV3 use: an offscreen document can own a long-lived WebSocket to a trusted local relay while service workers suspend.

For Nika:
- allowed future use: relay socket/clipboard narrow adapters;
- prohibited architectural shortcut: moving scheduler/workflow state to offscreen DOM merely to simulate Manifest V2 persistent background pages.

Dexie remains durable truth.

### 10. `teach/record -> compile workflow` is a later product feature

A future Nika workflow recorder can record semantic actions and compile them to our typed workflow format:

```text
OPEN_CHAT
WAIT_READY
SEND_MESSAGE(templateId)
WAIT_FOR_IDLE
CAPTURE_RESPONSE
FORWARD_RESPONSE
```

The recorded result must be normalized away from raw CSS/XPath/coordinates before it becomes reusable. This is a later feature, not a blocker for the current deterministic ChatGPT adapter.

## Recommended code changes / next slices

Priority order after this research:

1. `OutcomeCode` + `OutcomeContract` domain types.
2. Three-scope `CircuitBreaker` state/storage model.
3. Bounded `SemanticSnapshot` with explicit snapshot generation.
4. Ephemeral `SemanticRef` resolver with stale-ref rejection.
5. READ / WRITE / RECOVERY capability checks around ChatTargetBinding.
6. Global ChatGPT-adapter health signal and site-incompatibility breaker.
7. Post-action snapshot/evidence collection for SEND and CAPTURE.
8. Optional `BrowserTransport` interface freeze before transport-specific code spreads.
9. Later: authenticated `LocalRelayTransport` proof, without enabling it by default.
10. Later: semantic workflow recorder/teacher.

## Dependency/reuse decision

No new mandatory runtime dependency is justified by this cycle.

Keep the previously recommended small dependency set:
- Dexie;
- XState;
- @webext-core/messaging;
- dom-accessibility-api;
- p-queue.

The newly reviewed projects are primarily architecture/code references. Their strongest value is in reliability patterns, not in pulling an entire general-purpose browser-agent runtime into Nika-agent.

## Final direction

Nika-agent should remain a deterministic, ChatGPT-aware browser workflow runtime rather than becoming a generic AI browser controller.

The mature pattern emerging across current projects is:

`real authenticated browser -> explicit session/target ownership -> compact semantic snapshot -> short-lived refs -> typed action -> verified outcome contract -> recovery/circuit breaker -> durable workflow state`

That pattern should now be treated as a binding engineering direction for the browser-control layer.