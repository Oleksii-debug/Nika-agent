# Nika-agent — Runtime, workflow and browser-control deep dive

Date: 2026-08-24

## Executive decision

The preferred production direction remains a Manifest V3 Chrome extension operating against the user's existing authenticated Chrome session. The deeper research changes one architectural recommendation: workflow execution should be explicitly restartable and persisted at every meaningful transition because Manifest V3 service workers are ephemeral.

A strong candidate for workflow/state orchestration is **XState v5**, rather than implementing the entire state-machine layer from scratch. It is MIT-licensed, TypeScript-friendly, event-driven, supports actors and persisted snapshots, and maps well to one workflow-run actor per running Nika workflow/chat chain.

The runtime should remain extension-native. Playwriter, Microsoft Playwright Extension, browser-control and Cordyceps are best treated as implementation references and optional development/testing bridges rather than mandatory production dependencies.

## 1. Chrome MV3 lifecycle implications

Chrome extension service workers are event-driven and can be terminated after inactivity. Chrome documentation states that the worker is normally terminated after about 30 seconds of inactivity, and global variables are lost when it shuts down.

Therefore Nika-agent MUST NOT depend on:
- in-memory workflow progress;
- setInterval/setTimeout as the authoritative scheduler;
- a permanently running orchestration loop;
- unresolved state living only inside the service worker.

Instead, every workflow execution should have a durable run record, for example:

```text
RunRecord
- runId
- workflowId
- currentStepId
- state
- targetChatId
- startedAt
- updatedAt
- wakeAt
- retryCount
- lastResponseId/hash
- correlationId
- leaseOwner
- leaseExpiresAt
- error
```

Every transition such as SEND_MESSAGE -> WAIT_FOR_IDLE -> COPY_RESPONSE must checkpoint durable state.

On service-worker wake/start:
1. load active runs;
2. reconcile expired leases;
3. inspect due wakeAt timestamps;
4. re-check target tabs/ChatGPT state;
5. resume from the last persisted state;
6. never blindly repeat a side-effecting action without idempotency checks.

## 2. Scheduling design

Use `chrome.alarms` as the wake-up mechanism. Do not use it as the complete scheduling database.

The authoritative schedule belongs in IndexedDB. `chrome.alarms` should be considered a wake-up index/trigger.

Why:
- alarms do not wake a sleeping computer;
- missed repeating alarms fire at most once after wake and are then rescheduled;
- Chrome documents that important alarms should be checked/recreated when the service worker starts;
- alarm delivery can be delayed.

Recommended model:

```text
IndexedDB schedules -> scheduler reconciliation -> chrome.alarms wake-up -> due-job scan -> workflow-run resume
```

This supports exact-time, interval, repeat-count, allowed-window, retry and missed-run policies without assuming Chrome fires every occurrence exactly.

Suggested missed-run policies:
- SKIP
- RUN_ONCE_NOW
- CATCH_UP_LIMITED(n)
- RESCHEDULE_FROM_NOW

Default for ChatGPT workflows should normally be RUN_ONCE_NOW or SKIP, not replaying dozens of missed messages after a sleeping PC wakes.

## 3. XState v5 assessment

### Why it fits Nika-agent

XState is an event-driven state-machine/statechart/actor library for JavaScript and TypeScript. Its actor model maps naturally to Nika-agent:

- one actor per workflow run;
- events such as CHAT_IDLE, MESSAGE_SENT, TIMEOUT, RESPONSE_CAPTURED, RETRY;
- guards to prevent duplicate sends;
- invoked actors for tab/DOM operations;
- persisted actor snapshots for restart/resume;
- parent/child actors for project -> workflow -> chat-run hierarchy if needed.

License: MIT.

### Recommended use

Use stable XState v5, not current v6/agent alpha APIs.

Do not adopt `@statelyai/agent` as a product dependency now. Nika-agent is controlling the ChatGPT web UI and does not need an LLM-agent framework inside the extension core.

### Example conceptual workflow states

```text
scheduled
  -> acquiring_target
  -> ensuring_chat_ready
  -> sending_message
  -> waiting_generation
  -> capturing_response
  -> forwarding
  -> completed

failure branches:
  -> retry_wait
  -> needs_user
  -> failed
  -> cancelled
```

