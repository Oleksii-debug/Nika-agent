# Navigation epochs, runtime schemas, and locator contracts

Date: 2026-08-24
Repository: `Oleksii-debug/Nika-agent`

## Executive decision

The next reliability layer should combine three ideas:

1. **Navigation/document epochs** for every ChatGPT target so stale DOM refs cannot survive SPA transitions or reloads.
2. **Runtime schema validation** at every extension boundary so malformed messages, persisted rows and future server commands fail closed instead of corrupting runtime state.
3. **Locator recipes, not stored DOM nodes**, following the same principle as Playwright locators: re-resolve the current DOM immediately before each action, then verify the postcondition.

The recommended near-term design is:

`navigation event -> increment/rebind target epoch -> invalidate semantic refs -> fresh semantic snapshot -> resolve LocatorRecipe -> actionability check -> action -> OutcomeContract verification`

and for protocol data:

`unknown input -> runtime schema parse -> typed command/result -> runtime`

No new large browser automation framework is needed.

---

## 1. Current repository observations

The repository is still intentionally minimal at dependency level: WXT, TypeScript and Vitest only. This is good because we can add only dependencies that clearly reduce custom infrastructure.

Current permissions include `alarms`, `storage`, `tabs`, `scripting`, `clipboardWrite` and host access only to `https://chatgpt.com/*`. This remains a reasonable least-privilege baseline.

The current content script is an isolated-world WXT content script and works directly against the shared DOM. That is the right default. Main-world execution should remain an escalation mechanism only when a site operation truly requires access to page-owned JavaScript objects.

---

## 2. Navigation epoch: tabId is not enough

ChatGPT is a SPA. The same tab may move from project page to conversation A, conversation B, history state changes, login flows, reloads and internal route transitions without receiving a new `tabId`.

Therefore a durable binding like:

`chatId -> tabId`

is incomplete.

Use:

```text
ChatTargetBinding {
  chatId
  canonicalConversationUrl
  tabId
  windowId
  documentId?
  navigationEpoch
  observedUrl
  lastValidatedAt
}
```

Every meaningful navigation increments or replaces the epoch.

A SemanticSnapshot must record:

```text
snapshotId
chatId
tabId
documentId?
navigationEpoch
url
pageFingerprint
```

A `SemanticRef` is valid only when all relevant scope keys still match.

### Invalidation events

Invalidate refs on at least:

- `chrome.webNavigation.onHistoryStateUpdated` for top-frame SPA history updates;
- `chrome.webNavigation.onCommitted` for real navigation;
- relevant `chrome.tabs.onUpdated` URL/status changes;
- WXT content-script location/context invalidation;
- explicit reload/recovery;
- conversation identity mismatch detected by SiteProfile.

Chrome exposes a `documentId` on modern `webNavigation` events. Use it when available as an additional strong identity for the loaded document.

### Why this matters

A ref such as `e17` or a captured HTMLElement must never be considered stable across navigation. If DEV03 was open, then the same tab navigated to DEV04, a stale ref must not be allowed to click a button in DEV04 under DEV03 authority.

---

## 3. LocatorRecipe instead of persistent element handles

Playwright's strongest locator pattern is that the locator is a **query recipe**. The concrete element is resolved against the current DOM every time an action executes.

Nika should implement the same conceptual model without depending on Playwright in production.

Recommended structure:

```text
LocatorRecipe {
  id
  semanticRole?
  accessibleName?
  label?
  placeholder?
  testId?
  structuralScope?
  textFallback?
  cssFallbacks[]
  expectedCount
}
```

Resolution order:

1. semantic role + accessible name;
2. associated label/placeholder;
3. stable explicit contract such as `data-testid`;
4. scoped structural query;
5. CSS fallback;
6. text fallback only when semantically appropriate.

Do not persist a raw DOM node or a long-lived element reference in workflow state.

### Strict uniqueness

Playwright's locator strictness is a useful model: mutating actions should fail if a locator resolves to multiple plausible elements.

Nika should not silently choose `.first()` or `.last()` for important mutating actions unless the SiteProfile explicitly defines that ordering as part of the contract.

Suggested outcomes:

- `TARGET_UNIQUE`
- `TARGET_MISSING`
- `TARGET_AMBIGUOUS`
- `TARGET_NOT_ACTIONABLE`
- `TARGET_STALE_EPOCH`

This should feed `ActionResult`, not throw unstructured exceptions.

---

## 4. Actionability checks should be explicit

Playwright auto-waits for conditions such as unique match, visibility, stability, receiving events and enabled/editable state before interaction.

Nika does not need to reproduce the entire Playwright actionability implementation, but it should have a compact deterministic subset before mutating ChatGPT:

### SEND button

- exactly one semantic target;
- visible;
- not disabled;
- belongs to current navigation epoch;
- correct conversation identity;
- composer contents belong to current workflow;
- not blocked by modal/login/rate-limit state.

### Composer

