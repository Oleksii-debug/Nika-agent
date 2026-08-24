# Nika-agent research — browser state tiers and server durable workflows

Date: 2026-08-24

## Scope

This cycle intentionally does not search for another generic browser agent. It answers two narrower questions:

1. Which additional Chrome/MV3 primitives improve the existing extension runtime without turning it into a fragile persistent-background hack?
2. Which durable workflow engines are appropriate for the future 24/7 Nika Server, and which should **not** be embedded in the browser extension?

The current repository already implements a WXT + TypeScript MV3 extension with schedules, ChatGPT tab reuse, idle detection, prompt submission, response capture and basic workflows. The goal is to reduce custom reliability code while keeping the browser runtime small.

---

## Executive decisions

### Decision A — keep browser workflows local and lightweight

Keep the Chrome extension on the current direction:

- WXT + TypeScript;
- ChatGPT content adapter;
- Chrome tabs/alarms/messaging;
- Dexie/IndexedDB for durable browser-local state;
- XState for resumable workflow state;
- p-queue only as an in-memory dispatcher;
- semantic DOM / ARIA targeting.

Do **not** embed Temporal, Restate, Inngest or another server-oriented durable workflow runtime into the extension.

Reason: MV3 service workers are intentionally ephemeral. The extension should checkpoint state and resume, not attempt to become a permanently running server process.

### Decision B — define three browser state tiers

Use three explicit storage/lifetime tiers instead of one generic `storage` abstraction:

1. **Durable local state** — IndexedDB/Dexie
   - projects;
   - chats;
   - workflows;
   - schedules;
   - idempotency ledger;
   - run history;
   - durable leases/fencing metadata;
   - last known workflow checkpoint.

2. **Browser-session cache** — `chrome.storage.session`
   - recently resolved `tabId` / `windowId` bindings;
   - content-script heartbeat timestamps;
   - short-lived semantic snapshot metadata;
   - transient dispatcher state that may be rebuilt after browser restart.

3. **Page-local live state** — content script / DOM
   - current composer contents;
   - generating/idle state;
   - current assistant response mutation state;
   - current accessible controls.

This separation prevents stale tab IDs or UI state from being treated as durable truth.

### Decision C — do not use Offscreen Documents as a persistent background page

Chrome's `chrome.offscreen` API is useful, but only for narrowly scoped DOM/window features unavailable in service workers. Chrome explicitly warns against treating it as a background-page replacement.

For Nika-agent, baseline uses should be limited to future needs such as:

- clipboard compatibility fallback;
- DOMParser-style work if a normal extension context is insufficient;
- specific iframe/DOM-scraping support if later needed.

Do **not** use an offscreen document to keep workflow timers, queues or orchestration continuously alive.

The source of truth remains Dexie; `chrome.alarms` wakes the service worker; the worker reconstructs execution state.

Reference:
- https://developer.chrome.com/docs/extensions/reference/api/offscreen
- https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers

### Decision D — future Nika Server should use a real durable-execution runtime rather than copying the browser implementation

The server product has a different failure model. It may run 24/7, coordinate many projects, wait hours/days, process API events and manage browser executors. Here a true durable workflow engine becomes valuable.

Shortlist:

1. Temporal — strongest mature option.
2. TanStack Workflow — most interesting lightweight/permissive TypeScript-native emerging option.
3. Restate — excellent technical match, especially keyed single-writer state, but BSL licensing must be considered.
4. Inngest — excellent developer experience and scheduling, but the self-hosted server license is not permissive open source.

---

## Chrome MV3 findings

### 1. `chrome.storage.session` is useful as a cache, not source of truth

Chrome documents `storage.session` as in-memory extension storage that survives service-worker restarts but is cleared on browser restart, extension reload/update or disable.

This exactly matches transient Nika state that is expensive but safe to recompute.

Recommended examples:

```text
session.tabBinding.CHAT_17 = {
  tabId,
  windowId,
  validatedAt
}

session.bridgeHeartbeat.CHAT_17 = timestamp
session.lastSemanticFingerprint.CHAT_17 = hash
```

Never store only in `storage.session`:

- scheduled jobs;
- completed-step evidence;
- idempotency keys;
- authoritative run state;
- workflow checkpoints.

Reference:
- https://developer.chrome.com/docs/extensions/reference/api/storage

### 2. Offscreen documents are a specialized tool

Useful property: an offscreen document has `window`/DOM APIs while the MV3 service worker does not.

Important limitations:

- only one normal-profile offscreen document per installed extension;
- it cannot be focused;
- only `chrome.runtime` extension API is exposed there;
- creation requires an explicit reason and justification;
- it is not intended as a generic persistent background replacement.

Therefore Nika should not move scheduling, durable queues or workflow actors into an offscreen page.

