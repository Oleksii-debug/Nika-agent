# Nika-agent research: concurrency, accessibility DOM and existing-browser reuse

Date: 2026-08-24

## Scope

This cycle narrows the research to three implementation questions that directly affect Nika-agent stability and development speed:

1. How to control many ChatGPT workflows concurrently without letting two workflows corrupt the same chat.
2. How to locate ChatGPT controls semantically instead of relying on brittle CSS selectors.
3. Which existing-browser automation projects are useful as dependencies, source-level references, or architectural fallbacks.

The current repository remains intentionally minimal: WXT + TypeScript + Vitest only. New dependencies should be added only when they replace non-trivial infrastructure rather than for convenience.

## Decision summary

Recommended additions / reuse candidates:

- `p-queue`: recommended for **ephemeral in-memory dispatch/backpressure only**, not as durable scheduling or locking state.
- `dom-accessibility-api`: recommended for the **semantic locator / accessible-name layer** inside content scripts.
- Playwright Chrome Extension / Playwright MCP extension: strong upstream reference for **attaching to an existing authenticated browser profile**.
- `anomalyco/browser-control`: strong architectural reference for **local relay + extension + existing-tab adoption + read-only sessions**.
- `cereon-labs/cereon-browser-operator`: useful MIT reference for a **generic CDP transport protocol** if Nika later needs debugger-level control.
- `chrome-use`, `playwriter`, `chromeflow`, BrowserHand: useful patterns for real-browser control and human handoff, but not required in Nika's first runtime.

Do not add Bottleneck as a core dependency at this stage. Its browser scheduler/rate-limiter is solid, but its queue state is process-memory state and therefore does not solve Manifest V3 service-worker suspension. Nika's durable truth must remain IndexedDB/Dexie and persisted workflow state.

## 1. Concurrency model for 30-70 chats

### Problem

The extension may have tens of chats scheduled at once. We need two different concurrency rules:

- Global concurrency: do not activate too many expensive browser operations simultaneously.
- Per-chat serialization: never allow two mutating workflows to write into the same chat concurrently.

These are separate concerns.

### Recommended model

Use three layers:

1. Durable due-job records in IndexedDB.
2. Durable per-chat lease/fencing state in IndexedDB.
3. Ephemeral `p-queue` instances to control the number of currently executing operations during the lifetime of the service worker.

Example logical topology:

```text
Dexie schedules / runs
        |
        v
Due-job reconciliation
        |
        v
Global p-queue (e.g. concurrency 4-8)
        |
        +---- acquire durable lease CHAT-A ---- workflow A
        |
        +---- acquire durable lease CHAT-B ---- workflow B
        |
        +---- acquire durable lease CHAT-C ---- workflow C
```

`p-queue` provides concurrency limits, priorities, task IDs, timeouts, pause/resume, backpressure signals and running-task introspection. It is appropriate for dispatching work inside one live service-worker instance.

It is **not** a durable scheduler. If Chrome kills the service worker, the queue disappears. On restart Nika must rebuild dispatch state from IndexedDB.

### Why not Bottleneck as the main queue

Bottleneck supports browser execution, max concurrency, min-time throttling, priorities, retries and grouping. It is battle-tested. However, its normal local datastore is in memory. Redis clustering is irrelevant inside a pure extension and would introduce a server dependency.

Conclusion:

- Prefer `p-queue` for local in-memory backpressure because it is small, TypeScript-friendly and directly models Promise work.
- Keep rate semantics (per-chat cooldown, minimum delay after a response, maximum sends per period) as **domain rules stored in Dexie**, not hidden inside the queue library.

## 2. Semantic DOM targeting: use the accessibility model

### Problem

ChatGPT changes markup frequently. A selector such as:

```css
button.some-generated-class
```

is fragile.

Nika should locate controls in an order close to how assistive technology perceives the page:

1. explicit/implicit ARIA role;
2. accessible name;
3. accessible description/state;
4. stable data attributes;
5. DOM relationship / structural fallback;
6. raw text selector only as a last fallback.

### `dom-accessibility-api`

`dom-accessibility-api` implements the Accessible Name and Description computation algorithm and exposes helpers such as:

