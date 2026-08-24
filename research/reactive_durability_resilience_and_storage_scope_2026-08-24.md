# Reactive durability, resilience policies, and storage-scope decisions

Date: 2026-08-24
Repository: `Oleksii-debug/Nika-agent`

## Executive decision

Nika-agent should keep Dexie/IndexedDB as the authoritative browser-side persistence layer. The new research does **not** justify replacing it with RxDB, TinyBase, PGlite, or a generic event-sourcing framework.

The strongest reusable additions from this cycle are narrower:

1. use **Dexie `liveQuery()`** selectively for reactive projections and cross-context wake/update behavior;
2. evaluate **Cockatiel 4** for standardized retry/timeout/circuit-breaker policies around operations that are genuinely retry-safe;
3. keep `SEND_MESSAGE` and other externally mutating browser actions **outside generic automatic retry policies** because ambiguous side effects require observation/reconciliation, not retries;
4. model durable event history as a small append-only Dexie table rather than importing a full event-sourcing platform;
5. keep PGlite, RxDB and TinyBase as future/server/local-first references, not baseline Chrome Extension dependencies.

The architecture after this research is:

`Dexie authoritative tables + append-only event/effect journal + liveQuery projections + explicit paced dispatcher + per-chat actor/FIFO + ambiguity-safe browser actions + selective Cockatiel resilience for retry-safe boundaries`.

---

## 1. Dexie `liveQuery()` is more useful than previously credited

Dexie already provides `liveQuery()`, which converts a Dexie query into an Observable. More importantly for Nika, Dexie documents that mutations made through Dexie are broadcast across browsing contexts so that matching live queries in other contexts can wake/update.

This can reduce custom observer/plumbing code for several Nika surfaces:

- Side Panel dashboard observing `jobs` currently READY/RUNNING/WAITING;
- run history and error list;
- `ChatActor` status projections;
- global adapter health state;
- schedule next-run projections;
- durable workflow progress display.

### Important boundary

`liveQuery()` is **not** a durable scheduler and should not be the only mechanism that causes work to execute.

A service worker can terminate, tabs can freeze/discard, and an observable subscription itself is in-memory. Therefore:

- Dexie tables remain truth;
- `chrome.alarms` remains the durable wake mechanism available to the extension;
- `liveQuery()` is a reactive convenience while a context is alive;
- on wake/startup, normal reconciliation still runs.

Recommended distinction:

`Durable state change -> Dexie transaction`

then optionally:

`Dexie liveQuery -> UI/runtime projection refresh`.

Do not implement:

`liveQuery event -> assumed durable job execution guarantee`.

Source: https://dexie.org/docs/liveQuery%28%29

---

## 2. Cockatiel 4 is a strong reusable resilience library

`connor4312/cockatiel` is an MIT TypeScript resilience library. The current npm line is 4.x and the package has zero runtime dependencies.

It provides:

- Retry;
- Constant/Exponential/Delegate backoff;
- Circuit Breaker;
- Timeout;
- Bulkhead isolation;
- Fallback;
- policy composition;
- AbortSignal support;
- result-based failure filters;
- retry/breaker telemetry events;
- breaker state serialization/hydration support.

This is mature enough that Nika should avoid writing a generic retry/backoff/circuit-breaker framework from scratch.

Source: https://github.com/connor4312/cockatiel
Source: https://www.npmjs.com/package/cockatiel

### 2.1 Where Cockatiel is appropriate in Nika

Good candidates are operations whose repeated execution is safe or observational:

- read-only `runtime.health` probes;
- content-script handshake;
- read-only semantic snapshot acquisition;
- read-only tab-state resolution;
- local bridge handshake in the future;
- transient IndexedDB open/initialization failures where retry is safe;
- network calls from a future Nika Server where the remote API supports idempotency;
- read-only diagnostic operations.

Example conceptual policy:

`read-only snapshot -> timeout -> jittered retry -> circuit breaker`.

### 2.2 Where Cockatiel must NOT be applied automatically

