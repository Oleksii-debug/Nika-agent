# ChatGPT durable delivery, exact receipts, and queue recovery references

Date: 2026-08-25
Repository: `Oleksii-debug/Nika-agent`

## Executive decision

The most directly relevant open-source reference found in this cycle is `kartikkabadi/chatgpt-yolo`, an MIT-licensed local-first Chrome extension specifically designed for persistent prompt queues and bounded workflows in long ChatGPT conversations.

Its reliability model independently converges on the same core rules Nika has been deriving from distributed-systems analysis:

- persist submission intent before touching the composer;
- never overwrite a user draft;
- only one sender lease per conversation;
- verify the composer retained the exact intended text before submit;
- do not call SEND successful merely because a click or transport acknowledgement occurred;
- confirm delivery only after a new matching user message appears;
- make completion idempotent so a lost completion acknowledgement can be replayed safely;
- distinguish pre-submit failures from post-submit ambiguity;
- if a claim expires after submission started, fail closed as delivery unknown rather than retrying automatically.

This is strong external validation that Nika's planned `Effect Journal + lease/fencing + exact postcondition` model is the correct reliability boundary rather than unnecessary complexity.

Sources:

- https://github.com/kartikkabadi/chatgpt-yolo
- https://github.com/kartikkabadi/chatgpt-yolo/blob/main/docs/RELIABILITY_MODEL.md
- https://github.com/kartikkabadi/chatgpt-yolo/blob/main/tests/queue.test.js

## 1. What YOLO already proves in executable tests

YOLO's queue tests encode several failure cases Nika should replicate in TypeScript/Vitest rather than only documenting them.

### One sender per conversation

A second claim is rejected while another sender owns the queue. This is the same semantic role as Nika's planned per-chat mutation lease.

### Pre-submit claim expiry is retryable

If a claim expires before the submission phase begins, it is normalized back to pending. This is important: lease expiry by itself is not an ambiguous side effect.

### Submitting claim expiry is not retryable

If a claim has already entered `submitting` and then expires, YOLO normalizes it to a hard `delivery_unknown` failure. This is exactly the distinction Nika needs between:

- `PREPARED` / no external effect begun;
- `DISPATCHING` / external side effect may already have occurred.

### Completion is idempotent

If delivery was proven and queue completion succeeded but the acknowledgement was lost, repeating completion succeeds with `alreadyCompleted` rather than duplicating or corrupting state.

Nika should implement the same property for `EffectSettlement` and workflow checkpoint advancement.

### Ambiguous outcomes disable automatic retry

YOLO's tests explicitly verify that ambiguity pauses the queue and that automatic claiming remains blocked until a manual retry/reset. This is stronger than merely tagging an error as uncertain.

Nika's current `SEND_UNCERTAIN` behavior has already removed blind retry, but the next step is to persist ambiguity so it survives service-worker death and blocks automatic replay after restart.

## 2. Direct comparison with current Nika code

Current `src/runtime.ts` has made an important P0 improvement:

- `send` uses retry policy `none`;
- read-only `status` and `captureLatest` retain bounded retries;
- transport failure returns `SEND_UNCERTAIN` instead of reloading and replaying SEND.

However, Nika still records `prompt_sent` immediately after the content script returns `{ok:true}`. That is not a delivery receipt.

Current `entrypoints/chatgpt.content.ts` still does roughly:

`set composer -> click Send -> return ok`.

It does not yet prove:

- composer was empty before automation started;
- existing user-authored text was preserved;
- exact intended text survived framework reconciliation;
- route/conversation identity remained stable immediately before submit;
- a new user message appeared;
- the new user message exactly matches the intended prompt.

Therefore the next SEND contract should be:

`CLAIM -> PREPARE -> persist intent -> verify empty/draft policy -> write -> read-back -> mark DISPATCHING -> submit -> observe matching user message -> SETTLED_SUCCESS`.

If observation cannot determine the result:

`AMBIGUOUS / DELIVERY_UNKNOWN`.

## 3. Queue model to reuse, and what not to copy

YOLO is MIT-licensed, so selective source-level reuse is legally possible with attribution and preservation of the license notice.

The most valuable reusable material is not its entire extension. It is:

- queue state-transition logic;
- normalization rules;
- lease/claim tests;
- idempotent completion tests;
- ambiguous-delivery tests;
- bounded-history patterns;
- mandatory draft-protection invariants.

Nika should not copy YOLO's storage architecture wholesale.

YOLO intentionally keeps bounded per-conversation state in `chrome.storage.local`, with limits such as 50 queue items per conversation and 25 active queues/workflows. That is reasonable for its narrower product scope.

Nika is targeting larger multi-chat orchestration, durable effects, leases, schedules, response artifacts and cross-agent workflows. Dexie/IndexedDB remains the better authoritative store for Nika.

Recommended mapping:

