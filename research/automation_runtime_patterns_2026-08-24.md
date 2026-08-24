# Nika-agent research: automation runtime patterns and reuse decisions

Date: 2026-08-24

## Objective

This pass focuses on concrete reusable engineering patterns for Nika-agent rather than broad tool discovery. The target remains a local Chrome Manifest V3 extension that orchestrates many authenticated ChatGPT web chats without using the ChatGPT API.

## High-value open-source references

### WebGenie
Repository: https://github.com/derpx06/webgenie

Useful pattern: translate the page DOM into a compact interactive tree, then execute actions against stable references rather than distributing CSS selectors throughout the codebase.

Recommendation for Nika-agent:
- adopt the compact semantic-tree idea;
- keep the ChatGPT-specific layer in `ChatGPTAdapter`;
- expose only the controls and messages needed for orchestration;
- avoid feeding full HTML into the workflow layer.

### Cereon Browser Operator
Repository: https://github.com/cereon-labs/cereon-browser-operator

MIT-licensed MV3 browser-control layer over CDP. It provides a very small command/result protocol and separates browser control from the planning layer.

Recommendation:
- use as a reference for a future optional `DebuggerTransport`;
- do not make CDP/debugger permission mandatory in the first production path;
- preserve `BrowserTransport` as an interface so a debugger/native transport can be added later without rewriting workflow logic.

### browser-agent by zxcHolmes
Repository: https://github.com/zxcHolmes/browser-agent

Directly relevant because it includes recurring scheduled tasks implemented with `chrome.alarms`, enable/disable controls, immediate run, history, and normal-Chrome operation.

Recommendation:
- study its scheduler and task persistence model;
- do not use one Chrome alarm per every conceptual workflow occurrence;
- Nika-agent should use a durable database as source of truth and one/few wake-up alarms that scan due jobs.

### Full Self Browsing (FSB)
Repository: https://github.com/fullselfbrowsing/FSB

Strong DOM-first design: captures structural page data, ARIA labels and forms; executes actions; then verifies post-action state and detects stuck action repetition.

Recommendation:
- copy the engineering principle, not necessarily code;
- all Nika-agent mutating actions must have explicit postconditions;
- store evidence for success/failure, not merely boolean `success`.

### webbrain
Repository: https://github.com/webbrain-one/webbrain

Important pattern: accessibility-tree-first targeting, saved reusable workflows, scheduled tasks, per-tab conversations, site adapters, and guarded actions.

Recommendation:
- treat accessibility names/roles as first-class locator data;
- implement a site-adapter boundary, beginning with ChatGPT;
- keep workflow format serializable/exportable from day one.

### auto-web-agent
Repository: https://github.com/huturen/auto-web-agent

Especially useful for deterministic loop/stall handling. It fingerprints state/action pairs and detects repeated ineffective actions and oscillation.

Recommendation:
Introduce `ProgressGuard` with:
- state fingerprint;
- action fingerprint;
- repeated-state counter;
- repeated-action counter;
- A-B-A-B oscillation detector;
- consecutive failure budget;
- terminal `NEEDS_USER` instead of infinite retry.

### Browser Agent by uiuing
Repository: https://github.com/uiuing/browser-agent

Strong engineering boundaries: typed tool registry, schema validation, risk tiers, post-action verification, evidence and reusable skills.

Recommendation:
- Nika actions should be typed definitions rather than free-form functions;
- each action declares input schema, mutability, retry policy and verification rule;
- later this enables UI generation and better logs without changing action implementations.

### Browser Agent Recorder
Repository: https://github.com/VelvetAbyss/browser-agent-recorder

MIT, MV3, TypeScript, Dexie, Vitest. Particularly useful structure: recorder, selector engine, local DB, typed protocol and exporters.

Recommendation:
- study `selector.ts`, `db.ts` and shared message types;
- a future Nika recorder could let the user demonstrate a workflow and convert it into steps;
- this is optional after core orchestration is stable, not a blocker for first final release.

### Hermes Chrome
Repository: https://github.com/leaf76/hermes-chrome

MIT companion + extension architecture built specifically to drive daily Chrome without hijacking the user's active tab.