- unique target;
- visible/editable;
- current epoch;
- no user-owned unsent text;
- after write, re-read value and compare normalized prompt before Send.

Actionability and postconditions are different phases. Passing actionability only means the action is safe to attempt; it does not prove the side effect succeeded.

---

## 5. Main world vs isolated world

WXT documents two important execution models:

### ISOLATED world

Default and preferred.

Benefits:

- extension JavaScript is isolated from page JavaScript;
- extension APIs remain accessible through the content script environment;
- DOM is still shared, which is enough for our current ChatGPT adapter.

Use for:

- semantic snapshots;
- composer interaction;
- button interaction;
- response capture;
- DOM observers.

### MAIN world

Use only if a site feature cannot be implemented reliably through shared DOM and native events.

WXT recommends keeping a parent isolated content script and, when required, injecting an unlisted main-world script so communication and extension APIs remain under extension control.

Decision: **do not move ChatGPTAdapter to MAIN world now**.

If later React/Lexical internals make a specific operation impossible through DOM, add a narrow `PageBridge` with a typed message contract instead of moving the whole adapter into page context.

---

## 6. Content-script lifecycle must be part of recovery

WXT exposes a content-script context that can be invalidated when an extension is updated, disabled or otherwise loses its execution context.

Long-running observers/listeners should therefore use WXT context-aware helpers or explicitly stop when the context is invalid.

For Nika this means:

```text
content script starts
-> register SiteProfile observer
-> emit heartbeat {tabId, navigationEpoch, adapterVersion}
-> context invalidated
-> stop observers/listeners
-> runtime marks content channel unavailable
-> next acquireTarget performs re-injection/recovery
```

Do not treat a silent observer as proof that ChatGPT is idle.

---

## 7. Runtime schema validation is now justified

TypeScript types disappear at runtime. Nika will increasingly receive unknown values from:

- `chrome.runtime` messages;
- content-script responses;
- IndexedDB rows after migrations;
- imported workflow JSON;
- Recorder/UserFlow imports;
- future LocalBridge/Nika Server commands;
- user-edited configuration.

A malformed object crossing these boundaries must not become trusted runtime state merely because it was cast with `as ContentCommand`.

Introduce schemas for at least:

```text
BrowserCommand
ActionResult
SemanticSnapshot
ChatTargetBinding
Job
EffectJournalEntry
WorkflowDefinition
ScheduleDefinition
RecordedFlow import
```

The rule should be:

`external/persisted unknown -> parse -> trusted typed object`.

Internal hot-path objects that are created only by trusted typed code do not need constant reparsing.

---

## 8. Zod vs Valibot vs TypeBox

### Zod 4

Strengths:

- mature and widely understood;
- zero external dependencies;
- excellent TypeScript inference;
- stable Zod 4 release;
- very good developer ergonomics;
- browser compatible.

Weakness:

- generally larger client bundle than highly modular alternatives.

Use if developer simplicity and ecosystem familiarity dominate.

### Valibot

Strengths:

- MIT;
- modular/tree-shakeable API;
- TypeScript inference;
- very small client-side bundle for limited schema sets;
- designed specifically with client bundle size in mind.

Weakness:

- ecosystem smaller than Zod.

For a Chrome Extension, **Valibot is the current preferred candidate** because Nika needs a relatively small number of schemas and bundle size matters more than server-side ecosystem breadth.

### TypeBox

Strengths:

- MIT;
- generates standards-oriented JSON Schema while also inferring TypeScript types;
- especially useful if the same protocol must be shared later with Nika Server or a local relay;
- schemas can be exported/consumed by other languages/tools.

Caveat:

- current latest 1.x is developed around newer TypeScript generations, while 0.x remains LTS for TypeScript 5.x/6.x compatibility. Nika currently uses TypeScript 5.9, so adopting TypeBox requires selecting the compatible line deliberately.

### Decision

Short term:

**Spike Valibot first** for extension-local runtime validation.

Before committing, compare bundle output against Zod 4 for Nika's actual command/result schemas.

If the Nika Server / LocalBridge protocol becomes an external public protocol requiring JSON Schema generation, revisit TypeBox for that boundary rather than forcing the entire extension to use it.

---

## 9. Version every cross-context protocol

Commands/results should carry a protocol version.

Example:

```text
{
  protocolVersion: 1,
  commandId: "...",
  type: "chat.send",
  target: {...},
  payload: {...}
}
```

Content script response:

```text
{
  protocolVersion: 1,
  commandId: "...",
  ok: true,
  outcome: "OBSERVED_COMMITTED",
  evidence: {...}
}
```

On mismatch:

`PROTOCOL_VERSION_UNSUPPORTED`

Do not attempt best-effort mutation with an unknown protocol version.

This matters after extension updates when a background worker and an already-running/invalidated content context can temporarily disagree about code generation.

---

## 10. Adapter version and capability handshake

Add a cheap handshake:

```text
runtime.health -> {
  protocolVersion
  adapterVersion
  siteProfileVersion
  navigationEpoch
  conversationIdentity
  capabilities: [READ, WRITE, OBSERVE]
  state
}
```

Before a large batch:

1. bind one canary tab;
2. perform health handshake;
3. require expected protocol/site-profile version;
4. perform non-mutating semantic snapshot;
5. optionally execute one canary SEND;
6. only then release the larger dispatch queue.

This prevents a stale content script from receiving a new command shape after extension update.

---

## 11. Playwright should become the semantic test oracle

Production Nika should not depend on Playwright.

But Playwright should be used in E2E tests as an independent semantic oracle because it provides:

- `getByRole` / accessible-name resolution;
- strict locator semantics;
- auto-wait/actionability;
- ARIA snapshots.

A useful adapter compatibility test is:

```text
Nika SemanticSnapshot says:
  composer = textbox X
  send = button Y

Playwright fixture/live canary says:
  getByRole('textbox', ...)
  getByRole('button', ...)

assert both identify equivalent semantic controls.
```

This reduces the risk that our custom `dom-accessibility-api` interpretation silently diverges from a mature automation engine.

---

## 12. Navigation-aware WAIT semantics

If a workflow is waiting for a response and a navigation epoch changes, do not continue waiting on the old semantic state.

Persist:

```text
WAITING_FOR_RESPONSE {
  chatId
  expectedAfterMessageId
  startedAt
  timeoutAt
  originatingNavigationEpoch
}
```

On recovery:

1. acquire current target;
2. get fresh conversation identity;
3. obtain fresh snapshot;
4. if the intended conversation is still present, reconcile latest user/assistant identities;
5. if conversation changed, return `TARGET_MOVED`/`RECOVERY_REQUIRED` instead of assuming idle.

---

## 13. Suggested implementation slices

### Slice A: schema boundary

- choose Valibot for spike;
- define `BrowserCommandV1` and `ActionResultV1`;
- replace unsafe casts in messaging paths with parse/safe-parse;
- add invalid-message tests.

### Slice B: navigation epoch

- add `ChatTargetBinding.navigationEpoch`;
- listen to top-frame SPA/history navigation;
- integrate WXT location/context lifecycle;
- invalidate snapshot refs on epoch change.

### Slice C: locator contract

- define `LocatorRecipe` and `LocatorResolution`;
- implement semantic-first resolver;
- require uniqueness for mutating actions;
- add stale-epoch rejection.

### Slice D: health handshake

- add protocol/site-profile version;
- add `runtime.health`;
- use it for canary gate before large batches.

### Slice E: E2E oracle

- controlled ChatGPT-like fixture;
- Playwright `getByRole` comparison;
- SPA navigation without full reload;
- extension update/content-context invalidation simulation;
- stale ref must be rejected.

---

## 14. Acceptance tests that should become mandatory

1. Resolve Send in DEV01, navigate same tab to DEV02, try old ref -> `TARGET_STALE_EPOCH`, no click.
2. Same tab, SPA history update -> navigation epoch changes and snapshot is invalidated.
3. Duplicate matching Send controls -> `TARGET_AMBIGUOUS`, no mutation.
4. Hidden/disabled control -> `TARGET_NOT_ACTIONABLE`, no mutation.
5. Unknown runtime message shape -> schema rejection, no side effect.
6. Newer protocol version -> fail closed.
7. Content script from old extension generation -> handshake mismatch -> reinject/recover before mutation.
8. Content context invalidated while observing -> no false `IDLE` success.
9. Fixture replaces button DOM node between snapshot and action -> LocatorRecipe re-resolves current node and succeeds only if semantic identity remains unique.
10. Navigation occurs between PREPARE and SEND -> SEND aborts and effect remains non-committed/ambiguous according to observed boundary.

---

## 15. Dependency decision after this cycle

### Strong candidate to add now

- `valibot` — after a small bundle/ergonomics spike.

### Already recommended

- Dexie
- XState
- p-queue
- `@webext-core/messaging`
- `dom-accessibility-api`

### Test-only

- Playwright
- axe integration previously selected

### Reference / possible future protocol layer

- TypeBox when JSON Schema becomes valuable for LocalBridge/Nika Server interoperability.

### Do not add

- a second generic browser automation runtime;
- a selector wrapper that persists concrete nodes;
- MAIN-world ChatGPT execution by default;
- a custom schema-validation framework.

---

## Final recommendation

Nika's next browser reliability milestone should be:

`typed protocol + navigation-scoped semantic identity + live locator re-resolution`.

That combination closes three major classes of failures at once:

- stale content/messages after extension evolution;
- wrong-chat/wrong-page mutation after SPA navigation;
- stale DOM element references after React/ChatGPT re-rendering.

The resulting invariant should be simple:

> No mutating browser command executes unless its protocol is valid, its target binding belongs to the current navigation epoch, its semantic locator resolves uniquely against the live DOM, and its postcondition is independently verified.
