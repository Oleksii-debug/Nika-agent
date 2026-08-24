# Nika-agent — site profiles, agent-window isolation and local-bridge decisions

Date: 2026-08-24
Status: research decision note; implementation guidance, not an acceptance claim.

## Scope of this cycle

This cycle intentionally avoids another broad framework search. It compares several recent open-source projects that are close to Nika-agent's actual target: existing authenticated Chrome, deterministic browser actions, workflow orchestration, local bridges, tab isolation, human handoff and reusable site-specific knowledge.

Primary references reviewed:

- SideButton — https://github.com/sidebutton/sidebutton
- Tencent BrowserSkill — https://github.com/Tencent/BrowserSkill
- Tabryn — https://github.com/idugeni/tabryn
- uiuing/browser-agent — https://github.com/uiuing/browser-agent
- Otto — https://github.com/telepat-io/otto

The current Nika-agent code was also re-read, especially `src/runtime.ts` and `src/workflow.ts`.

## Executive decision

Three architectural ideas are strong enough to add to the Nika-agent design now:

1. **Versioned Site Profiles**: ChatGPT-specific DOM/state knowledge should be packaged as a replaceable profile, not remain hard-coded in generic runtime code.
2. **Agent Window + explicit tab borrowing**: routine automation should prefer Nika-owned browser tabs/windows and only take control of a user's existing tab under an explicit policy.
3. **Local Bridge as an optional future transport**: the extension remains sufficient for the MVP, but the protocol should be designed so a local Windows daemon/native-messaging bridge can be added without changing workflow semantics.

No new mandatory runtime dependency is required by this note.

---

## 1. SideButton: the strongest new reference for Site Profiles

SideButton separates a generic workflow engine from installable domain/knowledge packs. Its packs can contain selectors, data models, state machines, role playbooks and common task procedures. Its workflow language has browser, git, issue, LLM and control-flow step families.

This is directly relevant to the long-term Nika-agent goal because ChatGPT is only the first site. A generic runtime should not know that a button means `Stop generating`, or how a ChatGPT response is represented.

### Adopt the pattern, not the whole product

Recommended Nika structure:

```text
sites/
  chatgpt/
    profile.ts
    locators.ts
    states.ts
    actions.ts
    validators.ts
    fingerprints.ts
    fixtures/
    tests/
```

A `SiteProfile` should describe at least:

```text
profileId
siteId
profileVersion
supportedUrlPatterns
stateDetector
semanticLocators
actionDefinitions
postconditionValidators
errorDetectors
healthChecks
lastValidatedAt
```

The workflow engine should call high-level actions such as:

```text
SEND_MESSAGE
WAIT_FOR_STABLE_RESPONSE
CAPTURE_RESPONSE
CONTINUE_GENERATION
```

The site profile maps those actions to current ChatGPT DOM semantics.

### Why this is better than a single ChatGPTAdapter class

A single adapter is a useful first boundary, but a versioned profile gives several additional properties:

- selector/state changes can be versioned independently from the workflow engine;
- compatibility tests can target one profile;
- a broken ChatGPT profile can be globally disabled without disabling the entire extension;
- future sites can reuse the same runtime without adding `if (site === ...)` branches throughout the code;
- a known-good previous profile can be retained for rollback/debugging;
- the profile can expose a machine-readable health result before a large batch is started.

### Licensing note

SideButton's engine/server/CLI/dashboard are Apache-2.0, while its browser extension is under FSL-1.1-Apache-2.0 and converts later. Therefore this note recommends reusing the architecture and data-model ideas, not copying extension code into Nika-agent without a separate license review.

---

## 2. Site compatibility must become a gate, not an error discovered 70 times

With 30–100 ChatGPT chats, a global UI change is different from one broken chat.

Before a large batch, Nika should perform a single profile health probe against a known/selected ChatGPT tab.

Suggested result:

```text
SiteHealthResult
  profileVersion
  siteVersionFingerprint
  composerFound
  sendControlFound
  generationStateRecognizable
  assistantMessageRecognizable
  errorControlsRecognizable
  confidence
  status: HEALTHY | DEGRADED | INCOMPATIBLE
```

Batch policy:

- `HEALTHY` → normal execution;
- `DEGRADED` → only explicitly safe actions or limited canary run;
- `INCOMPATIBLE` → global profile breaker opens; no mass mutation.

This avoids sending 70 failing/repeated actions after one ChatGPT markup change.

A **canary-first batch** is recommended:

```text
health probe
→ run on 1 canary chat
→ verify SEND + stable response postconditions
→ release the remaining queue
```

For a 100-chat workload, this is safer than immediately dispatching all due jobs.

---

## 3. Tencent BrowserSkill: explicit tab borrowing is a strong safety pattern

BrowserSkill uses the user's real logged-in browser but distinguishes ordinary user windows from an Agent Window. If an agent needs an already-open user tab, it explicitly borrows that tab and returns it afterward.

