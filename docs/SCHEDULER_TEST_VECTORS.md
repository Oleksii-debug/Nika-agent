# Scheduler Recovery and Test Vectors

## Status

Architecture/QA contract for the restart-safe scheduler. It supersedes any design that treats `chrome.alarms` or in-memory queues as the durable source of truth.

## Core principle

`chrome.alarms` is a wake-up hint, not the scheduler database.

Canonical flow:

```text
alarm / startup / install / UI wake
        -> reconcile(now)
        -> query durable due jobs
        -> atomically claim eligible jobs
        -> execute through per-chat arbitration
        -> persist checkpoint/result
        -> calculate next occurrence
```

If the MV3 service worker terminates at any point, the next wake reconstructs state from IndexedDB records.

## Canonical durable records

Minimum job record:

```ts
export type DurableJob = {
  id: string;
  projectId: string;
  targetId: string;
  workflowId?: string;
  scheduleId?: string;
  payloadRef: string;
  state:
    | 'pending'
    | 'claimed'
    | 'running'
    | 'waiting_external'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'needs_review';
  dueAt: string;
  occurrenceKey: string;
  attempt: number;
  maxAttempts: number;
  leaseOwner?: string;
  leaseUntil?: string;
  runId?: string;
  checkpoint?: string;
  createdAt: string;
  updatedAt: string;
};
```

`occurrenceKey` must uniquely represent one logical scheduled occurrence, e.g. `scheduleId:2026-08-24T03:00:00+03:00`. A unique index prevents creation of duplicate jobs for the same occurrence.

## Reconciliation transaction

At each wake:

1. Read current wall-clock time.
2. Reclaim expired leases.
3. Materialize missing scheduled occurrences within the configured catch-up horizon.
4. Skip occurrences already represented by an `occurrenceKey`.
5. Apply missed-run policy.
6. Claim due work with a lease in a transaction.
7. Enforce target-level collision policy before executing.
8. Persist a checkpoint before each irreversible external action.
9. Execute.
10. Persist result and derive next schedule state.

## Lease semantics

A lease prevents two service-worker instances/reentrant callbacks from executing one job concurrently.

Required fields:

- `leaseOwner`: random worker/execution token;
- `leaseUntil`: short bounded expiry;
- `updatedAt` heartbeat for long waits where needed.

Claim operation must be compare-and-set in one IndexedDB transaction: claim only jobs that are due and either unleased or lease-expired.

If a lease expires while the previous executor may have performed an external write, recovery must inspect the job checkpoint and reconcile external state before retry.

## External-action checkpoints

Before sending a prompt:

```text
checkpoint = SEND_INTENT_PERSISTED
sendIntent durable record created
```

After adapter confirms new user turn:

```text
checkpoint = SEND_CONFIRMED
```

During generation wait:

```text
checkpoint = WAITING_FOR_IDLE
```

After response capture:

```text
checkpoint = RESPONSE_CAPTURED
capturedResponseId persisted
```

After routing to another chat, the destination send has its own durable SendIntent and confirmation.

A recovered job resumes from checkpoint rather than replaying the whole workflow step.

## Missed-run policies

Every recurring schedule must choose one policy explicitly:

### `skip`

Ignore occurrences missed while Chrome/PC was unavailable. Schedule only the next future occurrence.

Use for noisy periodic nudges where stale work is harmful.

### `latest`

Collapse all missed occurrences to one immediate run representing the latest due occurrence.

Recommended default for "continue work every hour". If the PC slept for six hours, do not send six `Продовжуй` prompts back-to-back.

### `all_bounded`

Replay missed occurrences in order up to a configured maximum (for example 3), then collapse/skip the rest.

Use only where each occurrence represents distinct required work.

### `manual`

Mark missed work `needs_review` and require user action.

Use for high-risk or context-sensitive commands.

## Target collision policies

Schedules/workflows can independently become due for the same ChatGPT chat.

Supported policies:

