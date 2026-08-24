# Nika-agent — real Chrome control and self-healing workflow research

Date: 2026-08-24

## Executive conclusion

This research round identifies two high-value directions that can materially accelerate Nika-agent without changing the core product goal:

1. **Real-Chrome control via an extension + local/native bridge** is now a proven open-source pattern, including Windows-capable implementations. It should remain an optional future transport, not a mandatory dependency for the first extension-native runtime.
2. **Deterministic workflows with semantic validation and bounded self-healing** are preferable to purely agentic browser control. Nika-agent should keep deterministic workflow definitions as the primary path and use alternate locators/recovery logic only when a step fails.

The strongest new references are:

- `open-browser-use/open-browser-use` — MIT, real logged-in browser, MV3 + native messaging, Playwright-shaped SDK, durable sessions/recovery.
- `leeguooooo/chrome-use` — Apache-2.0, Windows binary available, real Chrome via native messaging + chrome.debugger, per-session tab-group isolation, concurrent agents.
- `derpx06/webgenie` — Apache-2.0, Manifest V3, extension-native DOM accessibility tree, task orchestrator, validator, domain firewall, side-panel architecture.
- `browser-use/workflow-use` — AGPL reference for deterministic workflows + fallback/self-healing; useful design inspiration only.

## 1. open-browser-use: strongest transport/protocol reference

Repository: https://github.com/open-browser-use/open-browser-use

Relevant characteristics:

- MIT license.
- Controls the user's already logged-in browser, preserving sessions/cookies.
- WebExtension backend uses Manifest V3 + native messaging, with no raw remote-debugging port.
- Same SDK can target WebExtension or CDP backend.
- Playwright-shaped semantic locators by role/text/CSS.
- Supports multiple tabs/sessions and resume across long-running turns.
- Uses a capability-gated JSON-RPC protocol with structured errors.
- Explicitly models action effects such as navigation, DOM change, download start, or no visible change.
- Has stale-handle diagnostics and resume/recovery concepts.

### Nika-agent design implications

Do not copy the entire multi-process architecture. Nika-agent's first-class workflow can remain entirely extension-native because ChatGPT-specific operations are simple DOM interactions.

However, its protocol design is worth copying independently:

```text
ActionRequest
- protocolVersion
- commandId
- runId
- chatId
- tabId?
- action
- payload
- deadline

ActionResult
- commandId
- status
- effect
- changed
- navigation?
- diagnostics?
- error?
- observedAt
```

`effect` should be semantic, not just `success=true`:

```text
DOM_CHANGED
NAVIGATED
MESSAGE_SENT
GENERATION_STARTED
GENERATION_FINISHED
RESPONSE_CHANGED
NO_VISIBLE_CHANGE
TARGET_NOT_FOUND
TARGET_STALE
```

This gives the workflow engine enough information to decide whether to continue, retry, use an alternate locator, or fail safely.

## 2. chrome-use: very relevant because Windows is supported

Repository: https://github.com/leeguooooo/chrome-use

License: Apache-2.0.

Important findings:

- Uses the user's existing logged-in Chrome.
- Extension communicates with a local CLI through Chrome native messaging.
- Extension uses `chrome.debugger` to control targeted tabs.
- No raw debug-port connection is required in its recommended mode.
- Ships a Windows x64 binary.
- Supports multiple concurrent sessions on one real Chrome.
- Each automation session can receive an isolated Chrome tab group.
- Session ownership/handoff/resume are explicit concepts.
- Background operation is a design goal; target work should not require stealing foreground focus.

### Nika-agent implication: preserve an optional local-bridge boundary

Current recommendation remains:

```text
Nika workflow/runtime
      |
BrowserTransport interface
      |
ExtensionNativeTransport   <- initial implementation
LocalBridgeTransport       <- optional later implementation
```

A local bridge should only be added if direct content-script/native Chrome APIs become insufficient for reliable ChatGPT control or future arbitrary-site automation.

Because Windows is supported by chrome-use, a future Windows helper is technically viable without forcing a switch to a standalone Windows application UI.

## 3. Do not adopt chrome.debugger as default yet

`chrome.debugger` is powerful and gives CDP-like capabilities, including cases content scripts cannot easily solve.

But using it as the default Nika transport would increase:

- permission sensitivity;
- implementation complexity;
- attack surface;
- coupling to browser-control details that ChatGPT automation does not currently require.

Therefore:

**Default:** content script + native extension APIs.

