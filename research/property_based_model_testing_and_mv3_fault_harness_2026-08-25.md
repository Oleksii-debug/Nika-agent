# Property-based, model-based, and real-MV3 fault testing for Nika-agent

Date: 2026-08-25
Repository: `Oleksii-debug/Nika-agent`

## Executive decision

Nika-agent has reached the point where additional browser-agent frameworks are less valuable than executable proof of the reliability contracts already selected.

The current test suite correctly checks several important examples, including:

- irreversible SEND uses retry policy `none`;
- read-only commands retain bounded retry;
- two operations for one agent are serialized while the first is running;
- workflow provenance carries a stable `runId` and `stepId`.

Those tests are necessary but insufficient for the architecture now being designed. The dangerous failures are combinations such as:

`job claimed -> SEND prepared -> user takes control -> service worker suspends -> lease expires -> worker restarts -> old callback resumes -> second dispatcher wakes -> DOM changed -> retry signal arrives`.

Hand-writing one test for every ordering is unrealistic.

The recommended assurance stack is therefore:

`Vitest examples -> fast-check property/race tests -> XState graph/model tests -> fake IndexedDB storage tests -> real Chromium/Playwright MV3 lifecycle tests -> small live ChatGPT canary`.

No new production dependency is required by this research cycle.

Recommended new development dependencies when the corresponding implementation exists:

- `fast-check`;
- `fake-indexeddb`;
- Playwright test tooling for the real extension lifecycle layer.

XState graph utilities should be consumed from the main `xstate` package (`xstate/graph`), not from a new deprecated standalone test package.

---

## 1. Current Nika testing gap

The live repository currently has `src/runtime.test.ts` and `src/workflow.test.ts`.

The runtime tests prove one-shot SEND retry policy and a single deterministic serialization example. The workflow tests prove `wait_idle` behavior and provenance propagation.

This is a good P0 regression foundation, but it does not yet prove the invariants required by the research architecture:

1. at most one valid writer owns a chat mutation at a time;
2. stale fencing tokens can never commit state;
3. a SEND that entered the external side-effect window is never blindly retried;
4. a crash before dispatch is recoverable as retryable intent;
5. a crash after dispatch but before receipt becomes `AMBIGUOUS`;
6. duplicate alarms or duplicate wake events do not duplicate durable jobs;
7. restart does not reset cooldown/notBefore;
8. cancelling after dispatch cannot pretend the external mutation rolled back;
9. stale document/navigation epochs cannot execute WRITE;
10. a manual handoff revokes all older mutation permits;
11. settlement is idempotent;
12. bounded history pruning never deletes data needed to reconcile an unresolved effect.

These are properties over many event orderings, not merely individual examples.

---

## 2. `fast-check`: strong fit for Nika's distributed-state invariants

Project: `dubzzz/fast-check`

License: MIT

Current line checked during this research: fast-check 4.x; npm showed 4.9.0, and the project remained actively maintained in 2026.

Sources:

- https://github.com/dubzzz/fast-check
- https://fast-check.dev/
- https://fast-check.dev/docs/tutorials/

### Why it fits Nika

`fast-check` is a property-based testing library for JavaScript/TypeScript. Instead of supplying one hand-written input, tests generate many valid inputs and sequences and then shrink a failure to the smallest reproducing counterexample.

This is particularly relevant because fast-check explicitly supports:

- model-based testing;
- asynchronous properties;
- race-condition testing by varying how promises resolve;
- shrinking complex generated failures;
- direct integration with Vitest.

Nika already uses Vitest, so adopting fast-check does not require replacing the current test runner.

### Recommended use

Use fast-check for runtime invariants, not DOM screenshot fuzzing.

Good targets:

- job admission;
- leases and fencing;
- Effect Journal transitions;
- retry classification;
- throttle/cooldown state;
- dispatch fairness;
- cancellation semantics;
- workflow checkpoint recovery;
- message deduplication;
- stale-navigation rejection.

### Example property class

Generate event streams such as:

```text
ENQUEUE
CLAIM(worker=A)
PREPARE(effect=E)
DISPATCH
CRASH(worker=A)
CLAIM(worker=B)
OBSERVE(receipt=true)
SETTLE(worker=B)
LATE_SETTLE(worker=A)
```

Then assert globally:

```text
settledEffects(E) <= 1
committedWriter(E) == current fencing token
blindResendAfterDispatch(E) == false
```

The event order should be generated rather than encoded as one fixed test.

### Most valuable Nika properties

#### Property A: stale writer cannot commit

For every generated sequence of lease expiry, reclaim, worker restart and delayed completion:

> If token `T2` supersedes `T1`, no commit carrying `T1` changes authoritative state.

#### Property B: SEND is never automatically duplicated after ambiguity

For every sequence where dispatch may have happened but receipt is unknown:

> No subsequent automatic transition invokes SEND again until reconciliation has proven `NO_EFFECT` or explicit operator policy allows retry.

#### Property C: claim uniqueness

At any logical instant:

> At most one non-expired WRITE authority exists for the same chat target.

#### Property D: settlement idempotency

Calling `settleEffect(effectId, sameEvidence)` once or repeatedly must yield the same durable result.

#### Property E: overdue schedules never bypass pacing

Generate arbitrary wake delays and overdue jobs:

> Two admitted SEND starts can never violate durable `minStartSpacing` even after worker/browser sleep.

#### Property F: cancel is not rollback

For every cancellation point:

- before PREPARED: safe cancellation;
- PREPARED but before external dispatch: safe cancellation;
- after DISPATCHING: state must remain observation/reconciliation-bound.

A generated test should prove there is no transition from a dispatched mutation directly to a fictional `CANCELLED_WITHOUT_EFFECT` state.

### Decision

**Adopt as dev dependency when durable Job/Effect/Lease state lands.**

This gives substantially more value than adding another general automation framework.

---

## 3. XState graph/model-based testing

Sources:

- https://stately.ai/docs/graph
- https://stately.ai/docs/testing

Current XState documentation says graph utilities are part of the main `xstate` package and imported from `xstate/graph`; the older standalone testing package route is deprecated.

The graph layer can generate:

- shortest paths;
- simple paths;
- paths from explicit event sequences;
- adjacency maps;
- model-based test plans.

### Why this matters for Nika

If Nika implements its Effect lifecycle as a real state machine:

```text
PREPARED
  -> DISPATCHING
  -> PENDING_OBSERVATION
  -> SETTLED_SUCCESS
  -> NO_EFFECT
  -> WRONG_EFFECT
  -> BLOCKED
  -> AMBIGUOUS
```

then tests should not manually guess every path.

`xstate/graph` can mechanically verify reachable paths and transition coverage.

### Recommended separation

Use XState graph testing to prove **legal state-machine structure**.

Use fast-check to prove **invariants across generated data, timings and interleavings**.

These solve different problems.

Example:

XState graph proves:

> There is no legal direct transition `DISPATCHING -> READY_TO_RESEND`.

fast-check proves:

> Across random crashes, expired leases and duplicate wake events, implementation code never creates the equivalent illegal result indirectly.

### Avoid state-space explosion

Do not put all 100 chats into one giant test state machine.

Model one target/effect actor, and generate external conditions separately:

- `leaseExpired`;
- `receiptVisible`;
- `documentChanged`;
- `manualControl`;
- `cooldownActive`.

Then test coordinator-level fairness independently.

### Decision

**Use `xstate/graph` once Effect/Job actors are formalized. Do not add deprecated `@xstate/test`.**

---

## 4. `fake-indexeddb`: useful but explicitly not sufficient

Project: `dumbmatter/fakeIndexedDB`

License: Apache-2.0

Source:

- https://github.com/dumbmatter/fakeIndexedDB

The project provides a pure JavaScript in-memory IndexedDB implementation for Node tests. Its own published quality comparison reports broad, but not complete, Web Platform Test compatibility.

### Good Nika uses

Once Dexie lands, use fake-indexeddb for fast tests of:

- schema migrations;
- compound indexes;
- job claim transactions;
- atomic effect + event journal writes;
- lease/fencing updates;
- pruning logic;
- restart simulation by discarding runtime objects while keeping the in-memory database;
- duplicate insert/idempotency constraints.

### What it must not prove

Do not treat fake-indexeddb as evidence for:

- real browser transaction timing;
- service worker suspension behavior;
- browser shutdown durability;
- quota behavior;
- IndexedDB lifecycle under real MV3 contexts;
- content-script/background cross-context behavior.

Weft's own 2026 browser-runtime documentation reinforces this boundary: its browser adapters remain experimental until real-browser smoke tests, rather than fake IndexedDB or stubbed storage unit tests, become required and green.

Source:

- https://github.com/stevekinney/weft

### Decision

**Adopt for unit/property tests, but require a real-browser durability gate separately.**

---

## 5. Playwright now documents an MV3 suspension trap relevant to Nika tests

Official source:

- https://playwright.dev/docs/next/chrome-extensions

Playwright's current Chrome-extension documentation explicitly covers Manifest V3 service-worker idle suspension.

Important subtlety: when Chrome suspends and later restarts the extension service worker, Playwright can keep the same `Worker` object alive. A new `serviceworker` event is not necessarily emitted; `evaluate()` calls during the restart window may stall and resume when the new execution context is ready.

This has a direct consequence for Nika's E2E harness.

### Bad test oracle

Do not assert:

```text
old Worker object disappeared
AND
new serviceworker event arrived
```

