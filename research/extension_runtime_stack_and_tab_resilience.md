# Nika-agent: extension runtime stack and tab resilience research

Date: 2026-08-24

## Scope

This note narrows earlier research into concrete dependency and runtime decisions for the existing Nika-agent repository. The project already uses WXT 0.21.4, TypeScript 5.9, Vitest 3.2 and Manifest V3, so the goal is to avoid framework churn and add only dependencies that remove substantial implementation risk.

## Decision 1 — keep WXT; do not migrate to Plasmo

WXT is already present in the repository and is a strong fit for this project:

- MV3 support;
- file-based extension entrypoints;
- TypeScript-first development;
- Chrome/Edge/Firefox portability if needed later;
- fast dev reload;
- active ecosystem around `webext-core`;
- WXT testing integrates with `@webext-core/fake-browser`.

Plasmo is also capable and MIT-licensed, but switching now would create migration work without solving a Nika-agent-specific problem.

Sources:
- https://wxt.dev/
- https://github.com/wxt-dev/wxt
- https://github.com/PlasmoHQ/plasmo

## Decision 2 — use two storage tiers

### `chrome.storage` / WXT storage for small configuration

Use for:
- user preferences;
- UI settings;
- feature flags;
- last selected project/chat;
- lightweight installation metadata.

### Dexie / IndexedDB for operational state

Use Dexie for:
- projects;
- chat registry;
- schedules;
- workflow definitions;
- workflow runs;
- action ledger / idempotency keys;
- captured responses;
- execution history;
- errors and retry records.

Reason: these records are relational, numerous and query-heavy. Dexie 4.x is actively maintained and Apache-2.0 licensed.

Source:
- https://github.com/dexie/Dexie.js

## Decision 3 — XState v5 remains the preferred durable workflow core

Use XState actors/state machines for runtime control, but persist each durable checkpoint into IndexedDB rather than relying on in-memory actors surviving indefinitely.

Recommended state model:

`scheduled -> acquiring_target -> ensuring_tab -> sending -> waiting_for_generation -> capturing -> routing -> completed`

Error branches:

`retry_wait`, `needs_user`, `failed`, `cancelled`, `paused`

Persist after externally visible actions and before transitions that can be resumed after service-worker termination.

XState supports persisted actor snapshots and is MIT licensed.

Sources:
- https://github.com/statelyai/xstate
- https://stately.ai/docs/persistence

## Decision 4 — prefer `@webext-core/messaging` for internal extension messaging

WXT itself recommends several messaging wrappers. For Nika-agent the best fit is currently `@webext-core/messaging` because:

- it is lightweight and type-safe;
- it shares the WXT ecosystem/maintainer lineage;
- it supports content script, extension pages and service-worker communication;
- it avoids the extra generic routing surface of `webext-bridge` that Nika-agent does not currently need;
- recent webext-core releases remain active.

Potential use of `@webext-core/proxy-service` should be limited to services that conceptually live in the service worker (for example scheduler/database coordination). Do not make all cross-context communication look like transparent local function calls; explicit command/event boundaries are easier to audit and recover.

Sources:
- https://wxt.dev/guide/essentials/messaging
- https://github.com/aklinker1/webext-core
- https://webext-core.aklinker1.io/messaging/installation

## Decision 5 — use native `chrome.alarms` only as a wake-up mechanism

Do not use `setInterval` as the durable scheduler.

Canonical flow:

`Dexie schedule table -> reconciliation -> nearest/due chrome.alarms -> due-job scan -> workflow resume`

Important Chrome behavior:

- alarms do not wake a sleeping device;
- missed repeating alarms fire at most once after wake and then reschedule;
- Chrome 150 adds `persistAcrossSessions`, but older Chrome versions and other browsers do not provide the same guarantee;
- critical alarms should therefore be recreated/reconciled whenever the service worker starts.

Default missed-run policy for Nika-agent should be `RUN_ONCE_NOW`, not unrestricted catch-up, to avoid sending many duplicate prompts after a long sleep.

Source:
- https://developer.chrome.com/docs/extensions/reference/api/alarms

## Decision 6 — tab resilience is a first-class subsystem

This is a newly elevated requirement.

Chrome can automatically discard background tabs when resources are constrained. Chrome also exposes a `frozen` state; frozen tabs cannot run tasks such as timers or event handlers.

Therefore a stored `tabId` is only a hint, never proof that the ChatGPT execution context is alive.

Before every DOM action Nika-agent should run `ensureTargetReady(chatId)`:

1. resolve the logical chat record;
2. look up `lastKnownTabId`;
3. fetch the current tab;
4. reject stale/missing tab IDs;
5. detect `discarded`;
6. detect `frozen` when supported;
7. confirm URL still matches expected ChatGPT conversation;
8. if necessary reload/reopen the URL;
9. wait for navigation completion;
10. ping the content script;
11. reinject or wait for content script readiness;
12. only then execute the ChatGPT adapter action.

Required tab record fields should include:

- `chatId`;
- `conversationUrl`;
- `lastKnownTabId`;
- `windowId`;
- `lastSeenAt`;
- `lastReadyAt`;
- `lastDocumentId` where useful;
- `bindingState`;
- `focusPolicy`;
- `recoverable`.

Recommended `focusPolicy` default: `NEVER_FOCUS`.

Sources:
- https://developer.chrome.com/docs/extensions/reference/api/tabs

## Decision 7 — do not prevent automatic discard globally

Chrome exposes `autoDiscardable`, but setting large numbers of ChatGPT tabs permanently non-discardable is a poor default because it can create heavy memory pressure.