**Escalation path:** `chrome.debugger` behind a transport capability when a specific action cannot be reliably completed through DOM/content-script APIs.

The workflow/action interface should not expose which transport was used.

## 4. WebGenie: best new extension-native DOM reference

Repository: https://github.com/derpx06/webgenie

License: Apache-2.0.

Relevant architecture:

```text
Side Panel / Options Page
        |
Background Service Worker
        |
Executor / Task Orchestrator
        |
Navigator + Validator
        |
DOM Service + Page Controller
        |
Content Script / page
```

High-value patterns:

- DOM translated into a compact interactive/accessibility tree.
- Non-interactive layout nodes filtered out.
- explicit post-action validation rather than assuming a click worked.
- side panel for operational UI and options/settings page for configuration.
- domain allow/deny firewall.
- action latency buffer before evaluating state changes.
- tab grouping for automated tasks.
- shared typed schemas across extension contexts.

### Nika-agent adoption

Reuse the ideas, and review Apache-licensed modules selectively before implementing equivalents.

Recommended Nika DOM snapshot structure:

```text
SemanticNode
- ref
- role
- name
- text?
- value?
- disabled?
- expanded?
- selected?
- editable?
- stableAttributes
- children[]
```

The ChatGPT adapter should normally request only a targeted semantic snapshot around:

- composer;
- send/stop controls;
- latest user message;
- latest assistant message;
- response action toolbar.

This avoids serializing the whole ChatGPT page on every poll.

## 5. Deterministic workflow first, self-healing second

`browser-use/workflow-use` is an important product reference even though its AGPL license makes it unsuitable for direct source copying into Nika-agent under a permissive project posture.

Its central model is valuable:

1. Execute deterministic recorded/defined workflow steps.
2. Validate whether the step succeeded.
3. Only invoke fallback/recovery when the deterministic step fails.

For Nika-agent this should be implemented without requiring an external LLM/API.

### Recovery levels

```text
L0: deterministic primary locator/action
L1: deterministic alternate semantic locator
L2: refresh semantic snapshot and retry
L3: re-resolve tab/conversation and retry
L4: reload target tab if policy permits
L5: NEEDS_USER / FAIL
```

No infinite generic agent loop.

This is especially appropriate for ChatGPT because its required action set is narrow and predictable.

## 6. Add a Validator layer to every side effect

A recurring weakness in browser automation is treating "click executed" as "task completed".

Every Nika side effect should have a verifier.

Examples:

### SEND_MESSAGE

Action:
- fill composer;
- submit.

Verify:
- latest user message identity/text changes to expected message;
- composer is cleared or generation begins.

### WAIT_FOR_IDLE

Verify:
- no active generation control;
- assistant response is stable for a debounce window;
- latest assistant message identity is known.

### CAPTURE_RESPONSE

Verify:
- non-empty latest assistant response;
- response identity differs from prior captured response if a new response is expected;
- text hash stored.

### FORWARD_RESPONSE

Verify:
- destination chat latest user message matches forwarding envelope/hash;
- forwarding dedupe ledger records sourceResponseId + destinationChatId.

## 7. Action Effect + Validator is more important than screenshots

For Nika's primary ChatGPT workflow, screenshots/vision should remain fallback only.

Preferred observation hierarchy:

1. semantic DOM/accessibility state;
2. exact known ChatGPT-specific state;
3. structural DOM fallback;
4. screenshot/coordinate mode only if a future site genuinely requires it.

This maximizes reliability and background operation and is much more compatible with NVDA-oriented development than visual coordinate automation.

## 8. Concurrent agent isolation

chrome-use demonstrates a useful pattern: many agents can share one real Chrome while their work is isolated by session/tab groups.

Nika-agent should introduce a lightweight equivalent even without `chrome.debugger`:

```text
ExecutionLane
- laneId
- projectId
- workflowRunIds[]
- targetChatIds[]
- concurrencyLimit
- tabGroupId?
- ownershipPolicy
```

Recommended defaults:

- multiple independent chats may run concurrently;
- a single chat accepts only one mutating workflow at a time;
- read-only inspection may run concurrently if it cannot alter state;
- user manual interaction always wins over automation when a conflict is detected.

For 30–70 development/audit chats, this is essential.

## 9. Add explicit user-control arbitration

When the user starts typing in a ChatGPT composer while Nika intends to send a message, Nika must not overwrite the user's text.

Add:

```text
UserActivityState
- composerHasUserText
- pageRecentlyFocused
- recentKeyboardActivity
- automationLeaseOwner?
```

