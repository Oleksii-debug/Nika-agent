# Nika-agent research: session adoption, compact snapshots and circuit breakers

Date: 2026-08-24

## Scope

This cycle narrowed the research to three implementation problems that matter directly for Nika-agent:

1. how to safely reuse already-authenticated Chrome tabs and sessions;
2. how to represent the ChatGPT page compactly and semantically instead of scraping arbitrary HTML;
3. how to stop browser workflows from looping, duplicating actions, or getting stuck indefinitely.

The goal is not to add another agent framework. The goal is to extract reusable patterns that fit the existing WXT + TypeScript extension architecture.

## Strong current references

### anomalyco/browser-control

Repository: https://github.com/anomalyco/browser-control

Why it matters:

- controls the user's existing Chromium-family browser;
- reuses the real browser profile, logged-in sessions and installed extensions;
- explicitly supports adopting an already-open tab into an automation session;
- makes tab ownership explicit and exclusive for the mutating session;
- uses compact snapshots with stable refs for subsequent actions;
- returns structured execution results rather than only boolean success;
- includes guardrails around destructive browser-wide CDP operations.

Reusable pattern for Nika-agent:

`ChatRegistry -> resolve existing tab -> acquire ownership/lease -> snapshot -> action -> verify -> release/renew lease`

Nika-agent should not copy the full relay/CDP runtime. The useful parts are session adoption, target ownership, compact refs and structured action evidence.

### Microsoft Playwright Chrome Extension

Reference: https://github.com/microsoft/playwright/tree/main/packages/extension

Why it matters:

Microsoft now explicitly supports connecting Playwright to pages in an already-running browser and reusing the default profile state, cookies and login sessions.

This confirms that Nika-agent's central premise is technically sound:

- stay inside the user's real Chrome profile;
- reuse authenticated ChatGPT state;
- operate existing tabs rather than forcing a fresh browser profile.

For Nika-agent, however, Playwright should remain primarily an E2E/testing and advanced-transport reference. The baseline runtime can stay extension-native and DOM-first.

### OpenChrome

Repository: https://github.com/shaun0927/openchrome

Why it matters:

OpenChrome adds a harness around real-Chrome automation rather than exposing only raw browser commands. Particularly relevant patterns:

- many isolated parallel lanes in one Chrome process;
- token-efficient / compact page serialization;
- hinting around likely next actions;
- circuit breaker logic;
- automatic recovery instead of unbounded retry loops.

Reusable pattern for Nika-agent:

A workflow runtime must include a `ProgressGuard` / `CircuitBreaker`, not just `retryCount`.

Recommended tracked signals:

- repeated action fingerprint;
- repeated semantic page-state fingerprint;
- no DOM progress after N attempts;
- A -> B -> A -> B oscillation;
- repeated target-resolution failure;
- repeated validation failure after an apparently successful click/send;
- cumulative recovery budget.

### FSB

Repository: https://github.com/fullselfbrowsing/FSB

Why it matters:

FSB is a Chrome-extension browser automation system that is explicitly DOM-first and verifies results after actions.

This reinforces two decisions already made for Nika-agent:

1. semantic/structural DOM should be primary;
2. every important browser action must have a postcondition validator.

For ChatGPT, this means `SEND_MESSAGE` is successful only after Nika verifies that the intended message actually appeared and generation started (or the expected idle state changed).

### uiuing/browser-agent

Repository: https://github.com/uiuing/browser-agent

Why it matters:

This project treats browser automation as a typed runtime with:

- structured tools;
- live-DOM verification;
- risk tiers;
- site policies;
- audit traces;
- reusable verified workflows.

Reusable pattern for Nika-agent:

Actions should be typed and policy-aware. A browser mutation should not be a generic `executeJavaScript(string)` in normal workflow code.

Preferred contract:

```ts
interface BrowserAction<TArgs, TResult> {
  type: string;
  risk: 'read' | 'write' | 'navigation' | 'destructive';
  args: TArgs;
  validateBefore(ctx: ActionContext): Promise<ValidationResult>;
  execute(ctx: ActionContext): Promise<TResult>;
  validateAfter(ctx: ActionContext, result: TResult): Promise<ValidationResult>;
}
```

### browser-agent scheduled-task implementation

Repository: https://github.com/zxcHolmes/browser-agent

Why it matters:

It already demonstrates a Chrome-extension UX for:

- named scheduled tasks;
- interval-based schedules;
- enable/disable;
- next-run display;
- run-now;
- local run history;
- `chrome.alarms` wakeups.

Nika-agent should study this UX, but keep Dexie as the durable schedule source of truth. `chrome.alarms` should remain only a wake-up trigger.

## New implementation decisions

## 1. Add an explicit SessionAdoption layer

Current tab handling should evolve beyond a plain `tabId` cache.

Proposed record:

```ts
interface ChatTargetBinding {
  chatId: string;
  canonicalUrl: string;
  lastKnownTabId?: number;
  lastKnownWindowId?: number;
  ownershipState: 'free' | 'leased' | 'manual';
  ownerRunId?: string;
  leaseExpiresAt?: number;
  fencingToken?: number;
  lastValidatedAt?: number;
}
```

Before any mutation:

1. resolve canonical ChatGPT conversation URL;
2. locate an already-open matching tab if possible;
3. verify that it still points to the intended conversation;
4. verify content-script readiness;
5. acquire durable mutation lease;
6. only then send/type/click.

If no tab exists, the adapter may create one according to policy.

## 2. Separate read ownership from write ownership

Read-only inspection does not need the same exclusivity as mutation.

Recommended capability model:

- `READ`: inspect status, semantic snapshot, last response;
- `WRITE`: type/send/click/navigation;
- `ADMIN`: reload/rebind/recover target.

This allows dashboards and auditors to inspect a chat while one workflow holds the write lease.

## 3. Compact SemanticSnapshot, not raw HTML

Nika-agent should never make raw `document.documentElement.outerHTML` the normal interface between content script and workflow engine.

For ChatGPT, the snapshot should contain only automation-relevant nodes and states.

Example:

```ts
interface SemanticNode {
  ref: string;
  role?: string;
  name?: string;
  text?: string;
  disabled?: boolean;
  visible: boolean;
  value?: string;
  state?: Record<string, string | boolean | number>;
}

interface ChatGptSemanticSnapshot {
  conversationUrl: string;
  composer?: SemanticNode;
  sendButton?: SemanticNode;
  stopButton?: SemanticNode;
  latestUserMessage?: SemanticNode;
  latestAssistantMessage?: SemanticNode;
  responseActions?: SemanticNode[];
  generating: boolean;
  capturedAt: number;
  fingerprint: string;
}
```

Stable `ref` values should only live for the lifetime of a snapshot. After any meaningful DOM mutation, re-resolve nodes instead of assuming stale element identity.

## 4. Fingerprint page state and actions

Each critical step should derive:

- `stateFingerprint` from semantic page state;
- `actionFingerprint` from action type + target + normalized arguments.

Example:

`SEND_MESSAGE|chat=dev03|sha256(normalizedText)`

This supports:

- duplicate prevention;
- stuck-loop detection;
- auditability;
- deterministic recovery decisions.

## 5. Introduce a real CircuitBreaker state machine

Recommended per-run states:

- `CLOSED`: normal execution;
- `HALF_OPEN`: one controlled recovery attempt;
- `OPEN`: automation for this target/run is suspended.

Trip conditions should include:

- same failed action >= 3 times with unchanged page fingerprint;
- same validation failure >= 3 times;
- oscillation detected;
- target rebind failed repeatedly;
- recovery budget exhausted;
- evidence suggests manual user activity conflicts with automation.

When OPEN:

- stop mutating the target;
- persist evidence and reason;
- expose `NEEDS_USER` or `FAILED_RECOVERABLE` in UI/logs;
- do not spin indefinitely.