- `queue`: FIFO by effective due time; safe default.
- `replace_pending_same_schedule`: newer occurrence replaces an older not-yet-started occurrence from the same schedule.
- `coalesce_identical`: merge pending jobs with same target + normalized command hash within a configured window.
- `reject`: second job becomes cancelled/needs_review.

There must never be two active mutating operations against one target chat.

## Manual versus scheduled runs

Manual run priority is configurable, but it cannot bypass target arbitration.

Recommended behavior:

- manual action enters the same durable queue;
- UI may request `priority = user`;
- it may move ahead of pending scheduled work;
- it must not interrupt a currently confirmed generating ChatGPT response;
- Emergency Stop may cancel pending jobs but cannot magically undo a prompt already submitted to ChatGPT.

This replaces purely in-memory `activeManualAgents` as the final architecture. In-memory sets are acceptable only as an optimization after durable arbitration exists.

## Time model

Persist timestamps as UTC ISO-8601 plus schedule timezone identifier.

Do not persist only local wall-clock strings.

For exact-time recurring schedules, recurrence evaluation must use an explicit IANA timezone so DST changes do not silently shift semantics.

For interval schedules (every N minutes), define whether cadence is:

- fixed-rate from scheduled occurrence; or
- fixed-delay from previous completion.

Default for Nika recurring automation: fixed-rate with `latest` catch-up.

## Alarm rebuilding

On startup/install/update and after schedule mutations:

1. Reconcile database first.
2. Compute earliest known future wake.
3. Ensure a Chrome alarm exists for approximately that time.
4. Keep a low-frequency safety/reconciliation alarm so a lost/cleared alarm can self-heal.

Alarm identity must not equal job identity. Many jobs may be reconciled by one wake.

## Test vectors

The following are mandatory deterministic tests. Tests should inject a fake clock and a fake adapter/runtime.

### V01 Normal single occurrence

Given hourly schedule at 10:00, Chrome running, wake at 10:00.

Expected:
- exactly one occurrenceKey materialized;
- exactly one job claimed;
- one send intent;
- one confirmed send;
- job succeeds;
- next occurrence = 11:00.

### V02 Duplicate alarm delivery

Same alarm callback delivered twice/reentrant reconciliation.

Expected: unique occurrenceKey + transactional lease yields exactly one execution.

### V03 Service worker dies before claim

Worker terminates after occurrence materialization but before claim.

Expected: next wake claims same pending job; no duplicate job.

### V04 Service worker dies after claim, before external action

Lease expires with checkpoint before SEND_INTENT.

Expected: job reclaimed and safely resumes; one send total.

### V05 Dies after send intent persisted, before DOM submit

Expected: recover intent, verify prompt absent, then policy allows one send using same logical intent.

### V06 Dies immediately after DOM submit

Adapter may have inserted user turn, but runtime never wrote SEND_CONFIRMED.

Expected: recovery verifies prompt presence; marks confirmed; **no second prompt**.

### V07 Ambiguous duplicate text

Two matching user turns appear after intent timestamp.

Expected: job -> needs_review; zero automatic resend.

### V08 Dies during generation wait

Checkpoint WAITING_FOR_IDLE.

Expected: next wake inspects same chat; if still generating, resume waiting; if idle, capture; no send replay.

### V09 Dies after response captured

CapturedResponse durable, destination route not started.

Expected: resume routing from stored response; do not recapture a potentially newer assistant turn.

### V10 PC sleep with six missed hourly runs, policy latest

Sleep 10:10-16:20.

Expected: one immediate catch-up job representing latest missed occurrence; next future schedule 17:00. No six-message burst.

### V11 PC sleep, policy skip

Expected: no catch-up send; next future occurrence only.

### V12 PC sleep, policy all_bounded max=3

Expected: at most three ordered jobs; remaining misses recorded as collapsed/skipped telemetry.

### V13 Browser restart

All JavaScript memory lost.

Expected: schedules/jobs/runs reconstructed from IndexedDB; no dependence on previous Maps/Sets/timeouts.

### V14 Alarm cleared externally

Database has future schedule but no matching Chrome alarm.