- `computeAccessibleName(element)`;
- `computeAccessibleDescription(element)`;
- role resolution helpers.

It is MIT licensed and specifically designed to compute the same semantic information used by accessibility-focused testing tools.

Recommended use in Nika:

```text
SemanticSnapshotBuilder
  -> enumerate candidate interactive elements
  -> derive role
  -> compute accessible name
  -> compute accessible description
  -> capture disabled/expanded/pressed/checked state
  -> assign stable local ref for the current snapshot
```

A compact snapshot entry could look like:

```ts
{
  ref: "e17",
  role: "button",
  name: "Stop generating",
  disabled: false,
  visible: true
}
```

This snapshot layer should be generic and independent of ChatGPT.

Then `ChatGPTAdapter` can express locators semantically:

```text
composer: role=textbox + expected region/ancestor
stop: role=button + accessible-name candidate set
send: role=button + accessible-name candidate set
latestAssistantMessage: site-specific structural rule
```

### Why not use Testing Library itself in production

`@testing-library/dom` offers excellent `getByRole` behavior, but its primary purpose is testing. For runtime production code we only need a compact subset: role + accessible name + visibility + site-specific structural filters.

Recommendation:

- Depend on `dom-accessibility-api` in runtime.
- Reuse Testing Library concepts in tests and acceptance criteria.
- Avoid shipping the entire Testing Library query stack unless code-level benchmarking shows it materially reduces implementation complexity.

## 3. Existing authenticated Chrome: projects worth studying

### Microsoft Playwright Chrome Extension

The official Playwright extension explicitly supports connecting to pages in the user's existing Chrome/Edge browser and reusing the default profile's cookies, login sessions and browser state.

This validates a major Nika architectural assumption: a browser automation layer can operate on already-authenticated pages without launching an isolated blank browser.

Use it as a reference for:

- extension-to-controller transport;
- attaching/adopting existing tabs;
- preserving current browser state;
- Playwright-style semantic interaction concepts.

Do not make Playwright MCP a hard runtime dependency for Nika's first version; Nika can handle ChatGPT-specific operations more cheaply through content scripts and Chrome extension APIs.

### anomalyco/browser-control

This project is especially relevant because it separates planning from execution:

```text
trusted agent/CLI -> local relay -> browser extension -> existing Chromium
```

Useful patterns:

- existing-tab adoption;
- session ownership of adopted tabs;
- read-only sessions;
- compact page snapshot before acting;
- result/log/warning return contracts;
- explicit safety boundaries around debugger-level operations.

Nika should copy the **architectural idea**, not necessarily the implementation:

- BrowserTransport should be replaceable.
- A future native/local relay can be added without replacing workflows, storage or UI.
- Mutation permissions can be separated from read-only inspection.

### Cereon Browser Operator

Cereon exposes a simple command/result protocol on top of a Manifest V3 extension using CDP. It is MIT licensed.

Potential future Nika use:

```text
BrowserTransport
  |- ContentScriptTransport   (default)
  `- DebuggerTransport        (optional escalation)
