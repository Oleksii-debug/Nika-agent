# Messaging, DOM observation, scheduling helpers, and MV3 test-stack decisions

Date: 2026-08-24
Repository: `Oleksii-debug/Nika-agent`

## Executive decision

This research cycle narrows reusable infrastructure around four boundaries that still matter in the current Nika-agent prototype:

1. typed cross-context messaging;
2. background-owned services and database access;
3. DOM observation for dynamic ChatGPT state;
4. realistic testing of Manifest V3 lifecycle and extension APIs.

The recommended baseline is now:

`WXT + TypeScript + @webext-core/messaging v4 + optional @webext-core/proxy-service + Dexie + XState + p-queue + dom-accessibility-api + native MutationObserver + WXT Vitest/fake-browser + Playwright E2E`.

No new generic browser automation engine is required for the current ChatGPT-focused MVP.

---

## 1. Messaging: keep `@webext-core/messaging`, but pin current v4

WXT officially lists `@webext-core/messaging`, `webext-bridge`, `trpc-chrome`, `@webext-core/proxy-service`, and Comctx as supported alternatives to raw extension messaging APIs.

For Nika-agent, `@webext-core/messaging` remains the best default because it is:

- lightweight;
- type-safe;
- maintained in the same ecosystem as WXT;
- cross-browser;
- simpler than a full RPC/router stack;
- sufficient for explicit command/result protocols such as `ChatCommand -> ActionResult`.

Important 2026 detail: Chrome 144 changed Promise/listener behavior enough to expose a bug in earlier wrappers. `@webext-core/messaging` v4 changed its implementation/types around current Chrome/WXT APIs and is the version to target. Do not copy old v2/v3 examples blindly.

### Recommendation

Adopt a single protocol map such as:

- `chat.status`
- `chat.send.prepare`
- `chat.send.commit`
- `chat.capture.latest`
- `chat.observe.subscribe`
- `runtime.job.updated`
- `runtime.health`

The message layer should transport commands and events only. It must not own retry, workflow, or persistence semantics.

### Why not `webext-bridge` as the default?

`webext-bridge` is mature and MIT-licensed, and supports background/content-script/devtools/popup/window contexts. It is a viable fallback if Nika later needs richer direct context-to-context routing.

However, it internally uses the background/event context as a staging relay and has a larger conceptual surface than Nika currently needs. The current architecture benefits more from a small explicit protocol than from a generic bridge abstraction.

Decision: **reference/fallback, not baseline dependency**.

### Why not Comlink?

Comlink is excellent for WebWorker/MessagePort RPC and is tiny, but Nika's core messaging problem is WebExtension context routing, tab targeting, MV3 lifecycle, and Chrome extension errors. Comlink does not solve those extension-specific concerns.

Decision: **do not add to baseline**.

---

## 2. `@webext-core/proxy-service`: useful, but only for background-owned application services

`@webext-core/proxy-service` provides a type-safe RPC-like proxy where code can be called from any extension context but executed in the background service worker.

Its documentation specifically shows IndexedDB repositories as a good use case: the background registers the service synchronously, and extension UI/content scripts call it through a proxy.

This maps well to Nika's future background-owned services:

- `JobRepository`;
- `EffectJournal`;
- `ScheduleService`;
- `LeaseService`;
- `LogRepository`;
- `HealthService`.

### Important lifecycle rule

Service registration must happen synchronously at background startup before awaiting initialization. Dependencies such as DB-open promises can be passed into services and awaited inside methods.

### Boundary

Do **not** use proxy-service as the ChatGPT DOM transport.

The page/content-script direction should remain an explicit command/result protocol because it needs:

- `tabId` targeting;
- conversation identity;
- action evidence;
- ambiguity classification;
- content-script liveness/recovery.

Decision: **good optional dependency for background-owned application services, not browser action transport**.

---

## 3. `@webext-core/job-scheduler`: good library, wrong scheduling model for Nika's large fan-out

The library is actively maintained and now supports:

- one-time jobs;
- interval jobs;
- cron jobs;
- MV3;
- Chrome/Firefox/Safari.

It is useful for conventional browser extensions where each logical job maps naturally to an alarm.

Nika-agent intentionally needs different semantics at 30-100 chats:

`Durable Schedule DB -> one wake alarm -> due-job query -> paced dispatcher -> per-chat lease -> workflow`.

Reasons:

- missed jobs need Nika-specific policies;
- many due schedules must not create a burst;
- dispatch rate and active concurrency are separate;
- pacing metadata must survive service-worker death;
- a schedule creates durable Job intents, not immediate side effects.

Using a generic per-job scheduler would risk moving Nika back toward one-alarm-per-agent behavior.

Decision: **do not adopt as scheduler core**. Reuse only ideas/API patterns if useful.

---

## 4. DOM observation: native `MutationObserver` remains preferable to another dependency

The ecosystem contains useful DOM observer libraries:

- `selector-observer` — observes addition/removal of selector matches;
- `arrive.js` — element creation/removal events over MutationObserver;
- newer small TypeScript wrappers such as `dom-observer`.

They are useful for generic page augmentation.

For Nika, the important problem is not merely “wait for selector X to appear.” It is a domain-specific ChatGPT state transition:

`GENERATING -> DOM still mutating -> generating control disappears -> assistant response quiet-window -> stable fingerprint`.

A small local wrapper over native `MutationObserver` gives us better control over:

- AbortSignal/cancellation;
- debounce/quiet windows;
- snapshot fingerprinting;
- exact observed root;
- typed ChatGPT state events;
- removal/rebinding after SPA navigation.

