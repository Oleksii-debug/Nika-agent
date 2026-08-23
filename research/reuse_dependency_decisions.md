# Nika-agent — reusable component and dependency decisions

Date: 2026-08-24

## Executive decision

This research round narrows the implementation strategy from general architecture to concrete reusable components and code-adoption policy.

The fastest safe path is:

1. Keep the production runtime as a Manifest V3 Chrome extension operating on the user's existing logged-in Chrome session.
2. Use proven libraries for durable state/persistence instead of writing equivalents from scratch: XState v5 + Dexie.js.
3. Study and selectively reuse MIT-licensed patterns/code from Playwriter and Cordyceps where they materially reduce development time.
4. Keep Automa and UI.Vision primarily as product/UX/reliability references because their licensing is not suitable for casual copy-paste into a permissively licensed Nika-agent codebase.
5. Treat `chrome.alarms` as a wake-up mechanism only; IndexedDB remains the authoritative scheduler database.

## 1. Reuse matrix

| Candidate | Role | License posture | Recommended action |
|---|---|---|---|
| XState v5 | workflow/state-machine runtime | MIT | ADOPT |
| Dexie.js | IndexedDB abstraction | Apache-2.0 | ADOPT |
| Playwright | automated testing / optional dev bridge | Apache-2.0 | ADOPT FOR TESTING |
| Playwriter | existing-Chrome transport + Playwright bridge patterns | MIT | STUDY + SELECTIVE REUSE |
| Cordyceps | in-extension locator/action abstraction | MIT | STUDY + SELECTIVE REUSE AFTER TESTS |
| Microsoft Playwright Chrome Extension | existing-session control reference | Playwright project licensing | STUDY / TEST TOOL |
| browser-control | extension + local relay reference | verify exact file license before reuse | STUDY |
| browser-agent-bridge | origin validation, permissions, tab isolation | verify exact file license before reuse | STUDY |
| Automa | workflow UX, block model, scheduling ideas | AGPL / commercial mixed | REFERENCE ONLY unless licensing changes |
| UI.Vision RPA | macro/RPA feature and failure-handling reference | AGPL/commercial considerations | REFERENCE ONLY |

## 2. Playwriter — highest-value implementation reference

Repository: https://github.com/remorses/playwriter

Playwriter is especially relevant because its runtime model directly matches the hard part of Nika-agent: controlling a user's already-running Chrome with existing sessions, cookies and extensions.

Observed architecture:

```text
Playwright client / CLI
        |
        v
local WebSocket/CDP relay
        |
        v
Chrome extension
        |
        v
selected existing browser tabs
```

High-value ideas for Nika-agent:

- explicit tab opt-in/attachment;
- local-only relay and origin validation;
- stateful automation sessions;
- compact accessibility snapshots and `aria-ref` locators;
- Playwright API as a developer/testing surface;
- WebSocket reconnect loop;
- protocol backward-compatibility discipline;
- separate relay logs and browser-control logs;
- warning not to close the user's browser/context accidentally.

### Nika-agent decision

Do **not** make a local Node relay mandatory for normal Nika-agent operation yet. The initial target remains pure extension runtime because the required ChatGPT operations are DOM-centric and can be executed from content scripts.

However, design an optional `BrowserTransport` interface from the beginning so a Playwriter-like local relay can be added later without rewriting the workflow engine.

Suggested abstraction:

```text
BrowserTransport
- listTabs()
- resolveTab(chat)
- openTab(url, background=true)
- sendDomCommand(tabId, command)
- snapshot(tabId)
- execute(tabId, action)
- subscribeNavigation(tabId)
```

Initial implementation: `ExtensionNativeTransport`.
Possible future implementation: `LocalRelayTransport`.

## 3. Cordyceps — locator/action layer candidate

Repository: https://github.com/adam-s/cordyceps

Cordyceps demonstrates Playwright/Puppeteer-style client APIs implemented with extension APIs and DOM APIs, with structured accessibility-like snapshots and support across iframes/shadow DOM.

This is close to the abstraction Nika-agent needs around ChatGPT and future websites.

### Decision

Do not take Cordyceps as the whole runtime dependency immediately because it is still a proof-of-concept with a small adoption base.

Instead extract/test these concepts:

- semantic locator facade;
- stable element references from structured snapshots;
- frame/shadow-DOM traversal;
- action result diagnostics;
- no coordinate-based interaction;
- text snapshot rather than screenshot-first automation.