```

The debugger transport would only be enabled for operations that content scripts cannot handle reliably.

Do not request `debugger` permission in the baseline product unless it becomes necessary. The permission surface is significantly broader than a ChatGPT-specific host/content-script model.

### chrome-use / playwriter / chromeflow / BrowserHand

These projects reinforce the same design pattern:

- reuse real Chrome;
- retain login/session/fingerprint;
- allow human intervention;
- target specific tabs rather than globally hijacking the browser.

They are useful for source-level research into tab ownership, recovery and human handoff.

They do not justify changing Nika from a pure extension to a mandatory local-server architecture today.

## 4. Recommended action execution protocol

Every browser action should have a typed input and typed evidence-bearing output.

```ts
type ActionResult<T> = {
  ok: boolean;
  code: string;
  data?: T;
  retryable: boolean;
  evidence: Evidence[];
  startedAt: number;
  finishedAt: number;
};
```

Evidence examples:

- semantic element ref used;
- accessible role/name;
- message hash before/after;
- composer text before/after;
- generation state before/after;
- target URL/chat identity;
- DOM stability timestamp.

This allows the audit log to explain *why* Nika considered a step successful.

## 5. Separate scheduler, queue and workflow responsibilities

These must not be merged into one abstraction.

### Scheduler

Answers: **when should a job become due?**

Source of truth: Dexie.
Wakeup: `chrome.alarms`.

### Dispatcher / queue

Answers: **which due work may run right now?**

Ephemeral implementation: `p-queue`.
Rules: global concurrency, priority, backpressure.

### Per-chat lease

Answers: **who is currently allowed to mutate this chat?**

Durable implementation: Dexie lease + fencing token.

### Workflow engine

Answers: **what step happens next after success/failure/wait/recovery?**

Implementation: XState persisted state.

Keeping these responsibilities separate prevents a service-worker restart from corrupting the execution model.

## 6. Human-user collision handling

The user may be manually typing in the same ChatGPT session while Nika is working elsewhere.

Before every mutating action:

1. ensure the target tab/chat identity;
2. acquire the per-chat lease;
3. inspect composer;
4. detect unexpected user-entered draft text;
5. if draft is non-empty and not owned by the current workflow, return `BLOCKED_BY_USER`;
6. do not erase or overwrite the draft;
7. reschedule or request user attention according to workflow policy.

This must be an invariant, not an optional UI preference.

## 7. Dependency policy after this cycle

### Add soon

- `dexie` — durable IndexedDB abstraction.
- `xstate` — persisted workflow/state-machine model.
- `@webext-core/messaging` — typed extension-context messaging.
- `dom-accessibility-api` — semantic accessible-name computation.
- `p-queue` — ephemeral concurrency/backpressure only.

### Keep for tests

- `vitest` — already present.
- Playwright — E2E / real-browser acceptance tests.
- `@webext-core/fake-browser` if WXT test integration is adopted.

### Reference, not baseline dependency

- Playwright Chrome Extension / MCP extension.
- browser-control.
- Cereon Browser Operator.
- chrome-use.
- playwriter.
- chromeflow.
- BrowserHand.
- Automa.
- UI.Vision.

## 8. Concrete implementation order

1. Introduce domain IDs and typed protocols (`ProjectId`, `ChatId`, `WorkflowRunId`, `ActionId`).
2. Add Dexie schema and migrations.
3. Add typed messaging.
4. Implement `SemanticSnapshotBuilder` using `dom-accessibility-api`.
5. Implement `TabRegistry` / `ensureTargetReady`.
6. Implement `ChatGPTAdapter` against semantic snapshots.
7. Implement evidence-bearing `ActionResult`.
8. Add per-chat durable lease + fencing token.
9. Add global `p-queue` dispatcher with conservative configurable concurrency.
10. Add XState persisted workflow runtime.
11. Add alarm reconciliation and missed-run policies.
12. Add mutation/copy/forward validators.
13. Add user-collision protection.
14. Add Playwright acceptance tests against a dedicated test profile.
15. Only after failures prove a need, evaluate `chrome.debugger`/native relay escalation.

## 9. Acceptance criteria from this research

The implementation should not be considered stable until all of these pass:

- 20+ registered chats can be queued without multiple mutations to the same chat.
- The service worker can terminate while jobs are queued; after restart jobs are reconstructed from Dexie rather than lost.
- A stale workflow holding an expired lease cannot mutate after a newer fencing token is issued.
- Semantic control lookup works without generated CSS class names.
- A manually typed user draft is never overwritten.
- Changing the active foreground tab does not redirect an action to the wrong chat.
- An action has evidence showing the before/after state that justified success.
- Debugger/native-host permissions are not required for the normal ChatGPT send/wait/capture/forward loop.

## Final recommendation

Nika should remain a **ChatGPT-specific, semantic-DOM-first Manifest V3 extension** with durable state in IndexedDB and an optional replaceable browser transport boundary.

The major new reusable components from this research are `dom-accessibility-api` for resilient semantic targeting and `p-queue` for ephemeral concurrency/backpressure. They solve narrow infrastructure problems well without changing the durable architecture.

The growing ecosystem of Playwright Extension, browser-control, Cereon, chrome-use and playwriter is important mainly because it confirms that real authenticated Chrome can be controlled reliably through an extension/relay model. Nika should preserve that option as an escalation path, not pay its complexity cost before the ChatGPT-specific content-script path proves insufficient.