Do not wrap these in a generic retry policy:

- `SEND_MESSAGE`;
- `FORWARD_RESPONSE`;
- destructive generic web actions;
- click actions where the external side effect may already have occurred;
- reload/navigation recovery that can destroy user state.

Reason: Cockatiel correctly retries a function when configured to do so, but it cannot know whether a non-idempotent browser side effect already happened before the channel failed.

For these operations Nika requires:

`PREPARE -> DISPATCH -> OBSERVE -> SETTLED_SUCCESS | NO_EFFECT | WRONG_EFFECT | AMBIGUOUS`.

Only `NO_EFFECT` proven by a fresh observation may qualify for controlled redispatch. `AMBIGUOUS` does not.

### 2.3 Cockatiel circuit breaker state is not authoritative durability

Cockatiel supports breaker introspection and state hydration, which is useful. However, the breaker instance lives in JavaScript memory.

Nika therefore should not depend on it as the only global/site breaker truth under MV3.

Recommended approach:

- durable breaker counters/state in Dexie for global/site/chat scopes where persistence matters;
- optionally use Cockatiel as the execution-policy implementation for short-lived retry-safe calls;
- hydrate or derive the in-memory policy from durable state on worker startup if a spike proves worthwhile.

This avoids accidentally losing all breaker knowledge when Chrome terminates the service worker.

---

## 3. Full event-sourcing libraries are currently unnecessary

A search of TypeScript event-sourcing libraries found small packages that model append-only event streams and reducers well. The pattern itself is useful, but importing a full event-sourcing abstraction provides little benefit inside Nika's Chrome runtime.

Nika's actual durability requirements are constrained and concrete:

- preserve workflow/job lifecycle;
- preserve side-effect journal;
- preserve response identity/dedupe;
- preserve leases/fencing;
- preserve scheduler decisions;
- preserve observable audit evidence.

The simplest implementation remains an append-only Dexie table:

```ts
interface RuntimeEvent {
  id: string;
  seq: number;
  streamId: string;
  type: RuntimeEventType;
  at: string;
  payload: unknown;
  correlationId?: string;
  causationId?: string;
}
```

Potential streams:

- `job:<jobId>`;
- `run:<runId>`;
- `chat:<chatId>`;
- `effect:<effectId>`;
- `adapter:chatgpt`.

### Recommended use

Use the append-only history for:

- audit/debugging;
- crash reconstruction;
- proving why an action was classified AMBIGUOUS;
- deterministic tests;
- future migration/export.

Do **not** force all current state to be recomputed from thousands of events on every service-worker wake. Keep materialized authoritative tables for jobs/runs/effects and write events in the same Dexie transaction where appropriate.

This is effectively a pragmatic hybrid:

`current durable tables + append-only event history`.

It gives most of the operational benefits without turning the extension into an event-sourcing platform.

Reference pattern: https://github.com/Brenopms/ts-event-sourcing

---

## 4. RxDB comparison

RxDB is a mature Apache-2.0 local-first reactive database with a large ecosystem, observables, replication and multiple storage backends. Current public releases are in the 17.x line.

Strengths:

- reactive queries;
- schema validation;
- replication architecture;
- mature local-first patterns;
- many runtime/storage adapters;
- strong cross-platform story.

Source: https://rxdb.info/code/

### Decision for Nika Chrome Extension

**Do not migrate from Dexie to RxDB.**

Why:

1. Nika does not currently need generic replication;
2. Dexie already provides typed IndexedDB access, transactions and cross-context reactive `liveQuery` behavior;
3. RxDB would add another abstraction layer and significantly more system surface;
4. our hardest problems are browser side effects, MV3 lifecycle, scheduling, target ownership and DOM validation — not database querying.

RxDB becomes interesting only if Nika later needs true multi-device/local-first replication of projects/workflows/run state.

---

## 5. TinyBase comparison

