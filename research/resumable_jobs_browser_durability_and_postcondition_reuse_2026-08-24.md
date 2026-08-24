# Resumable jobs, browser durability, and postcondition reuse

Date: 2026-08-24
Repository: `Oleksii-debug/Nika-agent`

## Executive decision

The latest open-source landscape suggests a useful refinement to the Nika-agent runtime plan: we should distinguish three layers that are currently easy to conflate:

1. **workflow state** — what logical step should run next;
2. **durable event/job history** — what happened, in what order, and what a restarted consumer has already seen;
3. **browser side effects** — what actually happened in ChatGPT and whether the result can be proved.

XState remains a good fit for step/state semantics. Dexie remains the right local persistence substrate. But two newer open-source projects are now worth explicit evaluation for the durable-job/event-history layer: `@inbrowser/resumable` and Weft.

The recommendation is **not** to replace the current architecture immediately. Instead:

- keep `XState + Dexie` as the baseline implementation target;
- prototype `@inbrowser/resumable` as a possible reusable ordered event-log/job substrate;
- treat Weft as a high-value durability reference and future candidate, but not a production dependency yet because its browser/WebExtension surfaces are pre-1.0 and explicitly still experimental;
- reuse the postcondition/evidence patterns from modern browser-agent projects, but keep ChatGPT-specific verification inside Nika's `SiteProfile`/`ChatGPTAdapter`.

---

## 1. New candidate: `@inbrowser/resumable`

Repository: `davideast/inbrowser-agent`
License: MIT
Current package status observed: pre-1.0 (`0.4.0`).

The important package is not the AI agent itself but `@inbrowser/resumable`.

It already provides:

- `createJobEngine()`;
- browser-persistent `createIdbJobStore()`;
- append-only ordered event streams with sequence numbers;
- resumable subscriptions from a prior offset;
- `get()` / `stop()` lifecycle;
- MessagePort hosting/connection helpers;
- store durability probes;
- TTL/sweep support;
- a backend-agnostic storage interface.

The key pattern is:

`producer -> durable ordered event log -> subscriber resumes from last seq`

That is directly relevant to Nika because a restarted service worker should not have to reconstruct all runtime knowledge from ad-hoc log arrays.

### Potential Nika use

A Nika workflow/job could emit typed events such as:

- `JOB_ENQUEUED`;
- `LEASE_ACQUIRED`;
- `SEND_PREPARED`;
- `SEND_DISPATCHED`;
- `USER_MESSAGE_OBSERVED`;
- `RESPONSE_STARTED`;
- `RESPONSE_STABLE`;
- `RESPONSE_CAPTURED`;
- `FORWARD_PREPARED`;
- `FORWARD_OBSERVED`;
- `JOB_COMPLETED`;
- `AMBIGUOUS_EFFECT`.

A UI, scheduler, recovery worker, or future server bridge can subscribe from the last sequence number it processed.

This is cleaner than storing one mutable `currentRun` object plus a monolithic log array.

### Benefits versus writing it ourselves

- ordered durable history is already modeled;
- consumer resume offsets are already a first-class primitive;
- IndexedDB persistence is built in;
- the storage layer is swappable;
- the engine can live behind a MessagePort/Worker boundary;
- no internal dependencies for the resumable package itself.

### Limits

It is not a full workflow engine. It does not replace:

- XState statecharts;
- Nika's scheduler semantics;
- per-chat leases/fencing;
- side-effect idempotency/reconciliation;
- ChatGPT DOM validation.

Also, the project is pre-1.0 and explicitly warns that breaking changes are expected.

### Decision

**PILOT / EVALUATE, not baseline dependency yet.**

A developer spike should test whether `@inbrowser/resumable` can back one Nika job with IndexedDB, survive extension reload/service-worker restart, and resume a second consumer from the last processed sequence without duplicate event delivery.

If the spike is clean, it may replace a substantial amount of custom append-only event-history code while Dexie remains the primary relational/indexed state store for agents, schedules, leases, and projections.

---

## 2. New candidate: Weft

Repository: `stevekinney/weft`
License: MIT
Observed current release: `0.19.0`.

Weft is much closer to a true durable workflow runtime.

Relevant capabilities:

- checkpoint-based workflow execution;
- recovery from last checkpoint instead of replaying from the beginning;
- durable sleeps;
- signals, updates, and queries;
- human review checkpoints;
- shared durable state/CAS primitives;
- idempotent workflow starts;
- browser execution through Web Workers/Service Worker persistence;
- `IndexedDBStorage` and `WebExtensionStorage` adapters;
- host-driven maintenance mode for environments where background timers cannot remain alive;
- explicit activity attempt/execution tokens for fencing stale attempts.

The project also explicitly documents the same external-side-effect limitation already identified in Nika: if an external activity completes but the workflow crashes before its result is committed, the activity may be dispatched again unless the external system offers idempotency, lookup/verification, or fencing.