as proof that MV3 restart occurred.

That assumption can be false from Playwright's perspective even though Chrome actually recycled the worker execution context.

### Better restart proof

Give the background runtime an **ephemeral boot identifier**:

```text
runtimeBootId = random UUID created when service-worker JS context initializes
```

Expose it only through a diagnostic test endpoint/health response.

Then a real E2E test can prove:

```text
bootId before = A
force/allow suspension
wake extension
bootId after = B
A != B
```

while separately proving durable state survived:

```text
jobId same
Effect state same/reconciled
fencing counter monotonic
cooldown notBefore preserved
```

This is much stronger than watching Playwright worker-object identity.

### Required real-browser scenarios

1. worker suspension before claim;
2. suspension after claim but before PREPARE;
3. suspension after PREPARE but before DOM mutation;
4. suspension immediately after click/submit;
5. suspension during PENDING_OBSERVATION;
6. suspension after receipt observation but before local settle;
7. suspension during WAIT_FOR_RESPONSE;
8. duplicate alarm after restart;
9. tab frozen while workflow waits;
10. tab discarded then restored;
11. browser persistent context reopened with outstanding AMBIGUOUS effect.

### Decision

**Playwright is the required lifecycle oracle. Unit mocks cannot certify MV3 durability.**

---

## 6. Fault injection should become a first-class test API

Nika should not scatter random `throw new Error()` calls across production code.

Create a test-only boundary such as:

```ts
export type FaultPoint =
  | 'after_job_claim'
  | 'after_effect_prepare'
  | 'before_dom_write'
  | 'after_dom_write_before_readback'
  | 'before_submit'
  | 'after_submit_before_observe'
  | 'after_observe_before_settle'
  | 'after_settle_before_ack';
```

A `FaultInjector` interface can be provided as a no-op in production and a deterministic controller in tests.

Conceptually:

```ts
await faults.hit('after_effect_prepare');
```

The real build should tree-shake/no-op this implementation or wire a fixed no-op implementation; imported workflows or site content must never control fault points.

### Why named fault points are better

They allow the exact crash windows from distributed-system analysis to become stable regression cases.

The most important SEND fault boundary is:

```text
external submit may have happened
BUT durable receipt has not been committed
```

Every implementation of SEND must maintain a test at that boundary.

---

## 7. Model the environment, not only the workflow

Nika failures do not come only from workflow events.

The test generator should also vary environment observations.

Recommended generated environment events:

```text
WORKER_SUSPENDED
WORKER_STARTED
TAB_FROZEN
TAB_UNFROZEN
TAB_DISCARDED
TAB_RESTORED
DOCUMENT_CHANGED
SPA_NAVIGATION
CONTENT_SCRIPT_INVALIDATED
MESSAGE_TIMEOUT
READ_TRANSPORT_FAILURE
SEND_TRANSPORT_FAILURE
DOM_NO_EFFECT
DOM_WRONG_EFFECT
USER_MESSAGE_RECEIPT
RATE_LIMIT_SIGNAL
COOLDOWN_EXPIRED
USER_TAKEOVER
USER_RESUME
LEASE_EXPIRED
DUPLICATE_ALARM
```

The architecture is safe only if arbitrary legal combinations preserve the invariants.

---

## 8. Suggested four-layer test pyramid

### Layer 1 — deterministic unit tests

Tools:

- Vitest;
- current mocks.

Purpose:

- pure parsers;
- policy functions;
- normalization;
- semantic diff rules;
- retry classification;
- postcondition evaluators.

### Layer 2 — property/model tests

Tools:

- Vitest;
- fast-check;
- `xstate/graph`;
- fake-indexeddb + Dexie.

Purpose:

- state-machine coverage;
- random interleavings;
- lease/fencing properties;
- job/effect invariants;
- fairness;
- migrations;
- idempotency.

### Layer 3 — controlled real-browser tests

Tools:

- Playwright Chromium persistent context;
- actual built MV3 extension;
- controlled ChatGPT-like fixture site.

Purpose:

- service worker restart;
- content-script lifecycle;
- IndexedDB in actual browser;
- MutationObserver behavior;
- React/managed editor fixtures;
- frozen/discarded tabs;
- iframe/shadow DOM;
- real extension messaging.

### Layer 4 — live canary

Target:

- one low-risk real ChatGPT conversation before large batch release.

Purpose:

- detect current site drift;
- validate SiteProfile;
- validate semantic resolution;
- validate exact SEND receipt;
- validate response stability.

A live canary is compatibility evidence, not the main regression suite.

---

## 9. Property-based scheduler tests

The scheduler deserves dedicated generative testing.

Generate:

- arbitrary schedules;
- arbitrary device sleep duration;
- arbitrary number of overdue jobs;
- manual high-priority inserts;
- site/chat cooldowns;
- worker restarts;
- duplicate alarm delivery.