TinyBase 9.x is MIT, dependency-free, small, reactive, supports schemas, persistence and synchronization/CRDT patterns. It can persist to multiple stores and can synchronize through BroadcastChannel/WebSocket/custom transports.

Source: https://github.com/tinyplex/tinybase
Source: https://tinybase.org/guides/agents-guide/

Strengths:

- extremely compact;
- reactive projections;
- clean local-first model;
- optional schema layer;
- CRDT synchronization;
- strong UI-oriented reactive ergonomics.

### Decision for Nika

Do not replace Dexie with TinyBase.

TinyBase is primarily an in-memory reactive store with persistence/synchronization adapters. Nika's core state is more naturally modeled directly as durable IndexedDB tables with transactional claims, leases, effect records and ordered indexes.

Adding TinyBase would create two state models:

`TinyBase in-memory reactive truth <-> persistent backend`.

For Nika this is unnecessary because Dexie `liveQuery()` already covers the key reactivity need while keeping the authoritative representation directly in IndexedDB.

TinyBase remains a good reference for a future cross-device UI state/sync layer, not runtime job authority.

---

## 6. PGlite comparison

PGlite is an Apache-2.0/PostgreSQL-licensed WASM Postgres build that can run directly in the browser and persist through IndexedDB. It is approximately a few MB compressed and supports SQL, extensions and reactive/live-query capabilities.

Source: https://github.com/electric-sql/pglite
Source: https://pglite.dev/docs/about

Strengths:

- real SQL/Postgres semantics in browser;
- advanced relational querying;
- transactions and indexes familiar to server-side developers;
- future local AI/vector possibilities;
- reactive query extension.

### Important browser durability detail

PGlite's IndexedDB filesystem works at a virtual-filesystem/file level, loading database files into memory and flushing changed files back to IndexedDB. This is heavier than direct object-store access.

Source: https://pglite.dev/docs/filesystems

### Decision for Nika Chrome Extension

**Do not use PGlite as baseline persistence.**

Reasons:

- bundle/runtime cost is much higher;
- WAsm/Postgres startup adds complexity to MV3 wake cycles;
- Nika's tables and indexes are straightforward;
- direct Dexie transactions map well to job claiming and effect journaling;
- Postgres compatibility provides little value inside the browser extension today.

PGlite may become valuable in a future desktop/server companion that needs richer local analytics/search or vector retrieval, but not for the core extension runtime.

---

## 7. `idb` comparison

Jake Archibald's `idb` is a tiny, mature Promise/TypeScript wrapper around IndexedDB.

Source: https://github.com/jakearchibald/idb

It is excellent when an application wants very little abstraction over native IndexedDB.

### Decision

Do not replace Dexie with `idb`.

`idb` is smaller, but Nika benefits from Dexie's:

- richer query/index ergonomics;
- schema/version handling;
- transactions;
- `liveQuery()`;
- established typed-table patterns.

Moving to `idb` would reduce dependency weight but increase our own repository/query/reactivity code.

---

## 8. Recommended storage/event model after this cycle

### Authoritative tables

Proposed durable tables remain approximately:

- `projects`;
- `chats`;
- `workflows`;
- `schedules`;
- `jobs`;
- `runs`;
- `effects`;
- `responses`;
- `leases`;
- `adapterHealth`;
- `runtimeEvents`.

### Transaction boundaries

Important state transitions should be atomic inside Dexie transactions where possible.

Examples:

#### Claim job

Atomically:

- verify job READY/due;
- verify lease availability;
- allocate owner/fencing token;
- mark job CLAIMED;
- append `JOB_CLAIMED` event.

#### Prepare side effect

Atomically:

- create effect record `PREPARED`;
- attach job/run/chat IDs;
- store prompt hash/idempotency fingerprint;
- append `EFFECT_PREPARED`.

#### Observe committed side effect

Atomically:

- mark effect `SETTLED_SUCCESS`;
- save observed user-message identity;
- advance durable run checkpoint;
- append `EFFECT_SETTLED`.

This makes crash recovery much easier to reason about.

