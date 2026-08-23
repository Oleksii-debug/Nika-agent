# Nika-agent Architecture

## 1. Product boundary

Nika-agent is a local-first Chrome/Chromium extension that orchestrates user-configured ChatGPT web chats without using the OpenAI API. The extension does not own the ChatGPT account, does not store passwords or cookies, and must operate only inside already-authenticated browser sessions.

Primary use case: manage many developer, auditor, coordinator and custom-role chats, schedule different prompts, detect completion, collect results, and route results into other configured chats.

## 2. Architecture decision

Use a Manifest V3 extension with four major planes:

1. **Control UI** — persistent Chrome Side Panel plus a full-page Options/Workspace view.
2. **Scheduler / workflow engine** — background service worker with persistent job state.
3. **Chat adapter layer** — content scripts that inspect and interact with supported ChatGPT DOM states.
4. **Persistence / audit layer** — IndexedDB for projects, chats, schedules, workflow state and execution logs; chrome.storage.sync only for small user preferences.

### Why Side Panel

The Side Panel is the primary operator UI because it can remain open while the user navigates between tabs and is an extension page with access to Chrome APIs. The popup is intentionally secondary and limited to quick status/start/stop actions.

### Why MV3 service worker

Manifest V3 is the current Chrome extension platform. The service worker coordinates alarms, tabs, messaging and job recovery. It must be treated as ephemeral: no correctness-critical state may live only in worker memory.

## 3. Technology baseline

Recommended build stack:

- TypeScript.
- WXT as the extension build framework.
- React for Side Panel / workspace UI.
- Dexie over IndexedDB for structured local persistence.
- Zod for runtime validation of imported configuration and persisted records.
- Playwright for integration/E2E testing against controlled fixture pages and, where appropriate, manual-authenticated test sessions.
- Vitest for unit tests.

WXT is preferred over a hand-built manifest because it supports MV3, TypeScript, multiple extension entry points and fast development without locking runtime logic to a proprietary cloud. Plasmo remains a viable fallback, but its own repository still describes the framework as alpha; therefore WXT is the conservative default.

## 4. Runtime components

### 4.1 Service worker

Responsibilities:

- load due jobs from persistence;
- reconcile missed or delayed alarms;
- create/close/focus dedicated automation tabs only when required;
- dispatch commands to content scripts;
- maintain per-chat execution locks;
- enforce concurrency limits;
- apply retry/backoff policy;
- write execution events;
- recover after browser/service-worker restart.

The scheduler MUST NOT assume `chrome.alarms` is exact. Every wake-up executes a `reconcile(now)` pass over persisted jobs. Each job stores `nextDueAt`, `lastStartedAt`, `lastCompletedAt`, status and idempotency key.

### 4.2 Chat content adapter

The ChatGPT integration is isolated behind an adapter interface so DOM churn does not contaminate the workflow engine.

Required adapter operations:

- `probePage()` — identify page/session/readiness.
- `findComposer()` — locate writable prompt editor.
- `readGenerationState()` — idle/generating/unknown/error.
- `submitMessage(text)` — insert and send only after readiness checks.
- `waitForCompletion()` — observe DOM/state transitions with bounded timeout.
- `extractLatestAssistantMessage()` — preferred data path.
- `invokeCopyLatest()` — optional UI-action fallback/verification.
- `collectConversationMetadata()` — title/url/visible conversation identifier if available.

Selectors must be layered:

1. stable semantics: ARIA labels, roles, form structure, data attributes;
2. structural heuristics;
3. locale-aware text labels only as a fallback.

Never bind core behavior solely to Ukrainian/English button text such as "Stop" or "Copy".

### 4.3 Workflow engine

A workflow is a directed graph of nodes and edges.

Initial node types:

- SEND_MESSAGE
- WAIT_FOR_IDLE
- CAPTURE_RESPONSE
- TRANSFORM_TEXT
- ROUTE_TO_CHAT
- DELAY
- CONDITION
- MANUAL_APPROVAL
- STOP

Triggers:

- exact date/time;
- every N minutes/hours;
- after previous node completes;
- after target chat becomes idle;
- one-time delayed execution;
- manual run.

Conditions:

- completion detected;
- response exists;
- response contains/does-not-contain text;
- retry count;
- time window;
- prior step success/failure.

### 4.4 Persistence

Use IndexedDB/Dexie for high-volume data:

- projects
- chats
- promptTemplates
- schedules
- workflows
- workflowRuns
- jobs
- capturedResponses
- executionEvents
- adapterDiagnostics

Use `chrome.storage.sync` only for lightweight settings such as UI preferences because its quota is small. Do not place response bodies or logs there.