## 6. Human-collision detection remains mandatory

Before any `SEND_MESSAGE`:

- inspect composer value;
- if non-empty and not attributable to the current workflow, do not overwrite;
- return `BLOCKED_BY_USER`;
- reschedule according to policy.

Recommended policy defaults:

- manual typing wins over automation;
- Nika never clears user text automatically;
- Nika never steals focus by default;
- Nika never sends while the user is actively editing the same composer.

## 7. Scheduler UX to reuse conceptually

Recommended schedule editor fields:

- name;
- project;
- target chat;
- enabled;
- trigger type;
- interval / exact time;
- message template or workflow;
- missed-run policy;
- concurrency priority;
- run-now action;
- next-run time;
- last-run outcome.

Missed-run policy enum:

- `SKIP`;
- `RUN_ONCE_NOW` (default);
- `CATCH_UP_LIMITED`;
- `RESCHEDULE_FROM_NOW`.

## 8. Do not broaden permissions yet

The newest real-browser projects often rely on `chrome.debugger`, native messaging or localhost relays. Those are useful advanced references, but Nika-agent's ChatGPT baseline does not need them yet.

Keep the baseline transport:

`WXT content script + chrome.tabs + chrome.scripting + typed messaging`

Only add an advanced transport later behind a common interface if real requirements prove that content scripts are insufficient.

## Dependency recommendation remains intentionally small

Existing repository dependencies are currently minimal: WXT, TypeScript and Vitest.

The strongest next runtime candidates remain:

- `dexie` — durable IndexedDB data;
- `xstate` — persisted workflow/state-machine runtime;
- `@webext-core/messaging` — typed extension messaging;
- `dom-accessibility-api` — accessible-name/ARIA semantics;
- `p-queue` — in-memory dispatch concurrency/backpressure only.

Do not add generic agent frameworks, Selenium, Puppeteer runtime, cloud browser SDKs or OCR dependencies to the baseline product.

## Recommended next code slices

1. `BrowserCommand` / `ActionResult` protocol.
2. `SemanticSnapshot` types and fingerprint utility.
3. `ChatTargetBinding` + durable session adoption.
4. read/write capability and durable mutation lease.
5. `ProgressGuard` + `CircuitBreaker`.
6. ChatGPT `SEND_MESSAGE` precondition and postcondition validator.
7. ChatGPT `WAIT_FOR_IDLE` using MutationObserver + quiet window.
8. response capture identity/hash and forwarding dedupe.
9. schedule editor contract with missed-run policies.
10. E2E cases for stale tabs, manual composer conflicts, worker restart and duplicate-send prevention.

## Acceptance tests to add

### Session adoption

- existing matching ChatGPT tab is reused rather than duplicated;
- stale `tabId` is re-resolved by canonical URL;
- closed target can be recreated if policy allows;
- wrong conversation URL fails safe.

### Circuit breaker

- identical failed mutation with unchanged page fingerprint trips breaker;
- A/B oscillation trips breaker;
- breaker state persists across service-worker restart;
- manual resume can transition HALF_OPEN -> CLOSED after a successful verified action.

### Human collision

- non-empty manual composer blocks automation;
- automation does not clear user text;
- background automation does not activate/focus the target tab by default.

### Deduplication

- service-worker restart after SEND does not repeat the same message;
- the same captured assistant response is not forwarded twice;
- stale workflow actor cannot mutate after a newer fencing token is issued.

## Final recommendation

The research increasingly converges on a deterministic architecture rather than an autonomous browser-agent loop.

For Nika-agent, the fastest reliable route is:

`real authenticated Chrome + extension-native DOM control + semantic snapshots + durable schedules/workflows + explicit target ownership + postcondition validation + idempotency + circuit breakers`.

Open-source projects should be mined for these proven engineering patterns, not imported wholesale. The actual product-specific value remains in ChatGPT orchestration, developer/auditor routing, durable workflow semantics, failure recovery and NVDA-first control surfaces.