Create an internal Nika API such as:

```text
DomDriver
- snapshot(options)
- findByRole(role, name?)
- findByLabel(label)
- findByStableAttribute(key, value)
- click(ref)
- fill(ref, text)
- readText(ref)
- waitFor(predicate, timeout)
```

ChatGPTAdapter should depend on `DomDriver`, not raw query selectors.

This makes it possible to replace or improve the underlying locator implementation later.

## 4. Automa — what to imitate and what not to copy

Repository: https://github.com/AutomaApp/automa

Automa remains the strongest mature extension-native product reference. It already supports scheduled browser workflows and its manifest confirms a Manifest V3 background service worker architecture.

Useful concepts to reproduce independently:

- explicit workflow definitions rather than hard-coded scripts;
- reusable action blocks;
- separate background and active-tab execution contexts;
- run history;
- workflow import/export;
- templates;
- schedule UI;
- workflow validation before run;
- standalone workflow packaging concept.

Do not directly import source modules from Automa into Nika-agent under the current project licensing assumption. Its repository states mixed AGPL/commercial licensing.

## 5. browser-agent-bridge — security patterns worth adopting

Repository: https://github.com/ypresto/browser-agent-bridge

Useful security concepts:

- browser-validated `event.origin` for page-to-extension requests;
- permissions scoped to requesting origins;
- tab/session isolation;
- service worker as control boundary;
- DOM operations implemented in a dedicated DOM-core layer;
- explicit permission UI instead of globally trusting arbitrary web pages.

### Nika-agent implication

Even though Nika-agent initially controls only user-configured ChatGPT URLs, its internal message protocol should still authenticate command source and target. No content script should be able to execute arbitrary privileged actions just because it can send a runtime message.

Recommended internal envelope:

```text
CommandEnvelope
- protocolVersion
- commandId
- source
- targetTabId
- targetChatId
- action
- payload
- issuedAt
- runId
```

The service worker validates the command against the active run and known chat before dispatch.

## 6. Hypha Navigator — pinned target tab pattern

Hypha Navigator demonstrates a persistent pinned target tab while the user browses elsewhere.

This should become a first-class Nika-agent concept:

```text
ChatBinding
- chatId
- expectedConversationUrl
- lastKnownTabId
- pinned
- automationAllowed
- focusPolicy: NEVER | WHEN_REQUIRED | ALWAYS
```

Default: `focusPolicy = NEVER`.

This is important for the required behavior where Nika-agent continues running while the user switches to Unigram, Word or another Chrome tab.

## 7. Durable workflow runtime: XState + checkpoints

XState v5 supports persisted actor snapshots and restoration. This strongly reduces the amount of custom restart/state-machine code Nika-agent needs.

Recommended state boundary:

```text
WorkflowDefinition  -> user-editable ordered steps / branches
WorkflowRunActor    -> XState actor
RunCheckpoint       -> persisted actor snapshot + Nika metadata
SideEffectLedger    -> message sends/copies/forwards with idempotency keys
```

Important caveat from XState persistence semantics: machine actions that were already executed are not replayed when restoring a persisted snapshot; invoked actors may restart. Nika-agent must therefore keep side effects explicit and idempotent rather than assuming actor restoration alone prevents duplicates.

## 8. Scheduler architecture after current Chrome alarms update

Chrome documentation now exposes a `persistAcrossSessions` alarm option in Chrome 150+, but it is not portable to older Chrome versions or other browsers. Even with this feature, important alarms should still be reconciled when the service worker starts.

Therefore do not change the core design:

```text
Dexie schedules (source of truth)
    -> reconcile on worker start / config change
    -> one or small number of Chrome alarms
    -> due-job scan
    -> create/resume workflow run
```

Never create thousands of independent alarm objects if a single next-due wake-up plus reconciliation can handle the same workload.

Recommended scheduler tables:

```text
Schedule
- scheduleId
- workflowId
- enabled
- triggerType
- nextDueAt
- intervalMs?
- exactLocalTime?
- timezone?
- startAt?
- endAt?
- remainingRuns?
- missedRunPolicy
- retryPolicyId
- updatedAt

ScheduleExecution
- scheduleExecutionId
- scheduleId
- nominalDueAt
- actualStartAt
- status
- workflowRunId?
- dedupeKey
```

## 9. Anti-loop / anti-stall control