Adding a generic selector watcher would save little code and add another abstraction around the exact API we need.

Decision: **use native MutationObserver behind a small Nika-owned `DomStateObserver`**.

Suggested interface:

- `observeChatState(root, callback, signal)`;
- `waitForStableResponse(expectedAfterMessageId, quietMs, deadline)`;
- `waitForComposerReady(deadline)`;
- `waitForUserMessage(hash, deadline)`.

The observer should emit semantic events, not raw MutationRecords, outside the adapter layer.

---

## 5. Testing: adopt WXT's current fake-browser stack immediately

WXT has first-class Vitest integration through `wxt/testing/vitest-plugin` and re-exports `@webext-core/fake-browser`.

The fake browser provides an in-memory extension API implementation and resets state between tests. Current `@webext-core/fake-browser` is actively maintained and released in 2026.

This is a strong fit for Nika's deterministic tests of:

- storage and migration behavior;
- alarm registration/reconciliation;
- runtime message handlers;
- tab lookup and target binding;
- scheduler enqueue behavior;
- service startup;
- extension API error handling.

### Important current WXT rule

WXT v0.21+ removed older barrel imports and expects specific imports such as:

- `wxt/testing/vitest-plugin`;
- `wxt/testing/fake-browser`.

Also, current WXT/fake-browser reflects the modern Chrome callback/message listener semantics. Old mocks that return a Promise directly from `runtime.onMessage` listeners should be updated to callback + `return true` where appropriate.

This matters because Nika's current background code already uses callback-style `sendResponse`, so the code direction is compatible.

Decision: **add WXT Vitest plugin/fake-browser coverage before adding more runtime features**.

---

## 6. Fake-browser is not enough: preserve real Chrome E2E gates

In-memory WebExtension APIs cannot prove:

- MV3 service-worker suspension/restart behavior;
- real tab discard/freeze behavior;
- content script reinjection/recovery;
- ChatGPT SPA DOM behavior;
- real keyboard/composer semantics;
- accessibility exposure to Chrome/NVDA;
- post-SEND ambiguity windows.

Therefore Nika needs two test tiers.

### Tier A — fast deterministic tests

Vitest + WXT fake-browser:

- jobs;
- schedules;
- queue admission;
- leases/fencing;
- idempotency state machine;
- effect journal;
- message protocol;
- recovery decisions.

### Tier B — real Chromium E2E

Playwright/Chrome extension test harness:

- extension loads under MV3;
- content script connects to ChatGPT fixture/controlled test page;
- service worker can be terminated and workflow resumes from durable state;
- SEND after ambiguous crash probes before retry;
- active manual composer blocks automation;
- stale semantic refs are rejected;
- discarded/reloaded target rebinds correctly.

A local deterministic ChatGPT-like fixture should be used for CI so production ChatGPT is not required for every test. A smaller live canary suite can validate current ChatGPT compatibility separately.

---

## 7. Current-code implications

The current prototype has raw `chrome.runtime.onMessage` and `chrome.tabs.sendMessage` contracts. This is small enough to migrate now before many more commands are added.

Recommended migration order:

1. introduce `src/messaging/protocol.ts` using `@webext-core/messaging` v4;
2. convert popup/background command paths first;
3. convert content-script status/send/capture paths;
4. preserve `tabId` as an explicit transport target;
5. introduce standardized timeout/error normalization around every remote call;
6. keep durable Job/Effect state outside the messaging layer.

Do not combine the messaging migration with the whole workflow rewrite in one giant change.

---

## 8. Updated dependency decisions

### Adopt now

- `@webext-core/messaging` v4 — typed extension protocol.
- WXT Vitest plugin / `@webext-core/fake-browser` — deterministic extension API tests.

### Strong candidate after a small spike

- `@webext-core/proxy-service` — background-owned DB/application services.

### Keep existing planned dependencies

- Dexie — durable IndexedDB application state.
- XState — workflow state-machine semantics.
- p-queue — in-memory dispatcher/backpressure only.
- dom-accessibility-api — semantic accessibility naming/role support.

### Do not adopt as baseline

- `webext-bridge` — capable but unnecessary extra routing abstraction for current needs.
- Comlink — excellent Worker RPC, but not WebExtension lifecycle/tab routing.
- `@webext-core/job-scheduler` — useful generic scheduler, but conflicts with Nika's one-wake-alarm + durable dispatcher model.
- selector-observer/arrive.js — native MutationObserver + small domain wrapper is more appropriate.

---

## 9. Concrete next implementation slices

1. Add WXT Vitest configuration and fake-browser tests for current background/storage code.
2. Introduce `@webext-core/messaging` v4 typed protocol.
3. Define stable `BrowserCommand` / `ActionResult` error codes.
4. Add Dexie schema and migration from current `chrome.storage.local` arrays.
5. Add durable Job + Effect tables.
6. Replace one-alarm-per-agent with wake/reconcile/enqueue architecture.
7. Add native `DomStateObserver` with cancellation and quiet-window semantics.
8. Add ChatGPT fixture page for deterministic E2E.
9. Add forced service-worker-loss tests around SEND ambiguity.
10. Only after those gates, expand workflow features/UI.

## Final conclusion

The new research does not justify another large framework. It reinforces a small, coherent stack around WXT.

The highest-value reuse is now **webext-core's messaging and testing ecosystem**, while scheduler and DOM observation should remain Nika-specific because their semantics are unusually strict: durable fan-out, pacing, ambiguity-safe browser side effects, ChatGPT state recognition, and user-collision protection.