Properties:

### No launch burst

For all dispatched WRITE starts:

```text
start[n + 1] - start[n] >= configured durable minimum
```

unless they belong to an explicitly different independent rate-limit scope permitted by policy.

### No job loss

Every durable job eventually ends in one of a documented terminal/deferred states:

```text
COMPLETED
FAILED_TERMINAL
CANCELLED_PRE_EFFECT
AMBIGUOUS
BLOCKED
WAITING
```

It must not silently disappear because a live p-queue object was destroyed.

### Fairness

For an indefinitely runnable lower-priority lane with aging enabled:

> Higher-priority recurring work cannot starve it forever.

This is an ideal fast-check property because fixed examples tend not to expose starvation.

---

## 10. Effect Journal properties

Once `Effect` exists, its tests should be stronger than individual transition examples.

Core invariants:

```text
SETTLED_SUCCESS is terminal and idempotent
AMBIGUOUS never auto-transitions to DISPATCHING
NO_EFFECT may permit policy-governed retry
WRONG_EFFECT never counts as success
fencingToken must be current for authoritative writes
receipt identity is immutable after successful settlement
```

Generated corruption cases should include:

- duplicate events;
- delayed old events;
- out-of-order ACK;
- restart between any two durable writes;
- clock jumps;
- duplicated scheduler wake;
- two workers attempting the same transition.

---

## 11. Stateful model for a single ChatActor

The most useful initial model is not the entire product. It is one chat.

Suggested abstract states:

```text
IDLE
READY
LEASED
PREPARING
DISPATCHING
OBSERVING
WAITING_RESPONSE
HUMAN_CONTROL
COOLDOWN
AMBIGUOUS
COMPLETED
```

Inputs:

```text
RUN
LEASE
PREPARED
SUBMIT
RECEIPT
NO_EFFECT
TRANSPORT_UNKNOWN
RESPONSE_READY
TAKEOVER
RESUME
RATE_LIMIT
CRASH
RESTART
```

Assertions can then cover all shortest/simple paths through the actor and use property testing for data/timing/interleaving around those paths.

This is also a way to keep XState meaningful: the state machine becomes executable design documentation, while Dexie remains durable state authority/checkpoint storage.

---

## 12. Comparison summary

| Tool/approach | Role in Nika | Adopt? | Key limitation |
|---|---|---|---|
| Vitest | deterministic unit/regression tests | Already yes | example tests alone miss combinatorial races |
| fast-check | generated invariants, races, model commands | Yes, dev-only | not a real browser lifecycle oracle |
| `xstate/graph` | model/path coverage | Yes when machines land | state explosion if model is too broad |
| fake-indexeddb | fast IndexedDB/Dexie tests | Yes, dev-only | does not certify real browser durability |
| Playwright extension tests | actual MV3/browser lifecycle | Yes | heavier/slower than unit tests |
| fake Chrome APIs only | quick policy tests | Keep | cannot prove service-worker semantics |
| another browser-agent framework | runtime dependency | No for this gap | does not prove Nika's own durability |

---

## 13. Implementation order

Recommended next assurance work, aligned with the existing reliability roadmap:

1. Keep the current SEND retry regression tests.
2. Land Dexie schema for Jobs/Effects/Leases.
3. Add `fake-indexeddb` test environment for repository transactions.
4. Add explicit state invariants to repository-level tests.
5. Add `fast-check` and generate Job/Lease/Effect event sequences.
6. Implement Effect lifecycle as an explicit XState machine or equivalent state-transition definition.
7. Use `xstate/graph` to prove transition/path coverage.
8. Add named test-only `FaultPoint`s around external mutation boundaries.
9. Build a controlled ChatGPT-like fixture.
10. Add Playwright MV3 extension fixture using persistent Chromium context.
11. Detect actual worker restarts through `runtimeBootId`, not solely Playwright Worker object identity.
12. Run forced restart tests at every SEND boundary.
13. Add scheduler property tests for 30-100 overdue jobs.
14. Add one live ChatGPT compatibility canary only after the controlled suite is green.

---

## 14. Final recommendation

The architecture research has already identified the right runtime contracts. The next risk is not lack of ideas; it is implementing those contracts incorrectly under rare timing combinations.

For Nika, property-based and model-based testing are unusually high leverage because the product is effectively a small distributed system running across:

- an MV3 service worker;
- multiple content-script documents;
- mutable web applications;
- browser lifecycle events;
- durable IndexedDB state;
- human control;
- external non-idempotent side effects.

The core acceptance criterion should therefore become:

> Nika's critical invariants remain true under generated event orderings and forced browser lifecycle failures, not only under the happy path used by ordinary unit tests.

This research recommends adding no production framework. It recommends turning the existing reliability design into executable proof.