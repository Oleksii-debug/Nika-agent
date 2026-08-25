# Condition-based waits, workflow packs, and execution boundaries

Date: 2026-08-24
Repository: `Oleksii-debug/Nika-agent`

## Executive decision

This research cycle focuses on a failure source that becomes critical once Nika runs many real web workflows: **waiting semantics**.

The core decision is:

> Nika must not model waiting as `sleep(ms)` except as an explicit last-resort/debug primitive. Every production wait should normally be a typed condition with a deadline and evidence.

The recommended execution contract is:

`ACTION -> EXPECTED_STATE -> condition observer -> evidence -> SETTLED / TIMEOUT / STALE_TARGET / BLOCKED`

This applies to ChatGPT and to future generic web automation.

The second decision is that workflow packs/YAML/recorded macros may be useful authoring/import formats, but they must compile through Nika's own policy and durability layer. Imported workflows must never be allowed to bypass ActionPolicy, target identity, mutation serialization, retry classification, or postconditions.

---

## 1. Why waits deserve their own runtime abstraction

The current prototype still has fixed polling/sleep behavior in the browser runtime. This works in a small MVP but scales poorly because web UIs do not expose a single universal notion of readiness.

Possible post-action states include:

- a URL changed;
- a specific element appeared;
- an element disappeared;
- text changed;
- a form validation message appeared;
- a ChatGPT user-message was rendered;
- generation started;
- generation stopped;
- response text stopped mutating for a quiet window;
- a modal appeared;
- a network-backed SPA transition completed while the URL stayed unchanged;
- the current document navigated and every old DOM reference became stale.

A fixed delay cannot distinguish any of these outcomes.

For a 30-100 chat system, fixed sleeps also waste worker lifetime and create accidental synchronization bursts.

---

## 2. Open-source evidence: mature systems converge on condition waits

### 2.1 agent-browser

Vercel's `agent-browser` documentation explicitly warns that agents fail more often because of incorrect waits than incorrect selectors.

Its waiting primitives distinguish:

- wait for element/ref;
- wait for text;
- wait for URL;
- wait for `networkidle`;
- wait for `DOMContentLoaded`;
- wait for an explicit JavaScript condition;
- fixed millisecond wait only as a last resort.

Reference:
https://github.com/vercel-labs/agent-browser/blob/main/skill-data/core/SKILL.md

The lesson for Nika is not to copy the CLI but to make `WaitCondition` a first-class runtime type.

### 2.2 TestCafe

TestCafe (MIT) is a mature automation framework whose reliability model is based on automatic waiting rather than user-authored sleeps. It waits for page loads/XHR and provides smart selectors/assertions that retry until the state is satisfied or the timeout is reached.

Reference:
https://github.com/DevExpress/testcafe

This validates two design rules:

1. timeout is a deadline around a condition, not the actual wait mechanism;
2. assertions/postconditions should be retry-observed until they become true, rather than checked once after an arbitrary delay.

TestCafe itself is not appropriate as an extension runtime dependency: it is a Node/E2E framework and does not solve MV3 persistence, Effect Journal semantics, or browser-extension target ownership.

### 2.3 Taiko

Taiko uses smart selectors plus automatic handling of dynamic/XHR content. It tries to make scripts readable and removes the need for explicit waits in common cases.

Reference:
https://github.com/getgauge/taiko

A reusable idea for Nika is to bind waiting to the semantic operation:

- `click-and-expect-navigation`;
- `fill-and-expect-valid-value`;
- `send-and-expect-new-message`;
- `wait-response-until-stable`.

Again, Taiko is a reference, not a runtime dependency. It assumes a controlled automation process rather than a restartable MV3 service worker controlling existing user sessions.

---

## 3. Proposed WaitCondition model

Recommended conceptual union:

```ts
export type WaitCondition =
  | { type: 'element_present'; target: TargetRecipe }
  | { type: 'element_absent'; target: TargetRecipe }
  | { type: 'text_matches'; target?: TargetRecipe; pattern: string }
  | { type: 'url_matches'; pattern: string }
  | { type: 'document_changed'; previousDocumentId: string }
  | { type: 'chat_generation_started' }
  | { type: 'chat_generation_stopped' }
  | { type: 'assistant_message_newer_than'; messageId: string }
  | { type: 'response_stable'; quietMs: number; minimumMs?: number }
  | { type: 'form_valid' }
  | { type: 'custom_site_state'; capability: string; state: string };
```