Potential future capability:

```text
ClipboardTransport
  primary: direct DOM extraction and forwarding
  fallback: offscreen document with CLIPBOARD reason
```

This keeps clipboard support isolated rather than infecting the core workflow runtime.

### 3. Frozen and discarded tabs reinforce `ensureTargetReady()`

Chromium exposes separate `frozen` and `discarded` tab states.

A frozen tab remains loaded in memory but cannot execute tasks/event handlers/timers. A discarded tab has unloaded page content and reloads later.

Consequences for Nika:

- a remembered tab ID is only a hint;
- a successful `chrome.tabs.get(tabId)` is not proof that the ChatGPT bridge is operational;
- readiness requires a content-script heartbeat or semantic probe;
- recovery should prefer re-resolution/reload over permanently disabling browser tab discarding.

This confirms the existing SessionAdoption/TabRegistry direction.

---

## Durable server workflow comparison

### Temporal

Repository:
- https://github.com/temporalio/temporal
- https://github.com/temporalio/sdk-typescript

License:
- Temporal server: MIT.
- TypeScript SDK: MIT.

Maturity:
- very high;
- long production history;
- Temporal server release v1.31.2 was published July 8, 2026.

Strengths for Nika Server:

- crash-safe long-running workflows;
- durable timers;
- activities for browser/API/GitHub actions;
- retries and backoff;
- signals/events;
- strong replay model;
- mature Web UI and observability;
- good fit for workflows lasting hours or days;
- OpenAI Agents SDK integration exists for durable agent orchestration.

Cost:

- operationally heavier than the alternatives;
- requires Temporal server/worker architecture;
- deterministic workflow constraints require discipline.

Recommendation:

**Best choice if Nika Server becomes a serious 24/7 multi-project orchestration service.**

Do not use inside Chrome extension.

### TanStack Workflow

Repository:
- https://github.com/TanStack/workflow

License:
- MIT.

Status as of this research:
- new/young project;
- TypeScript-first;
- core engine + runtime + storage/deployment adapters;
- durable execution uses append-only history/replay;
- runtime owns schedules, timers, signals, approvals and leases.

Particularly interesting primitives:

- `ctx.step`;
- `waitForEvent`;
- approvals;
- durable sleep/sleepUntil;
- execution leases;
- version routing;
- pluggable RunStore.

Strengths for Nika:

- excellent conceptual match to a TypeScript server;
- much less infrastructure weight than Temporal;
- permissive MIT license;
- architecture explicitly separates core engine, runtime and adapters — the same boundary Nika wants.

Weaknesses:

- far younger and much less battle-tested than Temporal;
- current supplied durable stores/deployment adapters are server/database oriented, not browser IndexedDB oriented;
- adopting it as the extension engine today would add risk with little benefit.

Recommendation:

**Track closely for Nika Server; do not replace XState in the browser extension now.**

It is the most interesting future option if the team wants a TypeScript-native durable server without Temporal's operational weight.

Reference:
- https://github.com/TanStack/workflow
- https://github.com/TanStack/workflow/blob/main/docs/guide/runtime-model.md

### Restate

Repository:
- https://github.com/restatedev/restate

License:
- Business Source License 1.1 for current Restate server releases, with a delayed Apache-2.0 change license.
- This is source-available, not OSI open source today.

Technical strengths:

- durable async execution;
- exactly-once reliable communication;
- durable timers;
- keyed services/state;
- single-writer-per-key style isolation;
- workflow/agent support;
- single-binary server is operationally attractive.

Why it is unusually relevant to Nika:

A ChatGPT conversation can naturally be represented by a keyed object/service:

```text
ChatActor(chatId)
```

All mutating commands for the same chat become serialized by the runtime. That could replace a significant amount of custom per-chat lease/fencing logic on the **server**.

The browser extension still needs local collision protection because it may operate offline from the server and shares Chrome with the human user.

Recommendation:

**Strong technical reference / possible internal server runtime, but licensing must be explicitly accepted before dependency adoption.**

Reference:
- https://github.com/restatedev/restate
- https://github.com/restatedev/restate/blob/main/LICENSE

### Inngest

Repositories/docs:
- https://github.com/inngest/inngest
- https://github.com/inngest/inngest-js
- https://www.inngest.com/docs/self-hosting

Strengths:

- excellent TypeScript developer experience;
- events, cron, durable functions;
- retries;
- concurrency controls;
- rate limiting;
- step checkpoints;
- strong run-history/dashboard UX;
- self-hosting became a first-class supported path in January 2026.

Licensing caveat:

- SDKs are Apache-2.0;
- the self-hosted Inngest server/CLI uses Server Side Public License plus delayed open-source publication.

Recommendation:

**Excellent UX/reference for scheduler and observability design, but not the first choice if Nika requires a clean permissive-open-source server stack.**

### Avatar Engine

Repository:
- https://github.com/avatar-runtime/avatar-engine

License:
- Apache-2.0.

Positioning:
- new durable execution engine explicitly aimed at AI agents;
- crash-safe workflows;
- idempotent tool execution;
- deterministic replay;
- exactly-once side effects;
- Postgres-backed.

Recommendation:

Interesting research/reference because its problem statement is extremely close to future Nika AI orchestration, but too new to select as foundational infrastructure before broader adoption and production evidence exist.

---

## Comparison table

| Engine | Browser extension | Future Nika Server | License | Maturity | Key reason |
|---|---|---:|---|---|---|
| XState + Dexie | **YES** | possible but limited | MIT / Apache-2.0 | high | smallest correct browser solution |
| Temporal | NO | **YES — strongest mature option** | MIT | very high | crash-safe durable workflows at scale |
| TanStack Workflow | NO for now | **PROMISING** | MIT | early | TypeScript-native, lightweight durable runtime |
| Restate | NO | STRONG technical fit | BSL 1.1 → Apache later | high/growing | keyed single-writer durable state |
| Inngest | NO | good reference / possible deployment | server SSPL/DOSP; SDK Apache-2.0 | high | scheduling, event UX, retries, observability |
| Avatar Engine | NO | research candidate | Apache-2.0 | early | agent-specific durable execution |

---

## Architectural consequence: one protocol, two runtimes

The extension and server should not share the same execution engine, but they **should share the same job/action protocol**.

Example:

```ts
type NikaJob = {
  jobId: string;
  projectId: string;
  targetChatId?: string;
  action: BrowserCommand | CoordinatorCommand;
  idempotencyKey: string;
  createdAt: string;
};
```

Browser runtime:

```text
Dexie + XState
↓
NikaJob
↓
ContentScriptTransport
↓
ChatGPT
```

Future server runtime:

```text
Temporal OR TanStack Workflow / Restate
↓
NikaJob
↓
Browser Executor / GitHub / API Planner
```

This avoids coupling the Chrome codebase to an eventual server technology decision.

---

## Recommended storage design change

Current code uses `chrome.storage.local` for agents/workflows/logs. This is acceptable for the current MVP, but before large-scale 30–100 chat operation the durable runtime should move to IndexedDB/Dexie as already planned.

Use `chrome.storage.local` primarily for:

- tiny boot/config flags;
- extension preferences;
- migration markers;
- perhaps last-opened UI state.

Use Dexie for high-volume runtime data and indexed queries.

Use `chrome.storage.session` for reconstructable browser-session cache.

This three-tier split should become an explicit architecture invariant.

---

## What developers should NOT build now

1. Do not implement a custom server-grade durable workflow engine inside the extension.
2. Do not use an offscreen page to fake an MV2 persistent background page.
3. Do not put authoritative schedules or workflow state only in `chrome.storage.session`.
4. Do not make a remembered `tabId` authoritative.
5. Do not adopt Temporal/Restate/Inngest until the actual Nika Server development starts.
6. Do not replace XState with TanStack Workflow in the extension merely because TanStack Workflow is newer.

---

## Immediate implementation implications for Nika-agent extension

Recommended next slices after existing work:

1. Add storage lifetime taxonomy to architecture docs.
2. Move transient tab/heartbeat cache to `chrome.storage.session` where useful.
3. Keep durable agent/workflow/schedule/run/idempotency data migration target = Dexie.
4. Keep ChatGPT live state only in content adapter/snapshot.
5. Add explicit frozen/discarded handling to `ensureTargetReady()` tests.
6. Add optional `OffscreenClipboardAdapter` only when clipboard fallback becomes an actual requirement.
7. Define shared `NikaJob` / `BrowserCommand` protocol now so the future server can drive the same browser executor without rewriting the extension.

---

## Final recommendation

For the **current Chrome extension**, do not broaden the technology stack further. The correct design is still a deterministic, browser-local runtime that tolerates MV3 termination through persisted checkpoints.

For the **future server program**, do not duplicate that implementation. Evaluate a real durable execution engine at the point server work starts:

- choose **Temporal** when maximum maturity/reliability matters more than infrastructure simplicity;
- evaluate **TanStack Workflow** when a small TypeScript-native MIT stack is preferred and its maturity has improved;
- consider **Restate** if keyed actor semantics materially simplify chat ownership and its BSL terms are acceptable;
- use **Inngest** mainly as an excellent design/UX reference unless its licensing/deployment model is explicitly desired.

The long-term architecture should therefore be **one Nika job protocol, two specialized runtimes** rather than forcing the browser and server to share one workflow engine.