The workflow definition exposed to users can still be a simple step list. XState is an internal execution engine, not the UI model.

## 4. Browser-control projects — deeper comparison

### Microsoft Playwright Chrome Extension

Very strong proof that automation can attach to pages in an existing browser and reuse the default user profile, cookies and authenticated session.

Recommendation:
- study for transport and test infrastructure;
- potentially use during development/e2e tests;
- do not make an external MCP process mandatory for end users.

### Playwriter

Strong implementation reference for controlling the user's existing Chrome and using accessibility snapshots/ARIA references. It preserves existing login state and exposes a Playwright-style API.

Especially valuable Nika-agent ideas:
- explicit connection/targeting of a tab;
- stateful automation session;
- accessibility-first locators rather than fragile coordinates;
- compact structured page snapshots;
- isolation so an agent can work while the human uses the rest of the browser.

Recommendation:
- study extension transport and tab-session model;
- borrow design patterns, not architecture blindly;
- MIT licensing is favorable for learning/reuse subject to normal attribution obligations.

### anomalyco/browser-control

Architecture:

`Agent/CLI -> local relay -> browser extension -> existing browser`

This is useful as a contingency architecture if a pure extension later needs capabilities impossible or awkward inside MV3. The local relay should remain optional because requiring Node/native software would make installation and NVDA support more complex.

### Cordyceps

MIT-licensed proof-of-concept that ports Playwright/Puppeteer-style APIs into a Chrome extension using Chrome extension APIs and DOM APIs, avoiding mandatory CDP.

High-value ideas:
- generic element/action abstraction;
- cross-iframe/shadow DOM handling;
- structured AI/accessibility snapshots;
- Playwright-like developer ergonomics inside an extension.

Risk:
- much less mature than Playwright;
- use as a research source, not the sole production substrate until tests prove stability.

### Automa

Excellent product/UX and workflow reference:
- graph/block workflows;
- schedules;
- repetitive browser actions;
- extension-native execution.

But licensing is mixed AGPL/commercial. The safe policy for Nika-agent is:
- study behavior, UX and architecture at a high level;
- do not copy source files/modules into Nika-agent unless the licensing strategy is explicitly changed to accommodate it.

## 5. UI architecture decision

Chrome Side Panel is a good companion UI because it can persist beside normal browsing and has access to Chrome extension APIs.

However Nika-agent should use TWO extension surfaces:

### Side panel — operational console

Purpose:
- current project/chat status;
- start/stop/pause;
- quick send;
- current workflow run;
- alerts/errors;
- recent logs.

### Full extension page — configuration/editor

Purpose:
- Projects;
- Chats;
- Workflows;
- Schedules;
- Templates;
- Runs/history;
- Settings;
- import/export/backup.

Reason: complex tables/editors are easier to navigate with NVDA in a full page than in a narrow side panel.

## 6. Accessible workflow editor

Primary editor MUST be semantic/structured, not drag-and-drop.

Recommended structure:

```text
Workflow name: [text]
Enabled: [checkbox]
Concurrency: [combo]

Steps table/list
1. Action [combo: Send message]
   Target chat [combo]
   Message/template [multiline editor]
   On success [combo]
   On failure [combo]
   Move up [button]
   Move down [button]
   Delete [button]

Add step [button]
Validate workflow [button]
Save [button]
Run now [button]
```

For NVDA:
- native form controls wherever possible;
- explicit label/description association;
- heading hierarchy;
- `aria-live` only for meaningful status changes;
- no inaccessible custom combo boxes;
- focus must move predictably after add/delete/reorder;
- every visual status icon must have textual state.

## 7. ChatGPT DOM adapter robustness

The ChatGPT adapter should expose semantic operations, not selectors:

```text
ensureTargetChat(url)
getConversationIdentity()
getComposerState()
sendMessage(text, idempotencyKey)
isGenerating()
waitUntilIdle(deadline)
getLatestAssistantMessage()
getLatestAssistantMessageIdentity()
copyResponse()
```