Every wait also carries:

```text
deadlineAt
navigationEpoch
tabId/frameId/documentId
AbortSignal or cancellation token
poll/observer strategy
required evidence
```

A successful wait should return evidence, not only `true`.

Example:

```text
WAIT_SETTLED
condition=response_stable
observedMessageId=assistant:123
fingerprint=sha256:...
quietWindowMs=1500
observedAt=...
```

---

## 4. Observer strategy must be condition-specific

Nika should not use one mechanism for all waits.

### DOM conditions

Use `MutationObserver` while the current document is runnable.

Suitable for:

- element present/absent;
- text mutation;
- generation control appeared/disappeared;
- assistant response quiet-window detection.

### Navigation/document conditions

Use `chrome.webNavigation`/tab lifecycle state and document identity.

Suitable for:

- URL/navigation;
- document replacement;
- frame navigation;
- stale-epoch cancellation.

### Durable timeout/wake-up

Use persisted `deadlineAt/notBefore` plus `chrome.alarms`/reconciliation.

The service worker is not required to remain alive for the whole wait.

### Fixed sleep

Keep only as an explicit `debug_delay`/compatibility primitive.

It should never be generated automatically by the workflow compiler when a known semantic condition exists.

---

## 5. Network idle is useful but must not become Nika's universal readiness signal

Several automation tools expose `networkidle`, but this state is unreliable as the only readiness definition for modern applications with:

- WebSockets;
- SSE;
- telemetry;
- background polling;
- streaming model responses;
- SPA state changes that do not require the network to become quiet.

For ChatGPT specifically, `networkidle` does not prove either:

- that SEND was accepted;
- or that the assistant answer is complete.

Therefore Nika's order should be:

1. operation-specific semantic postcondition;
2. site-profile state probe;
3. document/URL state where relevant;
4. network state only as supporting evidence;
5. fixed delay only as fallback/debugging.

---

## 6. A new open-source reference: SideButton

`sidebutton/sidebutton` is a recent browser-automation stack combining:

- Chrome extension;
- real DOM control;
- local server over WebSocket;
- YAML workflow engine;
- MCP and REST surfaces;
- workflow recording;
- knowledge packs containing selectors, data models, state machines, procedures and edge cases;
- run logs and dashboard.

Reference:
https://github.com/sidebutton/sidebutton

The engine/server/dashboard are Apache-2.0, while the browser extension currently uses FSL-1.1-Apache-2.0 and converts later, so extension code should not be treated as immediately permissive source material.

### What is useful for Nika

SideButton independently validates a clean separation between:

```text
browser-control extension
workflow model/parser
server/control plane
knowledge packs
run logs
external MCP/REST interfaces
```

This is very close to the modular direction already selected for Nika.

Its knowledge packs are especially relevant to Nika's existing SiteProfile/SiteSkill split.

### What should not be copied directly

SideButton workflows include generic operations such as arbitrary `injectJS` and broad `control.retry`. Those are acceptable in its own product model, but Nika should retain stricter execution boundaries:

- imported workflow cannot introduce arbitrary executable JS;
- `retry` must respect `RetryClass`;
- WRITE cannot blindly retry;
- SEND/submit must have postcondition evidence;
- browser target identity must remain bound to document/navigation epoch;
- live workflow execution must still be checkpointed durably.

Therefore SideButton is a strong authoring/control-plane reference, not a replacement for Nika's runtime.

---

## 7. Workflow packs should compile, not execute directly

Nika will likely benefit from portable workflow formats:

- native `WorkflowDocumentV1`;
- Chrome Recorder import;
- recorded "Teach Nika" flows;
- possibly YAML for advanced users/server integration;
- SiteSkill/knowledge packs.

But all formats should pass through one boundary:

```text
External/Authoring Workflow
        ↓
Schema validation
        ↓
WorkflowCompiler
        ↓
Capability lookup
        ↓
ActionPolicy + RetryClass
        ↓
TargetRecipe + Wait/Postcondition
        ↓
ExecutionPlan
        ↓
Durable Jobs / Effects
```

This lets Nika support convenient RPA-grade authoring without accepting RPA-grade unsafe execution semantics.

---

## 8. Wait conditions should be generated by capabilities

A useful compiler rule is that a browser capability owns its default settle condition.