## 5. Scheduling semantics

Supported recurrence modes:

- once at time T;
- after delay D;
- fixed interval N;
- daily/weekly windows;
- sequential script;
- dependency-driven workflow.

Every scheduled action has:

- enabled flag;
- timezone policy;
- earliest/latest execution window;
- max lateness;
- collision policy;
- retry policy;
- idempotency key;
- max executions or unlimited;
- optional quiet hours.

Collision policies:

- SKIP_IF_BUSY
- WAIT_UNTIL_IDLE
- QUEUE_AFTER_CURRENT
- REPLACE_PENDING

## 6. Chat state machine

Per-chat states:

- UNKNOWN
- READY
- GENERATING
- WAITING_FOR_UI
- BLOCKED
- ERROR
- PAUSED

The system transitions only on explicit observations. Absence of a known "stop" control alone is insufficient evidence that a response completed. Completion should combine DOM mutation stabilization, assistant-message presence, composer readiness and absence of generation indicators.

## 7. Response routing

A captured response may be routed to one or multiple destination chats.

Routing envelope contains:

- source project/chat;
- source run ID;
- timestamp;
- raw captured text;
- optional prefix/suffix template;
- destination chat(s);
- deduplication fingerprint.

Example chain:

Developer completes -> capture latest assistant response -> build auditor envelope -> send to Auditor -> capture audit response -> route audit findings back to Developer.

## 8. Operator UI

### Primary Side Panel

Keyboard/NVDA-first layout:

1. Current project combobox.
2. Global automation state: Running / Paused / Error.
3. Primary actions: Start, Pause, Run selected, Emergency stop.
4. Chats table/list with name, role, status, next action.
5. Jobs queue with due time and state.
6. Recent events/log summary.

### Full Workspace page

Tabs/landmarks:

- Projects
- Chats
- Prompt templates
- Schedules
- Workflows
- Runs
- Logs
- Settings

### Chat editor

Fields:

- Name
- URL
- Project
- Role combobox
- Enabled checkbox
- Tags
- Default busy policy
- Default timeout

### Schedule editor

Fields:

- Target chat
- Prompt template / inline message
- Trigger type
- Date/time or interval
- Collision policy
- Retry policy
- Run count
- Start/end window
- Enabled

### Workflow editor

Prefer an accessible ordered-step editor as the canonical interface. A visual graph may be added later but must not be required. Each step has Move up/down, Edit, Duplicate, Delete and Test controls.

## 9. Accessibility requirements

- Every control reachable by keyboard.
- Native HTML controls preferred over custom widgets.
- Combobox/listbox behavior follows ARIA Authoring Practices when custom widgets are unavoidable.
- Status changes announced through polite live regions; critical failures through assertive alerts.
- No workflow requires drag-and-drop.
- Stable heading hierarchy and landmarks.
- Focus must not jump when background state updates.
- Logs and tables expose useful text labels, not icon-only controls.

## 10. Safety and integrity

- No password/cookie/token collection.
- Host permissions restricted to required ChatGPT origins.
- No remote executable code.
- All imported workflow files schema-validated.
- Per-chat locks prevent duplicate sends.
- Global emergency stop cancels new sends immediately.
- Destructive actions require explicit user opt-in; initial product scope should not automate deleting chats/account operations.
- Logs redact sensitive session data and never persist browser cookies.

## 11. Testing architecture

- Unit tests: scheduler, recurrence, state machine, routing, dedupe.
- Fixture DOM tests: adapter against multiple known ChatGPT-like DOM fixtures and locale variants.
- Playwright extension tests: side panel/workspace, permissions, messaging, navigation, restart recovery.
- Adversarial tests: missing controls, delayed rendering, duplicate messages, stale tabs, offline mode, browser sleep/restart.
- Accessibility tests: keyboard-only paths plus automated accessibility checks; manual NVDA acceptance remains required.

## 12. Non-goals for initial canonical architecture

- OpenAI API usage.
- Server-side account login.
- Storing ChatGPT credentials.
- OCR/click-by-coordinate automation as the primary mechanism.
- LLM-dependent interpretation for basic DOM state; deterministic adapters come first.

## 13. Architectural invariants

1. Persistent state is authoritative; service-worker memory is cache only.
2. Every send operation is idempotency-protected.
3. Every automated interaction is traceable to a user-defined job/workflow.
4. DOM integration is isolated behind adapters.
5. Scheduling tolerates sleep/restart/delayed alarms.
6. UI remains fully operable without a mouse.
7. The product can run while the user works in another application, provided Chrome and required tabs/session remain available.
