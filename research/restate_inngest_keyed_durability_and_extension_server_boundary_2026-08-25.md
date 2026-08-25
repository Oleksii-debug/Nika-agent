# Restate, Inngest, keyed durability, and the Extension ↔ Server boundary

Date: 2026-08-25
Repository: `Oleksii-debug/Nika-agent`

## Executive decision

Nika-agent should **not** move a server-grade durable workflow engine into the Chrome Extension. The browser-side baseline remains a small MV3 runtime with IndexedDB/Dexie durability, explicit Effect Journal semantics, per-chat leases/fencing, event-driven waits, and semantic DOM verification.

However, for the future `Nika Server`, two open-source systems deserve explicit architectural treatment:

1. **Restate** is the strongest newly identified fit for the `one chat = one durable single-writer actor` model.
2. **Inngest** is a strong fit for event-driven durable jobs, scheduling, fairness/flow control, and simple TypeScript operations.

The key boundary is:

`Nika Server may durably decide and schedule what should happen, but the Chrome Extension remains the authority that can prove whether a browser side effect actually happened.`

A server workflow engine cannot make a ChatGPT web click exactly-once unless the browser target participates in the same idempotency protocol. Therefore browser mutations still require the Nika Effect model:

`PREPARE → DISPATCH → OBSERVE → SETTLE / AMBIGUOUS`.

---

## 1. Current live-code gap this research addresses

The current `src/runtime.ts` already made an important P0 improvement: `send` has retry policy `none`, while `status` and `captureLatest` may perform bounded read-only retries.

But current serialization is still in-memory:

```ts
const agentQueues = new Map<string, Promise<void>>();
```

This prevents overlapping operations only while the current MV3 service-worker execution context is alive. It is not durable ownership.

Likewise the current runtime still polls ChatGPT with a one-second loop in `waitUntilIdle()`.

These browser-local gaps should be fixed with Dexie/leases/waits, not by embedding Restate or Inngest inside the extension.

The new question is instead: **what should own durable orchestration if Nika later has a local/server control plane spanning many browsers, machines, projects, and workers?**

---

## 2. Restate: unusually strong fit for ChatActor semantics

Repository: https://github.com/restatedev/restate
Documentation: https://restate.dev/
License: open-source; verify specific component/license at adoption time.

Restate's core primitives include:

- durable execution with journaled steps;
- reliable messaging;
- durable promises/timers;
- keyed stateful entities called Virtual Objects;
- single-writer execution per object key;
- workflows and external signals;
- introspection/UI/CLI.

Restate's own chat-session example is particularly relevant: a Virtual Object keeps state per chat key and processes one method invocation at a time, while different chat keys execute independently.

That maps almost directly to Nika:

```text
ChatActor("DEV17")
ChatActor("DEV18")
ChatActor("AUDIT03")
```

Each actor could own durable server-side state such as:

- desired workflow/run state;
- scheduler admission state;
- latest known browser-session binding;
- cooldown/circuit state;
- outstanding browser command IDs;
- human-handoff state;
- last confirmed response receipt.

Restate Virtual Objects are therefore a much closer conceptual match than a generic task queue.

### 2.1 Important 2026 development: Restate flow control

Restate 1.7, released July 2026, added Virtual Queues and broader flow-control primitives. This matters because Nika needs not only durability but also:

- per-chat serialization;
- cross-chat parallelism;
- global/account/site caps;
- fairness;
- delayed work;
- controlled ramp-up after cooldown.

This makes Restate more interesting for future server orchestration than it was in earlier broad comparisons.

### 2.2 What Restate does not solve for browser SEND

Restate can journal a server-side call and prevent re-executing a completed durable step. That does **not** magically make this safe:

```text
server → extension → click Send in ChatGPT
```

Failure window:

1. server asks Extension to SEND command `C123`;
2. Extension clicks Send;
3. ChatGPT accepts the prompt;
4. Extension/browser connection dies before receipt reaches server;
5. Restate sees an unresolved external step.

If the server blindly retries command `C123`, duplicate browser mutation is still possible.

Therefore the Extension must expose a durable browser protocol such as:

```text
prepareEffect(commandId, promptHash)
dispatchEffect(commandId)
getEffectStatus(commandId)
observeEffect(commandId)
```

and return states like:

```text
PREPARED
DISPATCHING
SETTLED_SUCCESS
NO_EFFECT
BLOCKED
AMBIGUOUS
```

Restate can then durably orchestrate **that protocol**, instead of treating `click Send` as an ordinary retryable RPC.

This is the central server/browser boundary.

---

## 3. Inngest: strong event-driven scheduler and flow-control candidate

Documentation: https://www.inngest.com/docs
Self-hosting: https://www.inngest.com/docs/self-hosting

Inngest's TypeScript SDK provides durable functions with:

