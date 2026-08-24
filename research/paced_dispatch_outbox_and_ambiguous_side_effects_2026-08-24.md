# Paced dispatch, durable outbox, and ambiguity-safe browser side effects

Date: 2026-08-24
Repository: `Oleksii-debug/Nika-agent`

## Executive decision

The next reliability boundary for Nika-agent is not another browser-control library. It is the execution contract around `SEND_MESSAGE` and scheduled fan-out.

The current prototype can schedule many agents independently and can retry a content-script command after reloading a tab. That is sufficient for a small MVP, but it is unsafe for a 30-100 chat workload because:

1. many due alarms can independently start work at nearly the same time;
2. a service-worker crash can happen after a ChatGPT send side effect but before Nika records success;
3. a blind retry can therefore duplicate a prompt;
4. a blind reload can destroy user-entered composer text;
5. current workflow context and progress are only in memory;
6. long waits are implemented by polling/sleep loops inside the MV3 service worker.

The correct architecture is therefore:

`Schedule intent -> durable Job/Outbox -> paced dispatcher -> per-chat lease -> PREPARE -> SEND side effect -> OBSERVE -> COMMIT or AMBIGUOUS -> recovery probe`

The important conceptual change is that Nika must stop pretending that a browser click can have exactly-once semantics. ChatGPT's web UI does not expose an idempotency key for a user-message submission. If Chrome or the service worker fails in the narrow interval after the click but before acknowledgement, the only truthful state is **unknown/ambiguous** until the DOM is inspected again.

This document defines that contract.

---

## 1. Current code-level findings

### 1.1 Scheduler can create a burst

`entrypoints/background.ts` creates one `chrome.alarms` entry per enabled scheduled agent. Each alarm invokes `handleAlarm()`, which calls `runAgentNow()` immediately. There is no global dispatcher, no durable queue, no launch-spacing policy and no global concurrency cap.

This means that if many schedules become due together, Chrome can deliver several `onAlarm` events and Nika can initiate several independent sends almost simultaneously.

For the intended large-project operating model, scheduling and dispatch must be separated:

- scheduler decides **what is due**;
- durable queue records **what must eventually run**;
- dispatcher decides **what is allowed to start now**.

### 1.2 Current recovery reload is too aggressive

`src/runtime.ts::contentCommand()` catches a messaging failure, reloads the target tab, waits for load, and retries the same command.

This is dangerous for mutating actions. A messaging failure does not prove that the original action did not happen. It can also occur while a user has unsent text in the composer. Reload is therefore an ADMIN/RECOVERY action and must never be an unconditional generic retry path for `SEND_MESSAGE`.

### 1.3 Workflow state is not durable

`src/workflow.ts::runWorkflow()` iterates through steps with a normal `for` loop and stores captured values in an in-memory `Map`.

If the MV3 service worker terminates between steps, Nika loses:

- current step;
- captured response context;
- evidence from already executed actions;
- whether an external side effect might already have occurred.

The workflow runtime must checkpoint before and after every side-effecting boundary.

### 1.4 SEND success currently means only "event dispatched"

`entrypoints/chatgpt.content.ts::sendPrompt()` writes the composer, clicks the Send button (or dispatches Enter), then immediately returns `{ ok: true }`.

There is no postcondition proving that:

- the composer contained exactly the intended text before submission;
- a new user-message appeared;
- that user-message equals the intended prompt;
- generation actually began;
- an error/rate-limit/login state did not replace the submission.

This is the core place where an ambiguity-safe action protocol is needed.

### 1.5 WAIT currently polls from the service worker

`src/runtime.ts::waitUntilIdle()` polls the content script every second and uses `sleep()`.

Chrome documents that extension service workers normally terminate after about 30 seconds of inactivity, that timers are not durable, and that extension state should be persisted instead of relying on in-memory lifetime. A running API call/event can extend worker lifetime in some cases, but architecture should remain resilient to termination.

For large workloads, waiting should be event/state based, not a background 1-second polling loop per chat.

### 1.6 Logs currently share one chrome.storage.local array

`src/storage.ts::appendLog()` reads the entire log array, appends one entry, caps it at 5000 entries, and writes the whole array back.

Chrome currently documents a 10 MB quota for `chrome.storage.local` unless `unlimitedStorage` is requested. At 30-100 chats, structured evidence, snapshots, response text and workflow history should not be stored as a repeatedly rewritten monolithic JSON array. Dexie/IndexedDB remains the correct migration target.

---