That is exactly the correct model for ChatGPT UI automation.

### Why Weft is technically attractive

Its checkpoint model fits MV3 better than a workflow engine that expects a permanently alive process.

The `backgroundTasks: 'manual'` / `runMaintenance()` pattern is particularly relevant: Chrome alarms can wake the extension, then Nika can run one bounded maintenance/recovery cycle and stop. That is much closer to proper MV3 behavior than perpetual polling loops.

Its activity attempt tokens also mirror the fencing-token pattern already selected for per-chat mutation ownership.

### Why not adopt it now

The project itself marks browser surfaces as experimental until real-browser smoke tests become required CI gates. It is pre-1.0 and still has breaking-change risk.

There is also a mismatch with Nika's immediate scope: adopting a full workflow runtime now could force a larger rewrite while the current application is still establishing basic ChatGPT adapter, storage, leases, and validation contracts.

### Decision

**REFERENCE + FUTURE SPIKE.**

Do not replace XState with Weft in the current implementation wave.

However, developers should study and selectively mirror these patterns now:

- checkpoint before advancing past side-effect boundaries;
- explicit activity attempt token/fencing;
- maintenance driven by an external wake-up mechanism;
- recovery registration before resuming work;
- separate durable workflow data from live host services/adapters;
- honest documentation of the external side-effect crash window.

After Nika's first reliable browser MVP exists, run a controlled comparison:

`XState + Dexie custom durability` vs `Weft browser/WebExtension durability`.

---

## 3. Modern browser-agent projects reinforce postcondition-first execution

`uiuing/browser-agent` remains a strong current reference for a separate but related layer.

It treats page actions as typed tools with:

- schema validation;
- risk tiers;
- permission/site-policy checks;
- audit logging;
- explicit postconditions;
- expected vs actual values;
- evidence returned with success or failure.

This confirms the Nika rule:

**a DOM event dispatch is not a successful browser action until a postcondition proves the intended state transition.**

For ChatGPT this means:

### `SEND_MESSAGE`

Expected postconditions should include at least:

- composer contained the intended prompt before submit;
- a new user-message appeared after submit;
- normalized user-message text/hash matches the intended prompt;
- the conversation remained the expected target;
- generation began OR a known terminal error state appeared.

### `CAPTURE_RESPONSE`

Expected postconditions:

- latest assistant response is non-empty;
- response identity/hash differs from the already-consumed one when a new response is required;
- response has reached stable/idle state;
- captured text belongs to the correct conversation.

### `FORWARD_RESPONSE`

Expected postconditions:

- the destination composer received the exact routed payload;
- destination user-message subsequently contains the expected payload/hash;
- the source response identity is recorded as forwarded to that exact target;
- repeating the same forwarding job is rejected by the durable dedupe key unless explicitly overridden.

---

## 4. Semantic DOM candidates: keep the current direction

Recent generic browser projects continue converging on accessibility/semantic representations rather than raw HTML or coordinate clicking.

Examples observed this cycle:

- `malovlab/agent-browser`: Accessibility Tree -> typed page elements -> action discovery;
- `freshtechbro/opendevbrowser`: accessibility-tree snapshot -> stable refs -> actions;
- `uiuing/browser-agent`: semantic snapshots with accessible names, values, interactivity, occlusion, iframe/shadow-DOM handling.

This does not justify replacing Nika's current planned `SemanticSnapshotBuilder`.

Instead it reinforces these requirements:

- snapshot only relevant interactive/state nodes;
- use role + accessible name + state before CSS classes;
- attach every temporary ref to a `snapshotId`;
- reject stale refs after navigation/reload/material DOM change;
- keep ChatGPT-specific element interpretation inside the site profile/adapter;
- return evidence with every mutating action.

---

## 5. Revised storage architecture

The previous plan used Dexie for most durable state. Keep that, but clarify data ownership.

### Dexie tables remain authoritative for projections/state

Recommended durable tables:

- `agents`;
- `projects`;
- `workflows`;
- `workflowRuns`;
- `jobs`;
- `schedules`;
- `leases`;
- `effects`;
- `responses`;
- `forwards`;
- `adapterHealth`;
- `snapshotsMetadata`;
- `logs`/`evidence`.

### Ordered event history may be a separate abstraction

Two viable implementations:

A. custom Dexie event table:

`runEvents(runId, seq, type, payload, timestamp)`

B. pilot `@inbrowser/resumable` for ordered durable event delivery.

Do not put large response bodies repeatedly into mutable aggregate records. Store response/evidence records separately and refer to them by IDs/hashes.

---

## 6. Scheduling architecture remains unchanged, but job durability becomes clearer

Continue with:

`Dexie schedule source-of-truth -> one chrome.alarms wake-up -> reconcile due schedules -> enqueue durable jobs -> paced dispatcher`.

A schedule occurrence should create a durable `Job` once.