Recommendation:
- valuable reference for a future native helper and background-tab isolation;
- Nika core should remain extension-first;
- add a native helper only if Chrome APIs/content scripts cannot satisfy a concrete requirement.

### Sidebutton
Repository: https://github.com/sidebutton/sidebutton

Interesting workflow vocabulary: browser actions, control flow (`if`, `foreach`, `retry`, `stop`), extraction and logs. Licensing is mixed, so code reuse requires care.

Recommendation:
- reuse the conceptual workflow vocabulary;
- do not import its extension code without explicit license review.

## Chrome platform findings that affect architecture

### `chrome.alarms` is only a wake-up primitive

Current Chrome documentation confirms:
- alarms do not wake a sleeping device;
- missed repeating alarms fire at most once after wake and are then rescheduled;
- Chrome may delay alarms;
- there is a 30-second minimum effective cadence for packed extensions;
- Chrome 150+ adds `persistAcrossSessions`, but important alarms should still be reconciled when the service worker starts.

Therefore Nika-agent must not treat alarms as authoritative schedule state.

Required architecture:

`Dexie schedules -> reconcile -> wake alarm -> scan due jobs -> acquire per-chat lock -> resume workflow`

A single scheduler wake alarm or a small bounded set is preferable to creating hundreds of independent Chrome alarms. This also leaves headroom below Chrome's alarm limits.

### Side Panel remains the correct operational UI

Chrome's Side Panel is designed to remain available while the user navigates between tabs. This supports the Nika use case better than a popup.

Recommended UI split:
- Side Panel: runtime status, run/pause/stop/run-now, current jobs, errors.
- Full extension page: projects, chats, workflows, schedules, templates, logs, settings.

### Isolated-world content scripts are the default safety boundary

Keep DOM inspection and normal interaction in an isolated content-script world. Use MAIN-world injection only when a concrete ChatGPT behavior cannot be observed or controlled otherwise. This reduces coupling to page JavaScript and lowers accidental interference.

## Recommended execution contract

Every workflow action should return a structured result:

```ts
interface ActionResult<T = unknown> {
  ok: boolean;
  code: string;
  data?: T;
  evidence?: Evidence[];
  retryable: boolean;
  stateBefore?: string;
  stateAfter?: string;
  timestamp: number;
}
```

This should be used by `SEND_MESSAGE`, `WAIT_FOR_IDLE`, `CAPTURE_RESPONSE`, `FORWARD_RESPONSE`, `OPEN_CHAT`, `RELOAD_TARGET`, and future actions.

## ChatGPT adapter rules

Locator priority:
1. semantic role + accessible name;
2. stable attributes;
3. structural relationship;
4. localized visible text only as fallback;
5. brittle CSS class names never as the primary contract.

For assistant responses, direct DOM extraction is primary. Clicking ChatGPT's Copy button remains only a fallback/manual parity path.

For generation state, do not depend on one text label. Combine multiple signals:
- presence/state of stop control;
- composer/send control state;
- assistant-message mutation activity;
- quiet/stability window after last mutation.

## MutationObserver + stability window

Polling alone is wasteful and can miss transitions. Recommended `WAIT_FOR_IDLE` implementation:
- observe the active assistant response subtree with `MutationObserver`;
- refresh generation-state signals after mutations;
- after generating indicators disappear, require a configurable quiet window (for example 800-1500 ms);
- only then mark the response stable;
- enforce a hard timeout and a retry/recovery path.

This makes forwarding less likely to capture a partial response.

## Per-chat concurrency model

Use an exclusive mutation lock keyed by logical `chatId`.

Allowed:
- DEV01 and DEV02 execute concurrently.

Not allowed:
- two workflows type/send simultaneously in DEV01.

Read-only capture may run concurrently only if it cannot race with an active mutation; simplest first implementation is one lease per chat for all critical operations.

Lease fields:
- ownerRunId;
- acquiredAt;
- expiresAt;
- heartbeatAt;
- fencingToken.

A fencing token prevents an old resumed workflow from continuing after its lease has already been replaced.

## Idempotency model

Persist an operation ledger before/after irreversible mutations.