---

## 9. Reactive UI model

The Side Panel/full-page UI should not poll `chrome.storage.local` or manually refresh lists.

After Dexie migration, use reactive projections:

- due jobs;
- running chats;
- paused/cooldown chats;
- ambiguous effects;
- current adapter breaker;
- last errors;
- next scheduled runs.

Dexie `liveQuery()` can provide this directly while the UI context is open.

This gives a cleaner split:

`runtime writes durable state`

`UI observes durable state`.

The UI should not need to ask the service worker for every status row.

---

## 10. Retry taxonomy is now mandatory

Before adding Cockatiel or any retry utility, Nika needs an explicit action taxonomy.

### RETRY_SAFE

Examples:

- read snapshot;
- health probe;
- resolve tab;
- read DOM state;
- open DB;
- read schedule;
- query response identity.

Generic retry/backoff is permitted.

### RETRY_SAFE_IF_NO_EFFECT_PROVEN

Examples:

- some DOM interactions where a fresh observation proves nothing happened.

Retry is allowed only after explicit `NO_EFFECT` postcondition.

### NON_IDEMPOTENT_AMBIGUITY_SENSITIVE

Examples:

- Send prompt;
- forward response;
- destructive generic web action.

Generic retry is forbidden. Recovery must observe/reconcile.

### USER_STATE_DESTRUCTIVE_RECOVERY

Examples:

- reload a page with unsent composer text;
- navigation away from a borrowed/user-owned tab.

Requires explicit recovery policy and user-state safety checks.

This taxonomy should be part of `ActionDefinition` or `ActionPolicy`, not comments/documentation only.

---

## 11. Recommended dependency decisions

### Adopt / continue

- Dexie 4 as authoritative IndexedDB abstraction;
- Dexie `liveQuery()` for reactive projections;
- XState for workflow logic/actors where useful;
- p-queue for in-memory paced dispatch;
- `@webext-core/messaging` for typed extension messaging;
- `dom-accessibility-api` for semantic DOM;
- native MutationObserver/Web Locks/chrome.alarms.

### Spike before adoption

- Cockatiel 4, specifically for `RETRY_SAFE` actions and transient site/global health policy.

Spike acceptance questions:

1. bundle impact in WXT production build;
2. browser/MV3 compatibility;
3. clean AbortSignal cancellation;
4. whether breaker state hydration meaningfully reduces custom code;
5. whether explicit Nika outcome classifications integrate cleanly with result-based policies.

### Do not adopt now

- RxDB;
- TinyBase;
- PGlite;
- generic TypeScript event-sourcing framework;
- `idb` as Dexie replacement.

---

## 12. New implementation priority

Recommended next code/research sequence:

1. finalize Dexie schema;
2. implement atomic Job/Lease/Effect transactions;
3. add append-only `runtimeEvents` table;
4. add `liveQuery()` projections for Side Panel status;
5. define `RetryClass` on every BrowserCommand/ActionDefinition;
6. Cockatiel spike around health/snapshot read-only calls;
7. prove that SEND bypasses generic retry policies;
8. forced crash tests between `DISPATCHED` and observation;
9. assert recovery produces `AMBIGUOUS`, never blind resend;
10. benchmark Dexie event/log growth and pruning strategy.

## Final conclusion

This cycle reinforces a useful simplification: Nika does **not** need a heavier database or a full event-sourcing framework to become durable. Dexie already covers the correct storage boundary, and `liveQuery()` closes much of the reactive-state gap.

The valuable new reuse opportunity is Cockatiel — but only if Nika first classifies every operation by retry safety. Generic resilience tooling is excellent for transient read failures and health probes; it is dangerous around browser-side mutations whose outcome may be ambiguous.

The resulting design stays small and explicit:

**Dexie stores truth; liveQuery projects truth; p-queue paces work; Cockatiel may protect retry-safe boundaries; ChatActor serialization protects each chat; and mutating browser side effects still require fresh observation before they are considered settled.**