# Browser lifecycle, ref execution, and server orchestration decisions

Date: 2026-08-24
Repository: `Oleksii-debug/Nika-agent`

## Executive decision

This research cycle narrows three areas that materially affect Nika-agent reliability and future architecture:

1. Chrome tab lifecycle must become a first-class runtime state, not an incidental recovery condition.
2. Ref-based semantic execution is now a sufficiently proven browser-automation pattern to formalize in Nika's `SemanticSnapshot`/`DomDriver` boundary.
3. The Chrome extension should remain a lightweight local runtime, while future always-on/server orchestration should use a server-grade durable queue/workflow system instead of forcing those responsibilities into Manifest V3.

No new large browser framework should be adopted wholesale. The best strategy remains selective reuse of libraries and proven patterns around the existing WXT/TypeScript architecture.

---

## 1. Chrome tab lifecycle must be part of target readiness

Modern Chrome exposes separate tab states for `frozen` and `discarded`.

Chrome 132+ exposes `Tab.frozen`: a frozen tab remains loaded in memory but cannot execute tasks, including timers and event handlers. A discarded tab remains visible in the tab strip but its content has been unloaded; it reloads when activated.

This matters directly to Nika because a ChatGPT tab can have a valid `tabId` while being unable to service a content-script message.

The target-readiness contract should therefore become:

```text
resolve chat binding
  -> chrome.tabs.get(tabId)
  -> validate canonical conversation URL
  -> if discarded: recover/reload according to policy
  -> if frozen: do not treat content-script timeout as ordinary messaging failure
  -> validate content-script heartbeat
  -> validate ChatGPT site profile
  -> acquire WRITE lease if mutating
  -> execute
```

Recommended target states:

```text
MISSING
LOADING
READY
FROZEN
DISCARDED
CONTENT_UNAVAILABLE
SITE_INCOMPATIBLE
BLOCKED_BY_USER
RECOVERY_REQUIRED
```

A generic `sendMessage() failed -> reload tab -> retry` path is unsafe. A frozen tab, stale content context, actual page error and an already-committed SEND are different conditions and require different recovery logic.

Sources:
- Chrome tabs API: https://developer.chrome.com/docs/extensions/reference/api/tabs
- Chrome Page Lifecycle API: https://developer.chrome.com/docs/web-platform/page-lifecycle-api

### Decision

Use native Chrome `tab.frozen` / `tab.discarded` checks in `TabRegistry` and `ensureTargetReady()`. Do not add PageLifecycle.js as a runtime dependency for a Chrome-first extension; native signals are sufficient and reduce dependency surface.

The content script may still listen to `freeze`, `resume`, `visibilitychange`, and `pageshow` for diagnostics/evidence, but durable authority remains in background storage, not page memory.

---

## 2. WXT already gives a safer content-script lifecycle boundary

WXT's content-script context tracks invalidation and provides context-bound timers/event helpers. It also exposes `wxt:locationchange` specifically for SPA navigation, where content scripts do not rerun simply because an SPA path changes.

ChatGPT is a SPA, so Nika should not assume that one content-script initialization maps to one conversation forever.

The ChatGPT content layer should react to logical navigation and invalidate stale conversation state:

```text
wxt:locationchange
  -> recompute conversation identity
  -> invalidate SemanticSnapshot refs
  -> update TabRegistry binding
  -> re-run SiteProfile health check
```

This removes another source of stale DOM references.

Source:
- WXT content scripts: https://wxt.dev/guide/essentials/content-scripts

### Decision

Use WXT's own context/lifecycle helpers before adding another SPA navigation or content-script lifecycle library.

---

## 3. Ref-based semantic execution is now a mature enough pattern

Several recent browser-automation projects converge on the same execution pattern:

```text
snapshot -> short semantic refs -> action -> fresh snapshot -> verification
```

### OpenDevBrowser

`freshtechbro/opendevbrowser` is particularly valuable as an architecture reference. It supports:

- accessibility-tree snapshots;
- stable action refs;
- backend-node resolution;
- logged-in tabs through an extension relay;
- target-aware FIFO execution for work on the same tab;
- structured DOM inspection;
- diagnostics and replay.

A key pattern for Nika is target-scoped FIFO: independent chats may run concurrently, but mutations to one target are serialized.

Source:
- https://github.com/freshtechbro/opendevbrowser

### browserclaw

`idan-rubin/browserclaw` reinforces the same idea with accessibility snapshot refs mapped to Playwright locators. Its useful architectural property is that targeting is deterministic after the snapshot; an LLM is not required to reinterpret the element on every action.

Source:
- https://github.com/idan-rubin/browserclaw

### browser-agent-driver