Examples:

### `SEND_MESSAGE`

Preconditions:

- correct conversation;
- composer writable;
- not already generating unless policy permits;
- no protected manual draft.

Action:

- set exact prompt;
- verify composer value;
- dispatch.

Default settle condition:

`new user message with expected fingerprint appears`.

Then workflow separately enters:

`WAIT_FOR_RESPONSE`.

### `GENERIC_CLICK`

SiteProfile/compiler must supply one of:

- expected URL;
- expected target appearance/disappearance;
- expected state change;
- explicit `NO_POSTCONDITION` only for READ-like/non-critical operations.

### `FILL_FIELD`

Default settle condition:

- current field value equals normalized requested value;
- validation state is not rejected.

This keeps authored workflows shorter while runtime evidence remains strict.

---

## 9. Durable waiting model

A wait must be restartable.

Recommended stored checkpoint:

```text
runId
stepId
condition
startedAt
deadlineAt
target identity
navigationEpoch
lastObservedFingerprint
lastObservationAt
status = WAITING
```

When the service worker starts:

1. query all `WAITING` checkpoints;
2. discard/mark stale bindings whose document epoch is obsolete;
3. inspect current page state;
4. if condition is already true, settle immediately;
5. if deadline expired, produce typed timeout;
6. otherwise re-arm observer/wake-up.

This is more reliable than trying to keep the service worker alive until the response finishes.

---

## 10. Recommended wait outcomes

Avoid generic `Error('timeout')`.

Recommended outcomes:

```text
SETTLED
TIMED_OUT
TARGET_STALE_EPOCH
TARGET_MISSING
TARGET_AMBIGUOUS
DOCUMENT_REPLACED
TAB_UNAVAILABLE
PERMISSION_REVOKED
SITE_BLOCKED
USER_INTERVENTION_REQUIRED
CANCELLED
```

This improves recovery decisions because a stale document requires re-resolution, whereas an actual timeout may require circuit-breaker/backoff behavior.

---

## 11. Comparison summary

| Project | Strongest reusable idea | Use in Nika |
|---|---|---|
| agent-browser | explicit condition-specific waits; avoid blind sleeps | adopt pattern |
| TestCafe | automatic waiting + retrying assertions | adopt semantics; test reference only |
| Taiko | smart semantic selectors tied to automatic waits | adopt operation-level pattern |
| SideButton | split workflow engine / extension / knowledge packs / control plane | architecture and authoring reference |
| Weft | browser durable execution/checkpoints | continue spike/reference only |
| XState + Dexie | explicit state machine + authoritative browser persistence | keep baseline |

No new baseline dependency is required by this cycle.

---

## 12. Recommended new modules

```text
WaitCondition
WaitPolicy
WaitEvidence
ConditionObserver
DomConditionObserver
NavigationConditionObserver
ResponseStabilityObserver
DurableWaitRepository
WaitReconciler
WorkflowCompiler wait inference
```

These should remain small internal modules rather than another general-purpose automation framework.

---

## 13. Implementation priority

1. Replace `waitUntilIdle()`'s service-worker polling loop with a typed wait contract.
2. Define `WaitConditionV1` and `WaitResultV1` runtime schemas.
3. Add `deadlineAt`, document/navigation identity and cancellation to every wait.
4. Implement `ResponseStabilityObserver` in the content script using `MutationObserver`.
5. Persist `WAITING` workflow checkpoints in Dexie.
6. Implement restart reconciliation: condition may already be true after worker resurrection.
7. Add fixture tests for DOM appear/disappear, SPA navigation, stale document, frozen/discarded tab and quiet-window response completion.
8. Change `WorkflowCompiler` so known capabilities automatically emit their semantic settle condition.
9. Reject imported generic WRITE steps that have neither an explicit postcondition nor a capability-provided default.
10. Keep arbitrary `sleep(ms)` as an explicit advanced/debug primitive only.

---

## Final architecture decision

The execution pipeline should now be understood as:

```text
Workflow intent
  -> compile capability
  -> resolve live target
  -> preconditions
  -> dispatch action
  -> typed semantic wait/postcondition
  -> evidence
  -> durable checkpoint
  -> next step
```

The most important invariant from this cycle is:

> **Time passing is not evidence that a web action succeeded. Nika advances only when the expected observable state is proven, or when the wait terminates with a typed failure.**
