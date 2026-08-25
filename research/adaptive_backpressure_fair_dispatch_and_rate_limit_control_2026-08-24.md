# Adaptive backpressure, fair dispatch, and rate-limit control

Date: 2026-08-24
Repository: `Oleksii-debug/Nika-agent`

## Executive decision

For Nika's browser-side execution plane, keep `p-queue` as the operational in-memory executor and do not replace it with Bottleneck, p-throttle, or a server-oriented rate-limiter framework.

The durable scheduling authority remains Dexie. `p-queue` is only the live executor after jobs have been durably claimed.

The required architecture is:

`Dexie due jobs -> fair durable selection -> p-queue live execution -> per-chat mutation gate -> ActionResult -> adaptive cooldown/backpressure -> durable checkpoint`

The main new requirement is adaptive backpressure. Static spacing such as one launch per 60 seconds is a safe starting policy, but the runtime must be able to slow down, pause a scope, and gradually recover when ChatGPT or another site indicates overload/rate limiting.

---

## 1. Why `p-queue` remains the best browser-side fit

Current `p-queue` supports:

- concurrency limits;
- `intervalCap` + `interval`;
- strict sliding-window limiting, avoiding fixed-window boundary bursts;
- task priority and priority changes;
- `AbortSignal` cancellation;
- per-task timeout;
- `rateLimit` / `rateLimitCleared` events;
- saturation/backpressure inspection;
- `onSizeLessThan()` to stop producers from overfilling the live queue;
- custom queue classes when a different live ordering policy is needed.

For Nika this is enough to implement a live dispatcher without introducing a second durable scheduling system.

Recommended live baseline for the 50-chat paced launch mode:

```ts
new PQueue({
  concurrency: MAX_ACTIVE_STARTS,
  intervalCap: 1,
  interval: 60_000,
  strict: true,
});
```

`strict: true` matters because fixed-window limiting can burst at a window boundary. For example, a task at 59.9s and another at 60.0s could start almost together under a simple fixed window. Sliding-window enforcement prevents that class of burst.

However, `p-queue` must never be treated as durable state. If the MV3 service worker terminates, its in-memory queue disappears. Every job admitted to the live executor must already exist in Dexie with durable identity and scheduling metadata.

Sources:

- https://github.com/sindresorhus/p-queue

---

## 2. Why Bottleneck is not the browser baseline

Bottleneck is a mature task scheduler/rate limiter for Node.js and browsers. Its useful features include:

- `minTime`;
- `maxConcurrent`;
- reservoirs;
- groups;
- chaining;
- retries;
- Redis-backed clustering.

Those features are strong for server fleets and distributed API workers. Nika's extension runtime does not need Redis clustering, and adding a second limiter with its own retry/lifecycle semantics would overlap with Dexie, `RetryClass`, Effect Journal, and our per-chat execution policy.

Bottleneck remains a possible Nika Server candidate if a future server needs distributed rate limiting across many workers, but it is unnecessary inside the Chrome Extension.

Source:

- https://github.com/SGrondin/bottleneck

---

## 3. Why p-throttle and p-limit are too narrow

`p-throttle` is a good browser-compatible throttling primitive. It supports strict throttling, AbortSignal and queue-size inspection. It is useful when the problem is simply "call this function no more than N times per interval".

Nika needs more:

- priority;
- concurrency;
- queue saturation signals;
- explicit live queue state;
- pause/resume;
- per-job cancellation;
- future custom fairness ordering.

Therefore `p-throttle` is unnecessary if `p-queue` is already present.

`p-limit` is even narrower: it is primarily a concurrency gate. It does not replace the rate-limited dispatcher.

Sources:

- https://github.com/sindresorhus/p-throttle
- https://github.com/sindresorhus/p-limit

---

## 4. Static pacing is not enough

Nika should not encode a single permanent rule such as "always one SEND per minute".

The system needs a durable `DispatchPolicy` with at least:

```ts
type DispatchPolicy = {
  baseSpacingMs: number;
  maxConcurrentActiveChats: number;
  maxQueueAdmission: number;
  recoveryRamp: 'linear' | 'exponential';
  jitterRatio: number;
};
```

And a runtime `ThrottleState`:

```ts
type ThrottleState = {
  scope: 'global' | 'site' | 'account' | 'chat';
  state: 'NORMAL' | 'SLOW' | 'COOLDOWN' | 'OPEN';
  notBefore: number | null;
  reason: string | null;
  consecutiveSignals: number;
  lastSignalAt: number | null;
};
```

The important point is that cooldown must be durable. If ChatGPT says "try again later" and the service worker restarts, Nika must not forget the cooldown and immediately resume the burst.

---

## 5. Backpressure signal hierarchy

For normal web UI automation, Nika may not always see raw HTTP response headers. Therefore rate-limit detection needs several levels.

### Tier A — structured server signal

If a future LocalBridge/CDP/network provider exposes an HTTP `429` or `503` with `Retry-After`, honor it exactly where possible.

HTTP defines `Retry-After` as either:

- delay seconds; or
- an HTTP date.

For `429`, it tells the client how long to wait before a new request. For `503`, it may describe expected recovery time.

Sources:

- https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Retry-After
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/429

### Tier B — semantic UI signal

SiteProfile may identify states such as:

- rate-limit banner;
- "too many requests" message;
- "try again later";
- temporarily unavailable;
- account/session restriction.

These should produce typed observations, not generic strings:

```ts
{ kind: 'RATE_LIMITED', retryAfterMs?: number }
{ kind: 'TEMPORARILY_UNAVAILABLE' }
{ kind: 'ACCOUNT_BLOCKED' }
```

### Tier C — failure-pattern signal

Repeated transient failures across different chats can indicate systemic degradation even when the site exposes no explicit message.

Examples:

- 5 independent chats fail to locate the same required control after canary was previously healthy;
- 3 SEND attempts return `NO_EFFECT` across separate chats;
- navigation/load latency exceeds a learned high-water mark across the site.

These should raise a site-level circuit breaker rather than retrying every chat independently.

---

## 6. Scope-aware cooldowns

A rate-limit signal should apply to the narrowest scope supported by evidence.

Possible scopes:

1. `chat` — one conversation is unhealthy;
2. `account` — current ChatGPT account/session is restricted;
3. `site` — ChatGPT UI/service is degraded;
4. `global` — local browser/bridge/runtime is unhealthy.

Never pause all Nika work because one chat has a broken DOM unless evidence indicates a broader scope.

Conversely, never continue firing into 49 more chats when a canary produced a site/account-level rate-limit signal.

---

## 7. Fairness across projects and chats

Plain priority queues can starve lower-priority work. Nika should therefore keep fairness in the durable selection layer, not rely only on `p-queue` priority.

Recommended durable selection policy:

1. filter jobs with `notBefore <= now`;
2. exclude chats/accounts/sites under cooldown;
3. group by project/workflow lane;
4. choose using weighted round-robin / deficit round-robin;
5. within a lane, order by priority then `scheduledAt`;
6. claim only the small batch that the live queue has capacity to accept.

This prevents one large 50-developer batch from permanently starving audit, coordinator, manual or recovery work.

Suggested priority classes:

- `P0_RECOVERY`
- `P1_MANUAL_OPERATOR`
- `P2_AUDIT_GATE`
- `P3_WORKFLOW`
- `P4_BACKGROUND`

But fairness must still guarantee aging so lower classes eventually make progress unless explicitly paused.

---

## 8. Queue admission is different from durable backlog

Do not load all 10,000 durable jobs into `p-queue`.

Dexie is the backlog.

`p-queue` should contain only a bounded live window, for example:

`running + next 10-50 dispatchable tasks`.

Use queue saturation/backpressure APIs to stop admission when the in-memory queue is full.

This has two benefits:

- a service-worker restart loses only transient scheduling objects, not jobs;
- priorities/cooldowns can be re-evaluated before future jobs are admitted.

---

## 9. Cancellation contract

Cancellation must distinguish queued intent from an already-started external side effect.

### Before dispatch

A durable job may be marked `CANCELLED`, and if already admitted to `p-queue`, its `AbortSignal` can remove it from the live queue.

### During READ

If the underlying operation supports AbortSignal, stop it.

### During WRITE before external mutation

Abort is allowed only while action state is still `PREPARED` and no external mutation has started.

### During/after WRITE dispatch

Do not treat cancellation as rollback.

If SEND has already been clicked, cancellation must transition to observation/reconciliation. The result may become `SETTLED_SUCCESS`, `NO_EFFECT`, or `AMBIGUOUS`.