`tangle-network/browser-agent-driver` adds an important postcondition idea: execute deterministic steps, verify expected effect, and only escalate strategy when reality deviates from the plan. This aligns with Nika's `OutcomeContract` and `ActionResult + evidence` model.

Source:
- https://github.com/tangle-network/browser-agent-driver

### Decision

Do not adopt these full runtimes inside MV3. Formalize their common pattern inside Nika:

```ts
interface SemanticSnapshot {
  snapshotId: string;
  chatId: string;
  tabId: number;
  url: string;
  pageFingerprint: string;
  nodes: SemanticNode[];
}

interface SemanticRef {
  snapshotId: string;
  ref: string;
}
```

A `SemanticRef` must be rejected if its `snapshotId` is stale.

For ChatGPT, snapshots should remain bounded to the interaction surface:

- composer;
- send button;
- stop/generating control;
- continue-generation control;
- latest user message;
- latest assistant response;
- login/error/rate-limit controls.

Do not ship whole-page HTML into the workflow runtime.

---

## 4. Same-target FIFO should be explicit even if p-queue is used

OpenDevBrowser's target-scoped FIFO is a useful distinction from a simple global concurrency queue.

Nika needs three layers:

```text
Global paced dispatcher
    -> controls overall launch rate/concurrency

Per-chat FIFO
    -> preserves mutation order for one conversation

Durable lease + fencing token
    -> survives crashes and rejects stale owners
```

`p-queue` can implement the first two operationally, but it cannot replace durable ownership because its queue state is memory-resident.

Recommended invariant:

```text
same chat + WRITE actions = strictly serialized
same chat + READ actions = may coexist only when safe
other chats = parallel subject to global rate/concurrency policy
```

This should be encoded as a runtime contract, not merely emerge from current implementation order.

---

## 5. Page lifecycle changes how background ChatGPT observation should work

The Page Lifecycle API explicitly states that frozen pages cannot execute timers or event handlers. Therefore a content-script MutationObserver cannot be considered a guaranteed always-on watcher for 30-100 background tabs.

This changes the role of `MutationObserver`:

Wrong model:

```text
content script watches every ChatGPT tab forever
```

Correct model:

```text
when tab is runnable:
  MutationObserver gives fast state changes

when tab is frozen/discarded/unavailable:
  durable background state records WAITING
  scheduler/recovery later re-acquires target
  adapter re-observes page and reconciles state
```

The workflow must survive missing browser observation intervals.

### Decision

`MutationObserver` is an optimization/event source, not the durable source of truth.

---

## 6. Browser-side durable workflow candidates: Weft remains the most relevant experimental option

`stevekinney/weft` remains one of the few workflow engines whose documented storage adapters explicitly include IndexedDB and WebExtension storage and whose core can run in browser/worker environments.

Useful ideas:

- checkpointed durable workflows;
- browser/WebExtension storage adapters;
- durable waits/signals;
- host-driven maintenance/recovery cycles;
- no silent fallback to memory storage for durable defaults.

Source:
- https://github.com/stevekinney/weft

### Comparison with current Nika plan

| Concern | XState + Dexie | Weft |
| --- | --- | --- |
| State-machine clarity | Excellent | Good |
| Browser durability | Custom checkpoints required | Built-in concept |
| MV3 maturity for Nika | Controlled by us | Still a dependency risk |
| Storage flexibility | Dexie schema is ours | Multiple adapters |
| Debuggability | Explicit domain tables/events | Engine-centric |
| Adoption risk | Low | Medium/high until real-extension smoke tests |

### Decision

Do not replace XState/Dexie now. Keep Weft as a targeted spike candidate. The deciding experiment is not API aesthetics; it is whether Weft survives forced MV3 service-worker termination, browser restart and side-effect ambiguity without requiring awkward workarounds.

---

## 7. Future server orchestration: DBOS, Hatchet and Trigger.dev deserve clearer roles

The future always-on/server Nika should not inherit Chrome MV3's durability constraints. Three current open-source TypeScript-friendly systems are worth distinguishing.

### DBOS Transact

DBOS is a lightweight MIT-licensed durable TypeScript workflow library backed by Postgres. It provides durable workflows, queues, notifications and scheduling without requiring a separate workflow-orchestrator service.

Strengths for Nika Server:

- TypeScript-native;
- MIT;
- Postgres-backed checkpoints;
- durable queues;
- scheduling;
- minimal infrastructure compared with Temporal-like clusters.

Tradeoff: Postgres becomes a hard dependency and browser executors still need an external bridge/worker model.

Source:
- https://github.com/dbos-inc/dbos-transact-ts

### Hatchet

Hatchet combines durable queues, workflows, scheduling, concurrency/rate limiting, observability and a dashboard, backed by Postgres.

Strengths for Nika Server:

- queue semantics are first-class;
- rate limiting/fairness/concurrency are built in;
- durable sleeps and cron;
- execution history and UI;
- well matched to a fleet of browser workers.

Tradeoff: it is a larger standalone platform than DBOS.

Source:
- https://github.com/hatchet-dev/hatchet

### Trigger.dev

Trigger.dev is an open-source TypeScript platform for long-running tasks and AI workflows with durable tasks, retries, queues, cron, idempotency, human-in-the-loop and observability. It also supports self-hosting.

Strengths:

- developer-friendly TypeScript model;
- strong UI/observability;
- batching and queue features;
- human review;
- can run browser/system dependencies on workers.

Tradeoff: it is a broader deployment platform, and Nika would become more coupled to its runtime/deployment model.

Source:
- https://github.com/triggerdotdev/trigger.dev

### Server recommendation

If/when Nika moves to an always-on server coordinator, evaluate in this order:

1. **DBOS** if we want the lightest self-hosted TypeScript + Postgres durable runtime.
2. **Hatchet** if queue fairness, rate limiting, worker fleet management and operational dashboard dominate.
3. **Temporal** remains the mature durability benchmark for complex long-running orchestration.
4. **Trigger.dev** if managed/developer-platform ergonomics and observability are more valuable than minimal infrastructure.

Do not introduce any of these into the Chrome extension runtime itself.

---

## 8. OpenDevBrowser should be a reference and possible future bridge, not an embedded dependency

OpenDevBrowser is increasingly close to a complete external browser-control plane: extension relay, CDP sessions, named pages, accessibility refs, target FIFO, diagnostics and session reuse.

This makes it a strong future experiment for a server-controlled Nika Browser Worker.

Potential future architecture:

```text
Nika Server workflow
  -> Browser Worker command
  -> local relay / OpenDevBrowser-like transport
  -> Nika Chrome target
  -> semantic action
  -> structured evidence
```

However, embedding it into the current extension would unnecessarily introduce CDP/relay complexity and broaden permissions.

### Decision

Reference now; isolated bridge spike later.

---

## 9. Dependency decisions after this cycle

### Adopt / continue now

- WXT
- TypeScript
- Dexie
- XState
- `@webext-core/messaging`
- `dom-accessibility-api`
- `p-queue`
- native `MutationObserver`
- native `chrome.tabs` lifecycle state (`frozen`, `discarded`)
- native `chrome.alarms`

### Strong spike candidates

- Weft for browser-side durable workflow comparison
- OpenDevBrowser as a future local/server bridge reference

### Future server candidates

- DBOS
- Hatchet
- Temporal
- Trigger.dev

### Do not add now

- PageLifecycle.js (Chrome-first target makes native APIs sufficient)
- browserclaw as runtime dependency (Node/Playwright-oriented)
- generic LLM browser loops
- CDP/debugger transport in baseline extension
- another full browser automation framework

---

## 10. New implementation priorities

This research changes the near-term implementation order slightly:

```text
1. TabTargetState including frozen/discarded
2. WXT SPA location-change binding invalidation
3. SemanticSnapshot + stale-ref rejection
4. per-chat FIFO execution contract
5. durable lease + fencing
6. validated SEND postconditions
7. WAIT reconciliation that survives observation gaps
8. forced frozen/discarded E2E fixtures
9. Weft-vs-XState/Dexie durability spike
10. server orchestration ADR: DBOS vs Hatchet vs Temporal
```

### Required tests

- Target tab is frozen before SEND: no blind reload/resend.
- Target tab is discarded: re-acquire/reload, then site-health validation before mutation.
- SPA navigates to another ChatGPT conversation without a full page load: old refs are invalidated.
- Two WRITE jobs target one chat simultaneously: FIFO + one durable owner.
- MutationObserver goes silent because the page freezes: workflow remains recoverable.
- Snapshot ref from pre-navigation state is rejected after navigation/reload.
- Server-side orchestration prototype can issue an idempotent Nika Job command without knowing browser DOM details.

---

## Final conclusion

The architecture is converging around a clear separation:

```text
Durable intent/workflow
    -> paced dispatch
    -> target ownership
    -> browser lifecycle readiness
    -> bounded semantic snapshot
    -> ref-based action
    -> postcondition evidence
    -> durable commit/reconciliation
```

The most important new point is that Chrome's own lifecycle can interrupt observation and execution even when a tab still exists. Nika must therefore be resilient not only to service-worker suspension but also to frozen/discarded target pages.

For browser control, the ecosystem increasingly validates our deterministic snapshot/ref/action model. For server orchestration, mature open-source systems already solve durability, queues and scheduling, so a future Nika Server should reuse those capabilities rather than recreate them inside the extension.