This maps very well to Nika-agent.

### Recommended target ownership modes

Add an explicit ownership policy to each chat:

```text
NIKA_OWNED
BORROWABLE
USER_OWNED
```

#### NIKA_OWNED

The extension created or adopted the tab specifically for automation. It may perform permitted mutations without taking user focus.

#### BORROWABLE

The tab belongs to the user but automation may acquire a temporary write lease when the tab is idle and the composer is not being edited by the user.

#### USER_OWNED

Nika may inspect status if allowed, but must not mutate the tab automatically.

This is clearer than treating every matching ChatGPT URL as equivalent.

### Dedicated Nika Agent Window

For large workloads, the preferred UX should be an optional dedicated Chrome window owned by Nika-agent.

Example:

```text
Window: Nika Agent — NikaCore
  DEV01
  DEV02
  DEV03
  ...
  AUDIT01
```

Benefits:

- user browsing remains separate;
- tab ownership is obvious;
- accidental manual/automation collisions become rarer;
- the extension can restore the window and its chat registry after restart;
- project-level pause can act on one Agent Window;
- logs can reference a stable `agentWindowId`/logical project rather than whichever normal browser window happened to contain the chat.

This does **not** require keeping all tabs active in RAM. Existing frozen/discarded recovery rules still apply.

---

## 4. Current `ensureAgentTab()` should evolve into target acquisition, not URL equality

The current `src/runtime.ts` finds a tab by exact URL equality and otherwise creates a new inactive tab. That is acceptable for the MVP but insufficient for durable multi-tab automation.

Problems with exact URL-only acquisition:

- the same conversation may have URL normalization/trailing/query differences;
- an existing tab may be frozen/discarded;
- two tabs can point to the same conversation;
- the tab can exist in a user-owned window where mutation should not be allowed;
- a previous tab ID can become stale;
- a Nika-owned project window should normally be preferred over arbitrary matching tabs.

Replace the conceptual responsibility with:

```text
acquireTarget(chatId, capability)
```

which returns a `TargetLease` containing:

```text
chatId
canonicalUrl
tabId
windowId
ownershipMode
capability: READ | WRITE | RECOVERY
leaseId
fencingToken
validatedAt
```

The selection order should prefer:

1. valid Nika-owned bound target;
2. another valid tab inside the project's Agent Window;
3. borrowable matching tab under policy;
4. create a new Nika-owned background tab.

---

## 5. Human handoff must be a first-class state

BrowserSkill explicitly treats captcha, login and confirmation dialogs as human-only handoff points. Nika-agent should use the same concept rather than representing all such cases as generic failures.

Add terminal/waiting states such as:

```text
NEEDS_LOGIN
NEEDS_CAPTCHA
NEEDS_CONFIRMATION
BLOCKED_BY_USER
NEEDS_SITE_REPAIR
```

These are different from `FAILED`.

A waiting-human job should preserve:

```text
workflowRunId
stepId
chatId
reason
snapshot/fingerprint
resumePolicy
createdAt
```

After the user resolves the condition, `Resume` must re-validate the target and postconditions before continuing. It must not blindly continue with stale semantic refs.

---

## 6. Tabryn: local bridge security is a good future model

Tabryn uses a local MCP server/bridge/native-messaging architecture to expose the existing browser while keeping communication local. Its documented security model includes:

- no credential exposure to agents;
- explicit tab permission boundaries;
- input validation;
- local-only communication.

This is the right conceptual baseline for a future Nika local bridge.

### Decision

Do **not** add a native host to the MVP just because these projects have one.

The current ChatGPT use case can be implemented inside the extension with content scripts and Chrome APIs.

However, define the command protocol so a future transport can be introduced:

```text
BrowserCommand
  commandId
  target
  capability
  action
  arguments
  idempotencyKey
  fencingToken
```

```text
BrowserResult
  commandId
  ok
  code
  data
  evidence
  retryable
  beforeFingerprint
  afterFingerprint
```

Implementations may later be:

```text
ContentScriptTransport   # MVP/default
LocalBridgeTransport     # future Windows/local daemon
DebuggerTransport        # advanced fallback only
```

Workflow code must not know which transport executed the action.

---

## 7. SideButton also exposes a future orchestration lesson: browser + git + LLM are peer actions

SideButton's YAML engine supports browser steps, Git/issue steps, LLM steps, shell steps and control flow under one orchestration model.

That is close to the user's longer-term Nika concept: GitHub state can influence which prompts are sent to which browser chats.

The important design lesson is not to make browser automation the root object. Browser control is one capability among several.

Future shared Nika job families could be:

```text
browser.*
github.*
control.*
planner.*
notification.*
```

For example:

```text
github.read_project_state
→ control.if
→ browser.send_message
→ browser.wait_for_response
→ github.verify_change
```

Nika-agent MVP should **not** implement all of this now. But its workflow/action protocol should not prevent this evolution.