Selector strategy hierarchy:
1. ARIA role/name and accessible semantics;
2. stable data attributes;
3. stable ancestor/descendant relationships;
4. localized visible text only as fallback.

Never depend on one translated label such as Ukrainian/Russian/English `Stop generating` or `Copy` as the only signal.

Completion detection should be multi-signal:
- generating/stop control presence;
- send/composer enabled state;
- mutation quiet period;
- assistant message identity/content stable for a debounce window;
- configurable timeout.

## 8. Idempotency and duplicate prevention

This is essential because service workers can restart between steps.

For every SEND_MESSAGE operation generate an `idempotencyKey` and persist:
- target chat;
- normalized payload hash;
- time;
- pre-send latest-message identity;
- post-send user-message identity if detectable.

Before retrying after restart, inspect the chat and determine whether the message was already sent.

For COPY/FORWARD operations persist source response identity/hash. Do not forward the same response twice unless the workflow explicitly permits it.

## 9. Tab ownership model

Each chat configuration should store logical identity separately from transient `tabId`.

```text
Chat
- chatId
- projectId
- name
- url
- role
- enabled
- preferredWindowId?
- lastKnownTabId?
```

At runtime:
1. validate lastKnownTabId;
2. verify its URL/conversation identity;
3. if missing, find matching open tab;
4. if absent and policy allows, open background tab;
5. attach run lease to that logical chat;
6. do not steal focus unless the workflow/user explicitly requests activation.

This is how the user can continue working in Unigram, Word or another browser tab while Nika-agent uses its own target tabs.

## 10. Recommended dependency policy after deeper research

### Adopt / strongly consider
- TypeScript
- native Chrome MV3 APIs
- Dexie.js (Apache-2.0)
- XState v5 (MIT)
- Playwright for extension/e2e testing where practical

### Research/reference only initially
- Playwriter
- Microsoft Playwright Chrome Extension
- browser-control
- Cordyceps

### Do not copy source without explicit licensing decision
- Automa (AGPL/commercial mixed)
- UI.Vision RPA (AGPL/commercial considerations)

## 11. Revised implementation order

To minimize wasted work and maximize reliability:

1. Extension shell + permissions + full-page/side-panel navigation.
2. Dexie schema and migrations.
3. Chat registry and tab resolver.
4. ChatGPT adapter with semantic locators and detection diagnostics.
5. XState v5 run machine + persisted snapshots/checkpoints.
6. Scheduler database + chrome.alarms reconciliation.
7. SEND_MESSAGE / WAIT_FOR_IDLE / CAPTURE_RESPONSE primitives.
8. Idempotency/duplicate prevention.
9. FORWARD_RESPONSE and multi-chat workflows.
10. Accessible workflow/schedule editors.
11. Run logs, pause/resume/cancel/recovery.
12. Playwright/Puppeteer extension regression tests including forced service-worker termination tests.

## 12. Acceptance tests that should exist early

- User switches to Unigram while a ChatGPT target tab continues a run.
- Target ChatGPT tab is backgrounded and still receives a command.
- Service worker is killed after SEND_MESSAGE and workflow resumes without duplicate sending.
- PC sleeps across a scheduled run; missed-run policy is applied exactly once on wake.
- ChatGPT DOM changes break one locator; adapter diagnostics surface the failure without corrupting run state.
- Two workflows target the same chat; concurrency policy prevents interleaved prompts.
- Response is copied/forwarded once despite service-worker restart.
- NVDA can create/edit/start a workflow without mouse/drag-and-drop.
- Browser restart reconstructs schedules and active run state safely.

## Final recommendation from this research round

The highest-leverage change is to stop thinking of Nika-agent as a continuously-running script. Treat it as a **durable event-driven workflow runtime** whose browser operations are short, semantic, checkpointed transactions.

For speed of development, adopt XState v5 + Dexie instead of hand-writing both orchestration and persistence primitives. Keep browser automation extension-native, with Playwriter/Cordyceps/Playwright Extension used as architectural and testing references. This gives the shortest path to the user's required developer/auditor scheduling and handoff workflows while remaining robust under Manifest V3 lifecycle constraints.