Prefer recovery over pinning memory.

Possible future mode:
- protect only the currently executing tab for a short critical section;
- restore its normal discardability after completion.

This should be performance-tested before implementation.

## Decision 8 — semantic DOM driver, no coordinate automation

Runtime DOM interaction remains DOM-first and semantic-first.

Locator priority:

1. roles and accessible names;
2. stable attributes (`data-*`, form semantics, IDs when stable);
3. scoped structural selectors;
4. localized visible text only as fallback.

Use `MutationObserver` to detect response lifecycle changes instead of high-frequency polling where possible.

Do not use screen coordinates, OCR or image matching as the primary driver.

## Decision 9 — ChatGPT adapter must be isolated from the generic DOM driver

Maintain these boundaries:

`Workflow Engine -> Workflow Actions -> ChatGPTAdapter -> DomDriver -> BrowserTransport -> Chrome APIs`

The ChatGPT adapter owns knowledge such as:

- find composer;
- set composer text;
- submit message;
- detect generating/idle state;
- capture latest assistant message;
- compute stable response fingerprint;
- detect authentication/limit/error states.

Generic browser code must not contain ChatGPT-specific selectors.

## Decision 10 — capture response text directly; Copy button is fallback

For developer/auditor routing, primary capture should read the last assistant response from the DOM and calculate a response identity/hash.

The visible ChatGPT Copy button can remain:

- fallback;
- parity check;
- manual user command.

Clipboard should not be the canonical data bus between workflows.

## Decision 11 — permission minimization

Current repository host access is narrow (`https://chatgpt.com/*`), which is appropriate.

Do not broaden to `<all_urls>` for the main product unless a concrete feature requires it.

If support for arbitrary sites is added later, prefer `optional_host_permissions` and request access when the user enables a site-specific adapter.

Chrome explicitly recommends optional permissions and narrow host permissions when possible.

Source:
- https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions

## Decision 12 — Side Panel for operations, full extension page for configuration

Use Chrome Side Panel for live control/status:

- active runs;
- pause/resume/stop;
- run now;
- current chat/action;
- errors requiring attention.

Use a full extension page for complex configuration:

- projects;
- chats;
- workflows;
- schedules;
- templates;
- logs;
- settings.

Do not make popup the primary interface.

Source:
- https://developer.chrome.com/docs/extensions/reference/api/sidePanel

## Decision 13 — accessibility architecture

The primary workflow editor should be list/form based, not canvas/drag-and-drop based.

Each workflow step should expose real HTML controls:

- heading for step number/name;
- action combobox;
- target chat combobox;
- multiline prompt editor;
- success transition combobox;
- failure transition combobox;
- retry controls;
- move up/down buttons;
- remove button.

Status changes should be available through an ARIA live region, but verbose logs should not spam live announcements.

Every operation must be keyboard-accessible without pointer interaction.

## Decision 14 — testing stack

Keep Vitest.

Add WXT's testing integration / `@webext-core/fake-browser` for deterministic tests of extension APIs.

Test tiers:

### Unit

- schedule calculations;
- workflow state transitions;
- idempotency ledger;
- retry/backoff;
- response fingerprinting;
- adapter locator ranking.

### Extension API integration

- alarms;
- tabs lifecycle;
- message routing;
- storage recovery;
- service-worker restart simulations.

### Browser end-to-end

Use Playwright against a loaded development extension for flows that require a real Chrome environment.

Critical acceptance tests:

1. send once -> service worker terminates -> resume without duplicate send;
2. target tab closes -> recover/reopen -> resume;
3. target tab is discarded -> recover -> resume;
4. page navigation changes document -> stale content-script request is rejected;
5. ChatGPT continues generating -> no premature next command;
6. same captured auditor response cannot be forwarded twice;
7. UI workflow can be created/edited/run using keyboard only.

Sources:
- https://wxt.dev/api/reference/wxt/testing/fake-browser/
- https://github.com/aklinker1/webext-core

## Recommended dependency shortlist

Production candidates:

- `wxt` — KEEP;
- `typescript` — KEEP;
- `xstate` — ADD;
- `dexie` — ADD;
- `@webext-core/messaging` — ADD;

Testing candidates:

- `vitest` — KEEP;
- WXT Vitest testing plugin / `@webext-core/fake-browser` — ADD/ENABLE;
- `playwright` — ADD as E2E/test dependency, not runtime browser driver.

Research/reference only for now:

- Plasmo;
- Automa;
- UI.Vision RPA;
- Playwriter;
- Cordyceps;
- browser-bridge;
- webext-bridge.

## Implementation priority produced by this research

1. Lock Dexie schema for chats, schedules, workflows, runs, actions, responses and errors.
2. Implement typed extension messaging.
3. Implement `TabRegistry` + `ensureTargetReady` recovery flow.
4. Implement isolated `ChatGPTAdapter` with semantic locators.
5. Implement idempotent SEND and CAPTURE actions.
6. Implement XState durable run persistence/recovery.
7. Implement alarm reconciliation and missed-run policy.
8. Add fake-browser unit/integration tests.
9. Add Playwright extension E2E tests.
10. Build accessible Side Panel and workflow editor after runtime contracts stabilize.

## Bottom line

The project does not need another generic browser-automation framework. The fastest robust route is to keep WXT and assemble a narrow, durable runtime from proven libraries: XState for orchestration, Dexie for operational persistence, webext-core messaging/testing utilities, native Chrome APIs for tabs/alarms, and a custom ChatGPT adapter. The largest newly identified reliability requirement is recovery from discarded/frozen/stale target tabs when managing many chats simultaneously.