The small open-source `auto-web-agent` project contains a useful pattern even though Nika-agent does not need its LLM planner: fingerprint page/action state to detect ineffective repetition, two-state oscillation, and stalls.

Nika-agent should implement a deterministic version for every workflow run:

- hash semantic page state;
- hash attempted action;
- track repeated identical action+state pairs;
- detect A-B-A-B oscillation;
- cap consecutive action failures;
- escalate from retry -> alternate locator -> user-required/failed.

This prevents a broken ChatGPT selector from repeatedly clicking or sending forever.

## 10. ChatGPT adapter design refinement

Separate page-independent browser primitives from ChatGPT-specific semantics.

```text
BrowserTransport
  -> DomDriver
       -> ChatGPTAdapter
            -> WorkflowActions
```

`ChatGPTAdapter` should provide:

```text
identifyConversation()
inspectComposer()
inspectGeneration()
sendMessage(text, idempotencyKey)
getLatestUserMessageIdentity()
getLatestAssistantMessageIdentity()
getLatestAssistantText()
waitForAssistantStable(deadline)
verifyMessageWasSent(idempotencyContext)
```

Do not make pressing the visual "Copy" button mandatory for internal forwarding. Prefer reading the assistant response from the DOM when reliable; use the Copy control as a verification/fallback path. This avoids clipboard permission/focus fragility.

## 11. UI component strategy

Avoid adopting a heavy custom widget library merely for appearance. Accessibility and speed favor native semantic HTML controls.

Recommended primitives:

- `<input>` and `<textarea>` for URLs/prompts;
- native `<select>` initially for role/action/target/missed-run choices;
- `<button>` for add/remove/run/pause/reorder;
- `<table>` only where genuine tabular relationships exist;
- semantic headings/regions;
- `aria-live="polite"` for meaningful run-state changes;
- visible text labels for every critical action.

If a custom combobox becomes necessary, it must match WAI-ARIA combobox keyboard behavior and be tested manually with NVDA before replacing native `<select>`.

## 12. What can be reused immediately

### Direct dependencies

- `xstate`
- `dexie`
- Playwright packages in the test/dev environment

### Source/pattern extraction candidates

- Playwriter connection/session/reconnect ideas
- Playwriter a11y snapshot/ARIA-ref usage
- Cordyceps locator abstraction and frame/shadow traversal ideas
- browser-agent-bridge command validation/tab isolation patterns

### Product/UX reference only

- Automa
- UI.Vision RPA

## 13. New implementation acceptance gates

Before calling the browser-control core usable, require all of these:

1. Background target tab accepts send without becoming foreground.
2. User switches to another Chrome tab and the run continues.
3. User switches to another Windows application and the run continues.
4. Service worker terminates/restarts and SEND is not duplicated.
5. Two simultaneous workflows targeting one chat serialize or fail according to explicit concurrency policy.
6. A stale `tabId` is detected and re-resolved by conversation URL/identity.
7. A locator failure produces diagnostics and bounded retries, not an infinite loop.
8. Response capture does not require clipboard focus.
9. Forwarding the same source response twice is blocked by dedupe ledger.
10. Browser restart causes schedule reconciliation without replay storm.
11. NVDA can configure and run the workflow without drag-and-drop or mouse-only controls.

## 14. Concrete development order from this research

1. Define internal protocol/types (`BrowserTransport`, `DomDriver`, `ChatGPTAdapter`).
2. Add Dexie schema with migrations.
3. Add XState workflow-run machine with persistence hooks.
4. Implement native tab resolver and chat binding.
5. Implement semantic DOM snapshot/locator layer, using Cordyceps/Playwriter patterns as references.
6. Implement ChatGPT send/read/wait primitives.
7. Implement side-effect ledger/idempotency.
8. Implement scheduler reconciliation and missed-run policies.
9. Implement anti-loop/stall detector.
10. Implement response forwarding and multi-chat workflows.
11. Build accessible full-page editor + side-panel operational console.
12. Add Playwright regression suite and forced service-worker-restart tests.

## Final conclusion

The project should not spend time writing its own database wrapper, state-machine framework, or coordinate automation. The highest-value custom work is the Nika-specific layer: chat registry, durable schedule semantics, ChatGPT adapter, idempotent developer/auditor handoffs, and accessible workflow editor.

The existing open-source ecosystem already supplies enough proven primitives to accelerate the implementation substantially while keeping the runtime extension-native and API-free for ChatGPT usage.