Before SEND:

1. inspect composer;
2. if non-empty and not owned by the current run, do not replace it;
3. transition run to `BLOCKED_BY_USER` or delay according to policy.

This is a high-priority acceptance requirement for using the same Chrome normally while automation runs.

## 10. Domain firewall / destination safety

WebGenie's domain firewall concept should be adopted.

Initial production allowlist should be extremely narrow:

```text
https://chatgpt.com/*
```

If arbitrary websites are later supported:

- per-project allowed origins;
- explicit user permission grant;
- navigation checks before every cross-origin action;
- never let copied chat content introduce a URL that automatically expands privileges.

## 11. Proposed new reusable components to inspect before writing code

### High priority source review

**WebGenie (Apache-2.0)**

Inspect for possible direct adaptation of:

- accessibility/interactive DOM tree generation;
- shared schema layout;
- action validation;
- domain firewall;
- side-panel/background/content messaging.

**chrome-use (Apache-2.0)**

Inspect for future optional transport:

- Windows native messaging host registration;
- connection health checks;
- session isolation;
- ownership/handoff/recovery;
- background tab operation.

**open-browser-use (MIT)**

Inspect for:

- action/result protocol;
- stale handle semantics;
- capability model;
- resume/recovery event model;
- Playwright-style locator facade.

### Reference only

**workflow-use (AGPL-3.0)**

Use its deterministic + fallback model as architectural inspiration, not code source.

## 12. Updated architecture recommendation

```text
Accessible UI
  - Side Panel: operational console
  - Full Page: projects/chats/workflows/schedules/logs
        |
Application Services
  - ChatRegistry
  - WorkflowRegistry
  - Scheduler
  - RunCoordinator
        |
Durable Runtime
  - XState actors
  - Dexie persistence
  - IdempotencyLedger
  - Validator
  - RecoveryManager
        |
Workflow Actions
  - SEND_MESSAGE
  - WAIT_FOR_IDLE
  - CAPTURE_RESPONSE
  - FORWARD_RESPONSE
  - OPEN_CHAT
  - WAIT_DURATION
  - BRANCH
  - RETRY
        |
ChatGPTAdapter
        |
DomDriver
        |
BrowserTransport
  - ExtensionNativeTransport (default)
  - DebuggerTransport (optional escalation)
  - LocalBridgeTransport (future optional Windows helper)
        |
Chrome
```

## 13. New acceptance tests from this research

Add these to the mandatory suite:

1. User switches to Unigram while a ChatGPT run is waiting; run completes without foreground focus.
2. User types a draft in the target composer; Nika refuses to overwrite it.
3. Two workflows target the same chat simultaneously; only one obtains the mutation lease.
4. Two workflows target separate chats; both can progress concurrently within configured concurrency limits.
5. Action executes but page does not change; Validator returns `NO_VISIBLE_CHANGE` and recovery is bounded.
6. Primary ChatGPT locator fails; alternate semantic locator succeeds without duplicate SEND.
7. Tab reload invalidates DOM refs; stale refs are discarded and resolved again.
8. A forwarded response cannot navigate or grant a new origin implicitly.
9. Extension-native transport can be replaced by a mock/local bridge without changes to workflow definitions.
10. Scheduler and workflow runtime remain fully functional without any native helper installed.

## 14. Development priority change

The earlier plan remains mostly valid, but two modules should move earlier:

1. `Validator` / `ActionResult.effect`
2. `MutationLease` / per-chat concurrency arbitration

Recommended near-term order:

1. shared protocol + semantic action/result types;
2. Dexie schema;
3. chat/tab registry;
4. DomDriver semantic snapshot;
5. ChatGPTAdapter;
6. Validator;
7. idempotency ledger + mutation leases;
8. XState persisted workflow machine;
9. scheduler reconciliation;
10. response router/forwarding;
11. accessible UI;
12. optional debugger/local-bridge experiments only after extension-native acceptance gates pass.

## Final decision

Nika-agent should remain an **extension-native, deterministic, API-free ChatGPT workflow orchestrator** first. The current open-source ecosystem confirms that controlling the user's real Chrome in the background is viable and that a future Windows native bridge can be added without redesigning the product.

The fastest path is not to import a giant generic browser agent. It is to selectively reuse permissively licensed DOM/protocol patterns while building a narrow, durable ChatGPT-specific workflow layer with semantic validation, idempotency, per-chat concurrency control and accessible configuration.