The dispatcher consumes Jobs; it must never infer missing jobs directly from alarm delivery alone.

Recommended Job states:

- `QUEUED`;
- `NOT_BEFORE`;
- `ACQUIRING_LEASE`;
- `RUNNING`;
- `WAITING_EXTERNAL`;
- `AMBIGUOUS`;
- `NEEDS_USER`;
- `COMPLETED`;
- `FAILED`;
- `CANCELLED`.

This state should survive browser/service-worker restart.

---

## 7. Important distinction: event-log durability does not solve side-effect ambiguity

Even if Nika adopts `@inbrowser/resumable` or Weft, neither library can magically make ChatGPT's Send button transactional.

The critical rule remains:

`local durable intent + browser action + browser observation`

If failure occurs after the browser action but before observation, state becomes `AMBIGUOUS`.

Recovery must inspect ChatGPT before deciding whether to resend.

No workflow library should be allowed to silently retry a mutating ChatGPT activity merely because the local step result was missing.

---

## 8. Dependency decision table

| Candidate | Role | License | Maturity | Decision |
|---|---|---|---|---|
| Dexie | IndexedDB application state | Apache-2.0 | Mature | ADOPT |
| XState v5 | workflow/statechart semantics | MIT | Mature | ADOPT |
| p-queue | in-memory dispatch/backpressure | MIT | Mature | ADOPT for dispatcher only |
| `@inbrowser/resumable` | ordered resumable browser job/event log | MIT | Pre-1.0 | PILOT |
| Weft | full durable workflow/checkpoint runtime | MIT | Pre-1.0; browser surface experimental | REFERENCE / FUTURE SPIKE |
| `uiuing/browser-agent` | action/postcondition/evidence design | open-source reference | active | REFERENCE |
| OpenDevBrowser | AX snapshot/ref/session patterns | open-source reference | active | REFERENCE |
| agent-browser | semantic AX action discovery | open-source reference | active | REFERENCE |

---

## 9. New implementation priority

The research now supports a concrete next sequence:

1. migrate durable runtime data from `chrome.storage.local` arrays to Dexie;
2. define `Job`, `Effect`, `RunEvent`, `ResponseIdentity`, and `Evidence` contracts;
3. implement one durable scheduler wake/reconciliation loop;
4. implement paced dispatcher with `p-queue` plus durable `notBefore/lastDispatchAt` checks;
5. implement per-chat lease + fencing;
6. implement PREPARE/DISPATCH/OBSERVE/COMMIT/AMBIGUOUS send journal;
7. implement validated ChatGPT postconditions;
8. implement event-driven stable-response observation;
9. add a tiny `@inbrowser/resumable` spike behind an interface and compare it with a custom Dexie append-only event table;
10. keep Weft out of production dependency graph until its browser promotion gate is green and Nika has a stable MVP baseline;
11. add forced-crash tests around every side-effect boundary.

---

## 10. Acceptance experiments for the next research/development wave

### Experiment A — durable event resume

- create one job;
- append events 1..5;
- destroy/recreate worker/runtime;
- resume subscriber from seq 3;
- prove only 4..5 are delivered;
- prove terminal status remains queryable.

Run once with custom Dexie event table and once with `@inbrowser/resumable`.

### Experiment B — crash after Send click

- prepare prompt;
- dispatch click;
- simulate worker death before success acknowledgement;
- restart;
- ensure job is `AMBIGUOUS`, not automatically retried;
- inspect DOM;
- if user-message exists, reconcile as committed;
- if evidence proves it did not occur, allow controlled retry.

### Experiment C — 50 due jobs

- enqueue 50 jobs at the same logical due time;
- enforce global spacing and concurrency;
- restart service worker mid-run;
- prove spacing survives restart;
- prove no duplicate Job creation and no duplicate committed SEND.

### Experiment D — manual-user collision

- user enters unsent composer text;
- automation attempts SEND;
- action returns `BLOCKED_BY_USER`/`NEEDS_USER`;
- no reload, clear, overwrite, click, or Enter occurs.

---

## Final conclusion

The newest open-source work does not justify another architecture reset. It does, however, reveal a useful opportunity to reuse **durable ordered job/event infrastructure** rather than building every recovery primitive ourselves.

The near-term architecture remains:

`WXT + TypeScript + Dexie + XState + p-queue + semantic ChatGPT adapter + verified side effects`.

The strongest new candidate for selective reuse is `@inbrowser/resumable` because it is small, MIT-licensed, IndexedDB-backed, and specifically built around resumable ordered browser jobs. Weft is architecturally impressive and validates many of Nika's durability decisions, but its browser/WebExtension layer is not mature enough yet to become the core runtime.

The core product principle remains unchanged: Nika-agent should be a deterministic, durable browser workflow system that can prove what happened, recover from interruption, and refuse to guess when a browser side effect is ambiguous.