- step-level checkpointing/memoization;
- retries;
- cron/event/webhook triggers;
- concurrency control;
- prioritization;
- throttling;
- rate limiting;
- debounce;
- idempotency controls;
- observability.

Current self-hosting can run as a single binary with SQLite or Postgres backing storage, which is operationally attractive for a small Nika deployment.

This fits future tasks such as:

```text
project scheduled run
nightly coordinator workflow
batch admission
retry-safe server-side analysis
report generation
browser health sweeps
```

### 3.1 Particularly relevant Inngest semantics

Inngest supports keyed concurrency, so a function can effectively say:

```text
concurrency key = chatId
limit = 1
```

It also distinguishes concurrency from rate limiting: sleeping/waiting runs need not consume active concurrency, while start rates can be limited separately.

That aligns well with Nika's existing research distinction:

`active conversations != browser mutation launch rate`.

Inngest's built-in flow-control model is therefore stronger than wiring cron + queues + rate limiter manually on a server.

### 3.2 Limitation for Nika's exact browser semantics

Inngest uses a step-based durable execution model: completed steps are memoized and skipped on replay.

Again, the browser-side action must expose a receipt/idempotency protocol. An Inngest step that simply does:

```ts
await extension.send("DEV17", prompt)
```

cannot know whether a network error occurred before or after ChatGPT accepted the message.

So Inngest has the same architectural boundary as Restate:

**server durability cannot replace browser-side effect reconciliation.**

---

## 4. Restate vs Inngest vs previously researched server candidates

| System | Strongest Nika fit | Main advantage | Main concern |
|---|---|---|---|
| Restate | keyed `ChatActor`, single writer, durable state/signals | Virtual Objects map directly to per-chat ownership | new infrastructure layer; browser effects still need custom receipt protocol |
| Inngest | schedules, event workflows, flow control | very convenient TypeScript jobs + built-in queue controls | less naturally entity/actor-centric than Restate |
| DBOS | lightweight TS + Postgres durable workflows | small operational footprint, SQL-centric | per-chat actor semantics need more application design |
| Hatchet | worker queues, dashboard, rate/concurrency controls | strong task orchestration and operator visibility | heavier than browser-only runtime needs |
| Temporal | maximum workflow maturity | proven durable workflow model | highest operational/conceptual weight |

### Current recommendation

For the **Chrome Extension**:

> none of these.

For a future **small self-hosted Nika Server**:

> spike Restate and Inngest before committing to DBOS/Hatchet/Temporal.

For the current architecture, Restate is now the most interesting candidate when the server needs persistent per-chat actors. Inngest is arguably the simpler candidate if the server remains mostly event/job oriented.

---

## 5. Recommended split of authority

### Browser Extension owns

- real logged-in Chrome tabs;
- tab/frame/document/navigation identity;
- user draft protection;
- semantic DOM resolution;
- browser permissions;
- human takeover;
- mutation permit;
- Effect Journal for browser actions;
- exact composer read-back;
- exact user-message receipt;
- `AMBIGUOUS` detection;
- SiteProfile compatibility.

### Server owns

- cross-machine orchestration;
- global project scheduling;
- long-term queue admission;
- multi-browser assignment;
- project-level fairness;
- durable high-level workflow state;
- analytics and operator history;
- external integrations;
- server-side AI/tool calls;
- global policy.

### Shared protocol owns

- `commandId`;
- `effectId`;
- protocol version;
- target identity;
- desired capability;
- prompt/content hash;
- deadline;
- retry class;
- result/evidence envelope.

The server must never infer browser success from transport acknowledgement alone.

---

## 6. Recommended server-side `ChatActor` contract

A future server abstraction could look conceptually like:

```ts
interface ChatActor {
  enqueueIntent(intent: BrowserIntent): Promise<IntentReceipt>;
  getIntent(id: string): Promise<IntentState>;
  reconcileBrowserState(report: BrowserReport): Promise<void>;
  requestHumanHandoff(reason: string): Promise<HandoffState>;
  setCooldown(signal: RateLimitSignal): Promise<void>;
}
```

The important point is that `enqueueIntent()` does not mean the browser effect happened.

Server-level state might be:

```text
QUEUED
ASSIGNED_TO_BROWSER
BROWSER_PREPARED
BROWSER_DISPATCHING
BROWSER_SETTLED
BROWSER_AMBIGUOUS
WAITING_FOR_RESPONSE
COMPLETED
```

This gives the server visibility without stealing the Extension's authority to determine browser truth.

---

## 7. Scheduling implications

This research also reinforces the existing scheduling architecture.

### Browser-only mode

```text
chrome.alarms
→ Dexie due jobs
→ FairJobSelector
→ p-queue live admission
→ per-chat lease
```

### Server-managed mode