Expected: startup/safety reconciliation recreates wake alarm.

### V15 Two schedules same target at same minute

Expected: one target lease; second remains queued; no concurrent DOM writes.

### V16 Manual run while scheduled job pending

Expected: both are durable; priority policy deterministic; occurrence is not lost.

### V17 Manual run while target generating

Expected: manual run queues/waits; does not interrupt generation unless explicit Emergency Stop semantics were requested.

### V18 Same schedule callback twice after restart

Expected: unique occurrenceKey prevents duplicate job creation.

### V19 Failure before send

Composer missing/unsupported DOM before mutation.

Expected: retry according to adapter/read policy; no send ambiguity; eventually failed/needs_review with evidence.

### V20 Failure after ambiguous send

Expected: never generic retry. Must execute idempotency reconciliation first.

### V21 Rate limit

Adapter reports rate_limited.

Expected: job moves to waiting_external with bounded backoff, not rapid retries; other targets remain runnable.

### V22 Logged out

Expected: affected jobs pause/needs_review; global notification/log; no attempts to automate login.

### V23 Emergency stop

Expected: pending jobs cancelled or paused according to user choice; running waits cease at safe checkpoint; already-sent prompt remains recorded as irreversible.

### V24 Clock moves backward

Expected: occurrenceKey and recurrence calculation prevent replay of already materialized exact-time occurrence.

### V25 Clock jumps forward

Expected: missed-run policy applies; scheduler does not blindly replay every theoretical occurrence.

### V26 DST spring-forward

Exact schedule in timezone where a local wall time does not exist.

Expected: recurrence library/policy handles it deterministically and records adjusted/skipped occurrence.

### V27 DST fall-back

A local time occurs twice.

Expected: occurrence identity includes actual instant/offset so policy can distinguish occurrences; no accidental duplicate due to ambiguous local string.

### V28 Long-running job exceeds lease

Expected: heartbeat extends lease only while executor still owns it. Competing worker cannot steal healthy run.

### V29 Executor freezes and lease expires

Expected: new executor recovers from durable checkpoint and verifies external state before any mutation.

### V30 100 configured chats become due

Expected: bounded global concurrency, per-target serialization, UI/service worker stays responsive, jobs remain durable. No opening/focusing 100 tabs simultaneously; runtime uses a configured tab concurrency limit.

## Performance/concurrency architecture

Do not equate 100 configured chats with 100 simultaneous browser mutations.

Recommended initial bounds:

- global active target operations: 3-5;
- mutating operations per ChatTarget: exactly 1;
- tab creation/open concurrency: bounded separately;
- inspections may be more concurrent but still bounded.

These values are configuration/performance tuning, not correctness semantics.

## Storage choice

Final durable scheduler should use IndexedDB, preferably Dexie for typed schema/migrations/query ergonomics. `chrome.storage.local` may retain user preferences and small flags, but not be the primary jobs/runs/event database.

## Validation tooling

- Vitest: fake-clock and pure recurrence/reconciliation tests.
- fake-indexeddb or equivalent IndexedDB test environment for storage transactions.
- Playwright persistent Chromium context: MV3 extension E2E, restart/reload simulations, inactive-tab behavior.
- deterministic fake ChatAdapter for exhaustive crash-boundary tests.

## Acceptance gate for replacing Gate 1 memory leases

Durable scheduler gate is complete only when:

1. V01-V30 have automated coverage or an explicit documented reason for any non-automatable browser case;
2. simulated service-worker restart cannot duplicate a prompt;
3. missed hourly jobs use an explicit user-visible catch-up policy;
4. manual and scheduled work share one arbitration model;
5. workflow resume starts from durable checkpoint;
6. no correctness decision depends on a module-level Map/Set surviving worker termination.

## External references

- Chrome alarms: https://developer.chrome.com/docs/extensions/reference/api/alarms
- Chrome extension service workers: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers
- WXT: https://wxt.dev/
- Dexie: https://dexie.org/
- Playwright Chrome extensions: https://playwright.dev/docs/chrome-extensions