This prevents the false assumption that aborting a promise undoes a browser side effect.

---

## 10. Chrome alarms are wake-ups, not precision timers

Chrome documents that extension alarms are limited to roughly one firing every 30 seconds in production and may be delayed arbitrarily. They also do not wake a sleeping device; missed repeating alarms fire at most once after wake and are rescheduled from that point.

Therefore:

- `chrome.alarms` wakes the dispatcher;
- Dexie `notBefore` / `scheduledAt` decides what is actually due;
- precise 60-second spacing while the worker is alive is implemented by the live executor;
- after sleep/restart, dispatcher recomputes eligibility from durable timestamps;
- missed jobs never burst merely because many became overdue while the PC slept.

Source:

- https://developer.chrome.com/docs/extensions/reference/api/alarms

---

## 11. Adaptive slowdown policy

Recommended initial algorithm:

### NORMAL

Use `baseSpacingMs` (for example 60s for large ChatGPT batches).

### First transient site/account signal

Transition to `SLOW`:

- spacing x2;
- add bounded random jitter;
- allow read-only monitoring;
- stop admitting new WRITE jobs for a short observation window.

### Explicit `Retry-After`

Transition to `COOLDOWN` until the parsed deadline.

### Repeated systemic failures

Transition to `OPEN`:

- no new WRITE actions;
- health/read probes only;
- manual operator may inspect;
- canary required before closing the circuit.

### Recovery

Do not instantly return from 5-minute cooldown to full throughput.

Use ramp-up:

`one canary -> one additional job -> small batch -> normal spacing`.

A successful browser click is not sufficient recovery evidence. Canary must pass target identity and postconditions.

---

## 12. Jitter is useful but must remain bounded

If several independent scopes resume at exactly the same timestamp, deterministic scheduling can recreate a synchronized burst.

Add a small bounded jitter to non-user-exact background dispatch times, for example +/- 5-10% of spacing.

Do not apply jitter to explicit operator instructions that require an exact start unless requested.

For the user-facing "one developer every minute" mode, maintain a minimum spacing of 60 seconds and only jitter later, never earlier than the durable `notBefore` threshold.

---

## 13. New runtime primitives

Recommended small modules:

- `DispatchPolicy`
- `DispatchAdmissionController`
- `FairJobSelector`
- `ThrottleStateRepository`
- `RateLimitSignalClassifier`
- `RetryAfterParser`
- `RecoveryRampController`
- `DispatchTelemetry`

No new large runtime dependency is required beyond existing `p-queue`.

---

## 14. Test matrix

Before claiming large-batch reliability, add deterministic tests for:

1. 50 READY jobs start no closer than configured spacing;
2. fixed-window boundary cannot create a burst (`strict` mode);
3. service-worker restart retains durable `notBefore` values;
4. PC sleep with 50 overdue jobs does not launch them simultaneously;
5. explicit `Retry-After: 120` pauses the correct scope for at least 120 seconds;
6. HTTP-date Retry-After parsing;
7. UI rate-limit signal without HTTP visibility;
8. one broken chat does not freeze unrelated chats;
9. site-level rate-limit signal stops new site WRITE jobs;
10. manual P1 work can bypass background starvation but not a safety OPEN circuit;
11. lower-priority queues age and eventually run;
12. queued task cancellation rejects/removes it;
13. cancellation after SEND dispatch does not claim rollback;
14. p-queue loss after worker termination does not lose durable jobs;
15. cooldown recovery uses a canary/ramp rather than releasing all backlog.

---

## 15. Final recommendation

Keep:

- Dexie as durable backlog and throttle-state authority;
- `p-queue` as bounded live executor;
- strict sliding-window limiting for paced SEND starts;
- per-chat FIFO/lease/fencing for mutation serialization.

Do not add now:

- Bottleneck in the extension;
- p-throttle;
- p-limit as a second dispatcher primitive;
- generic retry around non-idempotent browser WRITE actions.

Future server note:

Bottleneck can be reconsidered if Nika Server needs multi-process/Redis-backed rate limiting. Browser and server rate-limit implementations do not need to be the same library.

The core invariant is:

> A due job is not automatically a runnable job. It must pass durable time eligibility, scope cooldown, fairness selection, live admission capacity, per-target mutation authority, and action preconditions before it may start.