Suggested key:

`<workflowRunId>:<stepId>:<chatId>:<logicalAttempt>`

For sending, save:
- message hash;
- target chat;
- pre-send latest user-message fingerprint;
- expected postcondition;
- resulting user-message fingerprint when observed.

On service-worker restart, reconcile the page before re-sending. If the expected user message already exists, advance the workflow instead of duplicating it.

## ProgressGuard / loop protection

Every execution run should maintain:
- last N page-state fingerprints;
- last N action fingerprints;
- no-progress count;
- consecutive failure count;
- recovery count.

Escalation:
1. retry primary semantic locator;
2. rebuild semantic snapshot;
3. use alternate locator strategy;
4. re-resolve/reload target tab if policy permits;
5. stop as `NEEDS_USER` with evidence.

No unbounded retry loops.

## Workflow vocabulary for Nika-agent

Core deterministic steps:
- `OPEN_CHAT`
- `ENSURE_TARGET_READY`
- `SEND_MESSAGE`
- `WAIT_FOR_GENERATION_START`
- `WAIT_FOR_IDLE`
- `CAPTURE_RESPONSE`
- `FORWARD_RESPONSE`
- `WAIT_DURATION`
- `IF`
- `RETRY`
- `LOOP`
- `PAUSE`
- `STOP`
- `LOG`

Do not add LLM planning inside the runtime. The web ChatGPT chats themselves are the intelligence being orchestrated; the extension should remain deterministic and auditable.

## New recommended module boundaries

```text
src/
  domain/
    projects/
    chats/
    workflows/
    schedules/
  runtime/
    scheduler/
    workflow/
    locks/
    idempotency/
    progress-guard/
    recovery/
  browser/
    transport/
    tab-registry/
    dom-driver/
    semantic-snapshot/
  sites/
    chatgpt/
      adapter/
      locators/
      validators/
      response-capture/
  storage/
  messaging/
  ui/
```

## Reuse decision matrix

### Adopt as dependency / direct foundation
- WXT: extension framework already selected.
- TypeScript: core language.
- Dexie: IndexedDB persistence.
- XState v5: persisted state-machine/actor workflow runtime.
- @webext-core/messaging: typed extension messaging.
- Vitest: unit/integration tests.
- Playwright: browser-level E2E tests.

### Study and selectively reuse only after license/API review
- WebGenie: semantic DOM tree and action architecture.
- Cereon Browser Operator: protocol and debugger transport patterns.
- Browser Agent Recorder: selector/database/protocol patterns (MIT makes reuse attractive).
- Hermes Chrome: native helper/background-tab isolation patterns (MIT).
- auto-web-agent: loop and progress guards.
- uiuing/browser-agent: typed tools and verification design.

### Reference only / licensing caution
- Sidebutton extension components: mixed licensing.
- Automa and UI.Vision: useful architecture/UX references but license restrictions make direct copying undesirable.

## Concrete implementation priorities from this research pass

1. Define `ActionDefinition` and `ActionResult` contracts.
2. Implement Dexie schema including locks, idempotency ledger and run evidence.
3. Implement `SemanticSnapshot` + locator abstraction.
4. Implement `TabRegistry.ensureTargetReady(chatId)`.
5. Implement `ChatGPTAdapter` and validator-driven SEND/CAPTURE.
6. Implement `WAIT_FOR_IDLE` using MutationObserver plus quiet window.
7. Implement per-chat lease/fencing lock.
8. Implement idempotency reconciliation after service-worker restart.
9. Implement scheduler reconciliation over durable schedules.
10. Add ProgressGuard and bounded recovery.
11. Add NVDA-first Side Panel and full configuration page.
12. Only after the above, evaluate a `chrome.debugger` or native-helper transport behind the same interfaces.

## Bottom line

The fastest route is not to import a giant browser-agent framework. Nika-agent's problem is narrower and more deterministic. Reuse mature infrastructure (WXT, Dexie, XState, typed messaging, Playwright), borrow proven patterns from current browser-agent projects, and keep the custom code concentrated in ChatGPT-specific orchestration, reliable scheduling, idempotency, verification and accessible workflow management.