---

## 8. uiuing/browser-agent: side panel as a long-lived foreground runtime is useful, but not as durable truth

A notable design in `uiuing/browser-agent` is that its model/agent loop runs in the Chrome side panel because MV3 service workers may be suspended. This is a useful pattern for long interactive/model-driven runs while the side panel is open.

For Nika-agent:

- durable schedule/workflow truth still belongs in persistent storage;
- service worker + alarms still owns wake/reconciliation;
- the side panel may optionally host long interactive planner/model work while it is open;
- closing the side panel must never destroy workflow truth or cause duplicate effects.

Therefore the side panel can be an **execution accelerator**, not the source of truth.

This distinction matters if Nika later adds an API brain.

---

## 9. Workflow language: keep typed internal form; export/import can become YAML later

SideButton demonstrates that YAML is practical for user-editable reusable workflows. Nika can eventually support a textual export/import format, which is also useful for NVDA and version control.

But the internal MVP should keep typed TypeScript structures and a validated schema.

Recommended progression:

```text
Phase 1: typed TS + accessible form editor
Phase 2: JSON export/import
Phase 3: optional YAML text editor/import/export
```

Do not make the runtime parse arbitrary YAML as the first implementation milestone.

For accessibility, a text representation can later complement the structured NVDA-friendly editor without requiring drag-and-drop.

---

## 10. Current workflow implementation: specific consequences

`src/workflow.ts` currently runs a simple sequential `for` loop and keeps captured values in an in-memory `Map`. This is acceptable for prototype behavior but the following properties are not durable across MV3 suspension/restart:

- current step;
- interpolated/captured context;
- completed step identities;
- SEND dedupe evidence;
- pending waits/delays.

The new Site Profile/Agent Window work should not distract from the already-planned durable workflow migration.

Recommended order remains:

1. durable run/checkpoint model;
2. action/result contracts;
3. target acquisition and ownership;
4. site profile boundary;
5. validated SEND and stable response capture;
6. scheduler/dispatcher;
7. accessible management UI.

---

## 11. Recommended new domain types

The following domain concepts are now justified by multiple independent implementations:

```text
SiteProfile
SiteHealthResult
ChatTargetBinding
TargetOwnershipMode
TargetLease
AgentWindow
HumanHandoff
BrowserCommand
BrowserResult
```

They should remain framework-neutral. Chrome tab objects, DOM Elements, MCP types, WebSocket objects and SideButton/BrowserSkill types must not leak into domain contracts.

---

## 12. What to reuse vs what to only study

### Strong pattern/reference reuse

**Tencent BrowserSkill (MIT)**
- Agent Window separation;
- explicit borrow/return semantics;
- human takeover states;
- existing-login browser model.

**Tabryn (MIT)**
- local-only bridge boundary;
- no-credential-exposure principle;
- per-tab permission boundaries;
- protocol validation.

**uiuing/browser-agent**
- live-DOM post-action verification;
- side-panel long-running interactive execution;
- reusable verified skills concept.

### Potential code-level study with license care

**SideButton**
- Apache-2.0 core/server/CLI architecture is attractive;
- workflow taxonomy and knowledge-pack concept are highly relevant;
- browser extension has different FSL licensing, so do not copy it into Nika-agent without explicit legal review.

### Not a new baseline dependency

None of the projects above justify replacing WXT, Dexie/XState plan, typed messaging or the existing extension-native approach for the MVP.

---

## 13. New acceptance scenarios implied by this research

Add tests for:

1. Two matching tabs exist: Nika selects the Nika-owned target, not an arbitrary user tab.
2. User-owned tab with non-empty composer: WRITE acquisition is denied/blocked.
3. Borrowable tab: lease acquired, action verified, lease released without focus hijack.
4. Nika Agent Window closed: target is recreated/rebound without duplicating SEND.
5. Site profile health is `INCOMPATIBLE`: batch of 50 chats is not started.
6. Canary SEND fails postcondition: remaining batch stays queued.
7. Human handoff occurs on login/captcha: workflow preserves checkpoint and resumes only after revalidation.
8. Site profile changes: old semantic refs are rejected.
9. Side panel closes during a run: durable workflow state remains correct.
10. Browser service worker restarts after SEND: idempotency evidence prevents a duplicate prompt.

---

## Final recommendation from this cycle

Nika-agent should evolve from a hard-coded ChatGPT batch runner into a small, deterministic browser workflow platform with a **versioned ChatGPT Site Profile** as its first installed profile.

For large workloads, use a dedicated **Nika Agent Window** and explicit ownership/borrowing rules so automation can coexist with normal browser use.

Keep the MVP extension-native. Design the command/result boundary now so a secure local Windows/native-messaging bridge can be added later without rewriting workflows.

Most importantly, a global ChatGPT profile health check plus a one-chat canary should gate every large mutation batch. This converts site-wide UI drift from "70 independent failures" into one controlled compatibility event.