## 2. Exactly-once SEND is not a valid promise

A browser UI action is an external side effect.

Consider:

1. Nika prepares prompt `P` for `DEV17`.
2. Nika clicks Send.
3. ChatGPT accepts the prompt and renders a user-message.
4. The extension service worker or tab message channel fails before Nika records success.
5. Nika restarts.

At this point, a durable record might still say `SEND not completed`, even though the external side effect happened.

If Nika blindly retries, `P` can be sent twice.

This is the same distributed-systems failure window seen in transactional-outbox and durable-activity systems: the external effect and the local acknowledgement cannot be made one atomic transaction when the external system does not participate in that transaction.

Temporal contributors explicitly describe the principle: if an external API is not idempotent, exact-once invocation cannot be guaranteed under timeouts/failures unless the external system supports an idempotency mechanism or can be queried to determine whether the effect happened.

For ChatGPT web UI, Nika has the second option: **query/observe the page after recovery**.

Therefore the runtime contract should be **at-least-once intent with observation-based deduplication**, not a false exactly-once guarantee.

Sources:

- Temporal community discussion on external non-idempotent calls: https://community.temporal.io/t/activity-external-call-idempotency/7543
- Transactional Outbox pattern: https://microservices.io/patterns/data/transactional-outbox.html
- Idempotent Consumer pattern: https://microservices.io/post/microservices/patterns/2020/10/16/idempotent-consumer.html

---

## 3. Introduce an Effect Journal

Every mutating browser action needs a durable journal record.

Recommended record:

```ts
type EffectStatus =
  | 'PREPARED'
  | 'DISPATCHING'
  | 'OBSERVED_COMMITTED'
  | 'AMBIGUOUS'
  | 'REJECTED'
  | 'CANCELLED';

interface EffectRecord {
  effectId: string;
  runId: string;
  stepId: string;
  chatId: string;
  action: 'SEND_MESSAGE' | 'FORWARD_RESPONSE';
  idempotencyKey: string;
  payloadHash: string;
  expectedConversationUrl: string;
  preparedAt: number;
  dispatchStartedAt?: number;
  observedCommittedAt?: number;
  status: EffectStatus;
  preSnapshotFingerprint?: string;
  postSnapshotFingerprint?: string;
  observedUserMessageHash?: string;
  fencingToken: number;
  ambiguityReason?: string;
}
```

### State meaning

`PREPARED`

The durable intent exists, validation passed, and the action has not yet crossed the external side-effect boundary.

`DISPATCHING`

Nika is crossing the side-effect boundary. A crash in this state is not retried blindly.

`OBSERVED_COMMITTED`

The postcondition has been observed on the ChatGPT page: the expected user-message exists in the expected conversation and matches the intended payload identity.

`AMBIGUOUS`

Nika cannot prove whether the side effect happened. Automatic resend is suspended until a recovery probe resolves the state.

`REJECTED`

A deterministic precondition prevented dispatch: blocked by user, wrong chat, generating, login required, rate limited, incompatible adapter, stale lease, etc.

This journal is more important than an ordinary retry counter.

---

## 4. Recovery algorithm for ambiguous SEND

When a service worker resumes and sees `DISPATCHING`, it must first convert it to a recovery check, not to a resend.

Recommended algorithm:

```text
load EffectRecord
  -> reacquire target READ capability
  -> verify exact conversation
  -> take fresh semantic snapshot
  -> search recent user messages for expected payload identity

if exact expected message is found after preSnapshot boundary:
    mark OBSERVED_COMMITTED
    resume workflow after SEND

else if page is still changing / loading / frozen:
    retry observation later

else if exact outcome cannot be proven:
    mark AMBIGUOUS
    stop automatic mutation for that chat
    require controlled recovery policy
```

A controlled recovery policy may allow a resend only when Nika can prove non-delivery. Examples of stronger evidence:

- composer still contains exactly Nika's prepared prompt and no matching submitted user-message exists;
- a known ChatGPT terminal error explicitly states that submission failed;
- the send button was never activated because a deterministic precondition failed before the side-effect boundary.

Absence of a user-message immediately after reload is weaker evidence and should not automatically authorize resend, because history rendering and navigation may lag.

---

## 5. Durable Outbox for scheduled work

A schedule should not directly execute browser work.

Instead, scheduler reconciliation writes `Job` rows into Dexie.

Recommended shape:

```ts
type JobState =
  | 'READY'
  | 'LEASED'
  | 'RUNNING'
  | 'WAITING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'NEEDS_USER'
  | 'CANCELLED';

interface Job {
  jobId: string;
  projectId: string;
  chatId: string;
  workflowId?: string;
  actionClass: 'SEND_START' | 'WORKFLOW_RESUME' | 'RECOVERY';
  scheduledFor: number;
  notBefore: number;
  priority: number;
  sequence: number;
  state: JobState;
  attempt: number;
  idempotencyKey: string;
  createdAt: number;
  leasedUntil?: number;
}
```

The scheduler may enqueue 50 jobs immediately. The dispatcher must still start them one by one according to launch policy.

That distinction is essential.

---

## 6. Separate start-rate from active-work concurrency

For a large ChatGPT project there are two different limits.

### A. Launch pacing

How frequently may Nika initiate a new prompt submission?

Example policy:

```ts
launchPolicy = {
  minStartSpacingMs: 60_000,
  intervalCap: 1,
  intervalMs: 60_000,
  strict: true,
};
```

This means at most one new SEND starts in any rolling one-minute window.

### B. Active workflow concurrency

How many chats may already be generating or waiting for completion at once?

This can be larger, because once a prompt is submitted the target ChatGPT tab can generate independently while Nika launches a later chat.

Example:

```ts
runtimePolicy = {
  maxActiveChats: 8,
  maxMutationsPerChat: 1,
};
```

The exact default should be tuned by testing. The architecture must not conflate `one launch per minute` with `only one workflow may exist at a time`.

This enables a staged pattern such as:

```text
DEV01 send at minute 0
DEV02 send at minute 1
...
DEV50 send at minute 49

while earlier chats can continue generating in the background
```

---

## 7. p-queue is useful, but cannot be rate-limit authority

Current `p-queue` supports both `concurrency` and rate limiting through `intervalCap`/`interval`, including strict sliding-window mode in current releases. It also provides backpressure hooks such as `onRateLimit()` and `onSizeLessThan()`.

This makes it a good in-memory dispatcher while the service worker is alive.

However, it cannot be the durable authority because all in-memory queue state disappears when the MV3 worker terminates.

Therefore:

```text
Dexie Job rows + durable lastDispatchAt = truth
p-queue = current-process executor
```

On every wake:

1. read durable launch-policy state;
2. calculate earliest next allowed start;
3. select eligible READY jobs in deterministic order;
4. lease only as many as current capacity permits;
5. submit them to p-queue;
6. persist dispatch timestamp before/at the external side-effect boundary;
7. arm one next scheduler alarm if nothing else is immediately eligible.

Source:

- p-queue repository/docs: https://github.com/sindresorhus/p-queue

No new rate-limiter dependency is required.

---

## 8. One scheduler alarm, not one alarm per chat

Chrome's current alarm documentation states:

- alarms can be delayed;
- an alarm does not wake a sleeping device;
- missed repeating alarms fire at most once after wake and are rescheduled from wake time;
- production alarms are limited to approximately one every 30 seconds;
- Chrome has historically limited the number of active alarms (500 since Chrome 117; current docs still describe the single-alarm API and persistence semantics);
- Chrome 150+ exposes `persistAcrossSessions`, but important alarms should still be reconciled when the service worker starts.

For Nika this reinforces the existing research decision:

```text
Dexie schedules/jobs
    -> one scheduler wake alarm
    -> reconciliation
    -> paced dispatcher
```

The current `rebuildAlarms()` implementation should eventually be replaced rather than expanded to hundreds of independent agent alarms.

Source:

- Chrome alarms API: https://developer.chrome.com/docs/extensions/reference/api/alarms

---

## 9. Avoid service-worker polling loops for WAIT_FOR_IDLE

Chrome's service-worker guidance explicitly recommends event-driven architecture and persistent state; timers can disappear when a worker terminates.

Current `waitUntilIdle()` uses a one-second poll loop. At scale, this creates two problems:

- worker lifetime becomes coupled to long-running waits;
- N chats can produce N repeated status polls.

Preferred design:

### Page-local watcher

The ChatGPT content script owns a `MutationObserver` for the latest assistant response and relevant controls.

It computes:

```text
siteState
generating flag
lastMutationAt
response fingerprint
stableSince
```

It can answer a snapshot request immediately and, while the page is alive, can emit a lightweight `chatStateChanged` event when state materially changes.

### Durable workflow wait

The workflow checkpoint stores:

```text
state = WAITING_FOR_RESPONSE
chatId
expectedAfterMessageId
wakeNotBefore
timeoutAt
lastObservedFingerprint
```

The service worker is then free to terminate.

On an event or scheduler wake, it rechecks the target and advances only when the response is stable.

This remains safe even if a tab is frozen/discarded: the background reconciliation detects that condition and restores the target before observation.

Source:

- Chrome extension service-worker lifecycle: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- Migration guidance on replacing timers with alarms: https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers

---

## 10. Manual-user collision must dominate recovery

A recovery algorithm must never choose data integrity over the user's unsent work.

Before any mutation, including a retry or reload, acquire a fresh snapshot and inspect composer ownership.

If composer has non-empty text that is not proven to belong to the current `EffectRecord`:

```text
BLOCKED_BY_USER
```

Actions forbidden in this state:

- replace composer text;
- press Send;
- reload the tab;
- navigate the tab;
- switch conversation in that tab.

The job is delayed or moved to `NEEDS_USER` according to policy.

This must be implemented below workflow level, inside the mutation boundary, so every caller inherits the protection.

---

## 11. Global/account/project pacing scopes

The dispatcher should support multiple independent policy scopes without assuming ChatGPT's undocumented rate-limit thresholds.

Recommended hierarchy:

```text
global extension scope
  -> account/profile scope (future)
      -> project scope
          -> chat scope
```

Each scope can contribute a constraint:

```ts
interface DispatchPolicy {
  minStartSpacingMs?: number;
  maxConcurrent?: number;
  pauseUntil?: number;
  circuitBreakerOpen?: boolean;
}
```

The effective start time is the maximum of all relevant `notBefore` constraints.

This supports safe operational presets such as:

- conservative large batch: one new SEND per minute;
- audit stage: delayed start after developer wave;
- user-defined quiet window;
- automatic cooldown after rate-limit detection;
- global halt when ChatGPT adapter health breaker opens.

Do not hard-code claims about ChatGPT request quotas. Nika should enforce user-defined and evidence-driven pacing, not try to reverse-engineer or evade service limits.

---

## 12. Rate-limit detection should cause cooldown, not retry storm

The ChatGPT SiteProfile should normalize terminal states such as `RATE_LIMITED`.

When observed:

1. current action returns a structured non-success result;
2. project/account dispatcher enters cooldown (`pauseUntil`);
3. no new SEND jobs start during cooldown;
4. already generating chats may continue to be observed read-only;
5. retry policy uses backoff and a bounded attempt budget;
6. repeated global rate-limit observations can open the global adapter/account circuit breaker.

The exact cooldown duration should be configurable and may be adapted to explicit UI evidence. It should not aggressively probe ChatGPT.

---

## 13. Storage migration priority increases

The current `chrome.storage.local` implementation is acceptable for configuration-scale MVP data, but not for full runtime history.

Chrome currently documents a 10 MB `storage.local` quota by default. The current log implementation repeatedly serializes the entire capped list.

Dexie schema should now explicitly include:

```text
projects
chats
workflowDefinitions
workflowRuns
workflowCheckpoints
jobs
schedules
effects
responses
leases
circuitBreakers
logs
```

`responses` and large evidence should use bounded retention policies.

`chrome.storage.local` can remain for small extension settings during migration.

`chrome.storage.session` can remain a cache for ephemeral bindings such as last-known `tabId`.

Source:

- Chrome storage API: https://developer.chrome.com/docs/extensions/reference/api/storage

---

## 14. Recommended SEND protocol

The implementation sequence for a mutation should become:

```text
1. create/load durable EffectRecord
2. acquire chat WRITE lease + fencing token
3. acquire target tab without focus
4. verify exact ChatGPT conversation
5. fresh SiteProfile health snapshot
6. verify adapter is healthy
7. verify site state allows SEND
8. verify composer ownership
9. verify no prior committed effect with same idempotency key
10. write EffectRecord = PREPARED
11. write exact prompt to composer
12. reread composer and verify exact normalized prompt
13. write EffectRecord = DISPATCHING
14. perform click/Enter
15. observe postcondition
16a. if expected user-message exists -> OBSERVED_COMMITTED
16b. if deterministic rejection -> REJECTED
16c. if transport/lifecycle failure leaves outcome unknown -> AMBIGUOUS
17. persist workflow checkpoint
18. release mutation lease
```

The workflow step is complete only at 16a, not at 14.

---

## 15. ActionResult should encode uncertainty explicitly

Recommended result taxonomy:

```ts
type ActionCode =
  | 'SUCCESS'
  | 'NO_EFFECT'
  | 'AMBIGUOUS_EFFECT'
  | 'WRONG_TARGET'
  | 'BLOCKED_BY_USER'
  | 'GENERATING'
  | 'LOGIN_REQUIRED'
  | 'RATE_LIMITED'
  | 'SITE_INCOMPATIBLE'
  | 'STALE_LEASE'
  | 'RETRYABLE_TRANSIENT'
  | 'NEEDS_USER';
```

`AMBIGUOUS_EFFECT` must be first-class. It is not equivalent to `RETRYABLE_TRANSIENT`.

A transient failure before the side-effect boundary can often retry safely.

An ambiguous failure after the side-effect boundary must observe before retry.

This distinction should be enforced in types so developers cannot accidentally use one generic `catch -> retry` path.

---

## 16. Acceptance tests added by this research

These tests should become mandatory before large-batch use.

### A. Crash before send

- Effect is PREPARED.
- Worker dies before click.
- Resume safely performs one SEND.

Expected: one user-message.

### B. Crash immediately after send

- Click succeeds.
- User-message appears.
- Worker dies before local success checkpoint.

Expected: recovery observes existing message and does **not** resend.

### C. Ambiguous transport failure

- Dispatch started.
- Message transport throws before result is known.

Expected: state becomes AMBIGUOUS; no automatic duplicate SEND.

### D. User text appears before recovery

- Effect waits/retries.
- User manually types in composer.

Expected: `BLOCKED_BY_USER`; no reload and no composer overwrite.

### E. 50 jobs become due simultaneously

Policy: `minStartSpacingMs = 60_000`.

Expected: durable queue contains 50 READY jobs, but dispatcher starts at most one new SEND per rolling minute; service-worker restarts do not reset the spacing clock.

### F. Dispatcher dies after leasing next job

Expected: lease expires/reconciles; job becomes eligible again without violating per-chat fencing or global launch spacing.

### G. Machine sleeps during batch

Expected: on wake, scheduler reconciles due jobs, but does not fire all missed launches immediately. The configured catch-up policy and paced dispatcher still apply.

### H. Rate limit observed

Expected: no immediate retry storm; account/project scope pauses and records cooldown evidence.

### I. chrome.storage.local log pressure

Expected after Dexie migration: runtime correctness does not depend on rewriting one monolithic log array; retention can prune old evidence without deleting workflow truth.

---

## 17. Dependency decision

No new mandatory dependency is introduced by this research.

Still recommended:

- WXT + TypeScript
- Dexie
- XState v5
- `@webext-core/messaging`
- `dom-accessibility-api`
- `p-queue`
- Vitest
- Playwright for E2E

`p-queue` already provides the in-memory concurrency/rate-limiting primitives needed for dispatch while the worker is alive. Durable pacing state belongs in Dexie.

---

## 18. Updated implementation order

The implementation backlog should now prioritize the effect boundary before richer UI:

1. Dexie schema and migration scaffolding.
2. Durable `Job` table.
3. Durable `EffectRecord` / effect journal.
4. `ActionResult` with `AMBIGUOUS_EFFECT`.
5. Per-chat WRITE lease + fencing token.
6. Composer ownership invariant.
7. Validated SEND preconditions/postconditions.
8. Recovery probe for `DISPATCHING`/`AMBIGUOUS` effects.
9. Single scheduler wake alarm and due-job reconciliation.
10. Durable `lastDispatchAt` and project/global `notBefore` policies.
11. p-queue dispatcher with concurrency + strict launch-rate limit.
12. Content-script MutationObserver state watcher.
13. Durable WAIT checkpoint instead of service-worker polling loop.
14. Rate-limit cooldown / circuit-breaker integration.
15. 50-job paced-batch E2E test with forced service-worker termination.
16. Only after these: richer workflow editor and batch UX.

---

## Final recommendation

The next Nika-agent milestone should not be "support more actions". It should be **make one SEND transactionally observable and recovery-safe, then make 50 scheduled SEND intents dispatch at a controlled pace across service-worker restarts**.

The decisive invariants are:

```text
schedule due != execute now
click success != action committed
transport error != safe to retry
service-worker restart != reset pacing
same chat != concurrent mutation
user composer text != disposable automation state
ambiguous external effect != failure
```

Once those invariants are implemented, the architecture can safely scale from a prototype to the intended multi-chat Developer/Auditor operation without relying on fragile timing assumptions.