```text
Restate/Inngest durable schedule
→ select browser/session
→ issue BrowserIntent
→ Extension durable inbox/effect
→ execute when local policy permits
→ receipt/reconciliation back to server
```

Even in server-managed mode, a server burst must not bypass browser-level pacing.

The Extension should be allowed to respond:

```text
ACCEPTED_NOT_BEFORE = 2026-08-25T12:04:00Z
COOLDOWN
HUMAN_CONTROL
SITE_DEGRADED
```

rather than blindly obeying immediate SEND requests.

---

## 8. Architectural pattern: durable inbox on both sides

A robust future bridge should use durable intent IDs rather than transient RPC semantics.

Server:

```text
outbox/browserIntents
```

Extension:

```text
inbox/browserIntents
browserEffects
```

Flow:

1. Server creates intent `I-123` durably.
2. Extension receives/imports `I-123` idempotently.
3. Extension creates local Effect `E-456` before DOM mutation.
4. Extension executes and observes.
5. Extension returns durable receipt referencing both IDs.
6. Server marks intent complete only from the receipt.
7. Reconnecting either side can query status by stable ID rather than blindly replaying the command.

This pattern is more important than which workflow engine is selected.

---

## 9. What not to do

Do **not**:

- embed Restate/Inngest/Temporal inside MV3;
- make server workflow state the only source of browser mutation truth;
- model Extension calls as ordinary automatically retried HTTP activities;
- let a server bypass local user-control/draft/cooldown policy;
- send raw selectors from server and execute them directly;
- assume `RPC success` equals `browser effect success`;
- replace local Dexie durability with a permanent network connection.

Nika must remain useful and safe when disconnected from the server.

---

## 10. New implementation interfaces worth reserving now

Even before Nika Server exists, it is worth preventing browser code from hard-coding a future transport.

Recommended small interfaces:

```text
IntentSource
BrowserIntent
BrowserIntentInbox
BrowserEffectReceipt
ExecutionAuthority
```

Current implementation:

```text
IntentSource = LocalScheduler / SidePanel
ExecutionAuthority = LocalDexieRuntime
```

Future implementation can add:

```text
IntentSource = NikaServerBridge
```

without changing `ChatGPTAdapter` or workflow action semantics.

---

## 11. Recommended spikes

### Spike A — Restate ChatActor

Build a tiny server-only prototype:

- Virtual Object keyed by `chatId`;
- two concurrent commands to the same chat serialize;
- commands to different chats execute concurrently;
- actor waits durably for an external browser receipt;
- restart Restate/service process while waiting;
- resume from the receipt without duplicate logical completion.

### Spike B — Inngest flow control

Prototype:

- 50 browser intents;
- keyed concurrency `chatId = 1`;
- global start throttle;
- one chat cooldown;
- one site-level cooldown simulation;
- sleeping waits do not consume active concurrency;
- inspect operational UX/history.

### Spike C — duplicate bridge delivery

Independent of engine:

- server sends intent `I1`;
- Extension imports `I1`;
- connection drops;
- server delivers `I1` again;
- Extension must not create a second SEND Effect;
- status query returns the original Effect state.

This spike is mandatory before any server workflow engine is allowed to control live ChatGPT tabs.

---

## 12. Decision

### Adopt now

No new production dependency.

Continue browser runtime implementation with:

- Dexie Jobs/Effects/Leases;
- ambiguity-safe SEND settlement;
- durable waits;
- paced dispatch;
- mutation permits;
- semantic evidence.

### Research/spike next

**Restate** becomes the leading candidate for a future actor-oriented Nika Server because Virtual Objects natively provide keyed state and single-writer execution per chat.

**Inngest** becomes a strong alternate candidate for a scheduler/event-oriented server because it packages durable steps, scheduling, concurrency, rate limiting, throttling, fairness-oriented queueing and observability in a simple TypeScript model.

### Do not decide yet

Do not select the final Nika Server engine until the Extension-side durable Effect protocol exists. Otherwise any server prototype would hide the hardest unresolved boundary behind optimistic RPC semantics.

---

## Sources

- Restate repository: https://github.com/restatedev/restate
- Restate durable execution guide: https://restate.dev/what-is-durable-execution
- Restate chat/Virtual Object example: https://restate.dev/blog/building-an-llm-chat-task-bot-with-restate
- Restate 1.7 flow control release: https://restate.dev/blog/announcing-restate-1-7
- Restate Virtual Object/Temporal comparison: https://restate.dev/vs/temporal
- Inngest documentation: https://www.inngest.com/docs
- Inngest execution model: https://www.inngest.com/docs/learn/how-functions-are-executed
- Inngest TypeScript SDK: https://www.inngest.com/docs/reference/typescript/v4/intro
- Inngest concurrency: https://www.inngest.com/docs/reference/typescript/v4/functions/concurrency
- Inngest self-hosting: https://www.inngest.com/docs/self-hosting