- YOLO queue state machine semantics -> Nika TypeScript domain functions;
- YOLO `chrome.storage.local` persistence -> Nika Dexie transactions;
- YOLO sender claim -> Nika per-chat lease + fencing token;
- YOLO `submitting` -> Nika `Effect.DISPATCHING`;
- YOLO `delivery_unknown` -> Nika `Effect.AMBIGUOUS`;
- YOLO exact matching user-message receipt -> Nika `EffectProofEvaluator`;
- YOLO manual reset -> Nika Side Panel recovery/approval flow.

## 4. A critical refinement: delivery target should be at-most-once, not exactly-once

YOLO states its goal clearly: **at-most-once side effects with explicit recovery**, because the ChatGPT web UI cannot provide true exactly-once delivery.

This terminology is better for Nika as well.

Nika can provide:

- durable intent;
- idempotent local state transitions;
- observation-based deduplication;
- no automatic replay of ambiguous SEND;
- explicit reconciliation.

It cannot atomically commit both ChatGPT's external user-message mutation and local IndexedDB state.

Therefore documentation and APIs should avoid claiming exactly-once SEND.

Preferred wording:

`at-most-once automatic mutation + explicit ambiguity recovery`.

## 5. New test suite recommended for Nika

Before adding additional generic browser functionality, port the following failure tests into Nika's own runtime model:

1. two tabs attempt the same conversation SEND -> exactly one lease wins;
2. lease expires before DISPATCHING -> job safely returns to READY;
3. lease expires after DISPATCHING -> effect becomes AMBIGUOUS and cannot auto-retry;
4. completion acknowledgement is lost -> repeating settlement is idempotent;
5. composer contains manual text -> automated SEND does not modify it;
6. intended text fails read-back -> pre-submit failure, no click;
7. route changes between preparation and submit -> no click;
8. click occurs but matching user-message is not observed -> AMBIGUOUS;
9. composer clears but no matching user-message exists -> not success;
10. service worker restarts while an ambiguous effect exists -> automatic dispatcher remains blocked for that effect/chat;
11. two identical prompts sent consecutively -> receipt identity/message-count proves the second distinct delivery;
12. storage transaction fails before dispatch -> browser DOM remains untouched.

These tests should become release gates for ChatGPTAdapter.

## 6. Other open-source references from this cycle

### Web-API-Extension

`V-You/Web-API_Extension` provides another useful MV3 pattern: service-worker-owned persistent jobs, pause/resume, restart recovery and explicit partial/cancel behavior. Its broader job-runner architecture is useful as a reference for Nika's durable workflow lifecycle, but its arbitrary code/sandbox model is not required for Nika's constrained capability compiler.

Reference: https://github.com/V-You/Web-API_Extension

### browserclaw

`idan-rubin/browserclaw` continues to be a useful semantic browser reference. In addition to snapshot-scoped refs, it now explicitly exposes challenge/rate-limit detection states. Nika should borrow the typed-state idea (`blocked`, `rate-limited`, challenge kinds), but not automate CAPTCHA solving. Login/challenge states should route to cooldown or human handoff.

Reference: https://github.com/idan-rubin/browserclaw

### Chrome Faithful

`bpc-oss/chrome-faithful` remains a strong future LocalBridge/server reference for using the real logged-in Chrome while keeping privileged raw CDP behind an explicit trust boundary. It also demonstrates bounded verification/challenge detection and human handoff rather than pretending all pages are normally actionable.

Reference: https://github.com/bpc-oss/chrome-faithful

## 7. Updated implementation priority

This cycle changes the priority from more framework discovery to executable reliability parity with the strongest direct reference.

Recommended order:

1. Introduce durable `Effect` states in Dexie.
2. Add per-chat durable lease + fencing.
3. Persist SEND intent before DOM mutation.
4. Mandatory draft protection.
5. Composer exact-text read-back.
6. Persist `DISPATCHING` immediately before submit.
7. Observe a new exact matching user-message receipt.
8. Idempotent `settleEffect()`.
9. `AMBIGUOUS` hard block across service-worker restart.
10. Port YOLO-style queue fault tests into Vitest.
11. Only then replace polling waits and expand generic browser adapters.

## Final decision

`chatgpt-yolo` is currently the highest-value open-source reference for Nika's ChatGPT delivery layer because it solves the same external-side-effect problem in the same MV3 environment and backs the design with executable fault tests.

Adopt its reliability semantics and selectively reuse/test-port small MIT-licensed state-machine ideas where useful, but retain Nika's own Dexie/XState architecture for scale, scheduling, multi-chat workflows and generic-site expansion.

The key invariant is now externally validated:

**A ChatGPT SEND is not complete when the extension clicked Send. It is complete only when durable intent existed before the click and a new matching user message is observed afterward; otherwise the effect remains unproven and must fail closed.**