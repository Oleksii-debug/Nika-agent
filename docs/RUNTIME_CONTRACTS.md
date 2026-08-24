# Nika-agent Runtime Contracts

Status: architecture contract for implementation workers.

## 1. Purpose

This document turns the high-level architecture into stable implementation boundaries. Workers may change internal implementation, but MUST preserve these contracts unless an architecture PR explicitly changes them.

## 2. Identity and time rules

All persisted records use opaque string IDs (UUID/ULID acceptable). Never use mutable display names as references.

All timestamps are ISO-8601 UTC instants. A Schedule separately stores an IANA timezone for human recurrence semantics.

Every mutation-critical execution carries an `idempotencyKey` that is durable across service-worker restarts.

## 3. Canonical domain records

### Project

Required fields:
- `id`
- `name`
- `enabled`
- `createdAt`
- `updatedAt`

Optional:
- description
- tags
- defaultConcurrency
- quietHours

### ChatTarget

Required fields:
- `id`
- `projectId`
- `name`
- `url`
- `role`
- `enabled`
- `busyPolicy`
- `timeoutMs`
- `createdAt`
- `updatedAt`

Role is user-extensible; built-in suggestions are developer, auditor, coordinator and custom.

The URL is configuration, not authentication material. Nika-agent MUST NOT persist cookies, passwords or ChatGPT session tokens.

### PromptTemplate

Required fields:
- `id`
- `projectId`
- `name`
- `body`
- `createdAt`
- `updatedAt`

Optional variables MUST be resolved before dispatch. Unknown variables are a validation error, not silently blank text.

### Schedule

Required fields:
- `id`
- `projectId`
- `targetChatId`
- `enabled`
- `trigger`
- `timezone`
- `collisionPolicy`
- `retryPolicy`
- `nextDueAt`
- `createdAt`
- `updatedAt`

Trigger union:
- ONCE
- AFTER_DELAY
- FIXED_INTERVAL
- DAILY
- WEEKLY
- WORKFLOW_DEPENDENCY

Optional:
- promptTemplateId
- inlineMessage
- maxExecutions
- executionCount
- earliestWindow
- latestWindow
- maxLatenessMs
- quietHours

Exactly one of promptTemplateId or inlineMessage is required for direct SEND schedules.

### Workflow

Required fields:
- `id`
- `projectId`
- `name`
- `enabled`
- `version`
- `entryNodeId`
- `nodes`
- `edges`
- `createdAt`
- `updatedAt`

Workflow edits create a new version for future runs. Existing WorkflowRuns retain the exact version they started with.

### WorkflowNode

Initial discriminated node types:
- SEND_MESSAGE
- WAIT_FOR_IDLE
- CAPTURE_RESPONSE
- TRANSFORM_TEXT
- ROUTE_TO_CHAT
- DELAY
- CONDITION
- MANUAL_APPROVAL
- STOP

Every node has `id`, `type`, `label`, configuration and bounded failure behavior. No node may wait forever.

### Job

A Job is the durable executable unit.

Required fields:
- `id`
- `projectId`
- `kind`
- `status`
- `priority`
- `dueAt`
- `attempt`
- `maxAttempts`
- `idempotencyKey`
- `createdAt`
- `updatedAt`

Optional:
- scheduleId
- workflowRunId
- workflowNodeId
- targetChatId
- lockedAt
- lockOwner
- startedAt
- completedAt
- lastErrorCode
- lastErrorMessage

Status union:
- PENDING
- CLAIMED
- RUNNING
- WAITING
- SUCCEEDED
- FAILED_RETRYABLE
- FAILED_TERMINAL
- CANCELLED
- SKIPPED

A scheduler wake-up MUST only claim jobs through an atomic durable transition. Memory-only locks are insufficient.

### WorkflowRun

Required fields:
- `id`
- `workflowId`
- `workflowVersion`
- `projectId`
- `status`
- `currentNodeIds`
- `startedAt`
- `updatedAt`

Status:
- QUEUED
- RUNNING
- WAITING
- SUCCEEDED
- FAILED
- CANCELLED
- PAUSED

### CapturedResponse

Required fields:
- `id`
- `projectId`
- `chatId`
- `runId`
- `capturedAt`
- `text`
- `fingerprint`

Optional:
- visibleMessageId
- conversationUrl
- extractionMethod
- diagnosticsId

### ExecutionEvent

Append-only audit event:
- `id`
- `timestamp`
- `projectId`
- `type`
- `severity`
- `message`
- optional jobId/workflowRunId/chatId
- structured metadata with secret/session redaction

## 4. Scheduler reconciliation contract

`reconcile(now)` is the only canonical path for deciding which persisted jobs are executable.

On extension startup, service-worker activation, alarm delivery and relevant user actions:

1. Load overdue PENDING/FAILED_RETRYABLE jobs.
2. Release stale CLAIMED/RUNNING jobs whose leases exceeded their bounded execution lease.
3. Recompute lateness against schedule policy.
4. Apply collision/busy policy.
5. Atomically claim eligible jobs.
6. Execute with per-chat serialization by default.
7. Persist result before deriving the next schedule occurrence.
8. Re-arm the nearest alarm as a wake-up optimization only.

`chrome.alarms` is never the source of truth.

## 5. Collision policies

- SKIP_IF_BUSY: record SKIPPED and advance recurrence.
- WAIT_UNTIL_IDLE: keep durable WAITING state until target becomes idle or timeout/window expires.
- QUEUE_AFTER_CURRENT: enqueue behind the currently running chat job.
- REPLACE_PENDING: cancel older not-yet-running equivalent jobs and keep the newest.

The engine MUST NOT interrupt an in-progress ChatGPT generation merely to satisfy a later schedule unless an explicit future policy is added and opt-in approved.

## 6. Chat adapter interface

The workflow engine depends only on a `ChatAdapter` abstraction.

Required operations:
- `probePage(target)`
- `ensureTargetOpen(target)`
- `readState(target)`
- `submitMessage(target, text, idempotencyKey)`
- `waitForIdle(target, deadline)`
- `extractLatestAssistantMessage(target)`
- `copyLatestViaUI(target)` as optional fallback/verification
- `collectDiagnostics(target)`

Adapter state:
- UNKNOWN
- AUTH_REQUIRED
- READY
- GENERATING
- UI_TRANSITION
- RATE_LIMITED
- BLOCKED
- ERROR
- UNSUPPORTED_DOM

The adapter returns evidence, not guesses. `UNKNOWN` and `UNSUPPORTED_DOM` are valid fail-closed outcomes.

## 7. Completion evidence model

Do not define completion as “Stop button absent”. Completion confidence should combine independent signals:

- no active generation indicator;
- composer is writable/ready;
- assistant message exists after the submitted user message;
- assistant message DOM has stabilized for a bounded quiet interval;
- no known streaming mutation is occurring.

A configurable evidence threshold produces READY; ambiguous evidence yields UNKNOWN and retry/diagnostic behavior.

## 8. Message submission invariants

Before send:
- confirm correct origin and configured chat URL/context;
- confirm adapter READY;
- acquire per-chat durable lease;
- confirm idempotency key has no prior successful send;
- validate non-empty message and size bound.

After send:
- persist SEND_STARTED event;
- verify the new user message appears or another deterministic acknowledgement exists;
- persist SEND_CONFIRMED before releasing the submission phase.

A retry after uncertain acknowledgement MUST first probe for evidence that the message already appeared to avoid duplicate sends.

## 9. Response routing contract

Routing is explicit. A workflow route produces a delivery envelope containing:
- sourceChatId
- sourceRunId
- sourceResponseId
- destinationChatId
- renderedText
- fingerprint

The fingerprint is checked before dispatch. Duplicate envelopes are skipped and logged.

Routing may fan out to multiple destinations, but each destination gets a separate durable Job and idempotency key.

## 10. Transformation rules

Initial TRANSFORM_TEXT is deterministic only:
- prepend template text
- append template text
- truncate to configured bound
- basic variable substitution
- regex/plain-text extraction when explicitly configured

Do not make runtime correctness depend on an external LLM/API. Future optional transformation providers must remain isolated.

## 11. Permissions architecture

Baseline permissions should be minimal:
- storage
- alarms
- tabs only if required by implementation path
- scripting only if dynamic injection is required
- sidePanel

Host access should be restricted to supported ChatGPT origins and preferably requested as optional host permission when UX and Chrome APIs permit.

No broad `<all_urls>` permission in canonical scope.

## 12. IndexedDB ownership

IndexedDB is authoritative for high-volume/runtime records. `chrome.storage.sync` is for small preferences only. `chrome.storage.session` may cache ephemeral values but is never canonical across browser restart.

The database schema MUST have explicit migrations and a monotonically increasing schema version.

Recommended tables/indexes:
- projects: id
- chats: id, projectId, enabled
- templates: id, projectId
- schedules: id, projectId, nextDueAt, enabled
- workflows: [id+version], projectId
- workflowRuns: id, workflowId, status
- jobs: id, status, dueAt, targetChatId, idempotencyKey
- responses: id, chatId, runId, fingerprint
- events: id, timestamp, projectId, jobId
- diagnostics: id, timestamp, chatId

## 13. XState decision boundary

XState is approved for evaluation, not mandatory adoption.

Use XState only for bounded in-memory state-machine execution and UI/runtime orchestration if it materially reduces bugs. Durable workflow/job truth remains in IndexedDB and MUST be reconstructable without serializing opaque library runtime actors.

Reason: XState is mature, TypeScript-oriented and suited to complex state machines, but Nika-agent's recovery model requires plain durable records independent of a runtime interpreter.

## 14. Failure taxonomy

Stable error codes should include:
- AUTH_REQUIRED
- TARGET_NOT_FOUND
- UNSUPPORTED_DOM
- COMPOSER_NOT_READY
- SEND_UNCONFIRMED
- GENERATION_TIMEOUT
- RESPONSE_NOT_FOUND
- RATE_LIMITED
- NAVIGATION_FAILED
- PERMISSION_DENIED
- DATABASE_ERROR
- WORKFLOW_VALIDATION_ERROR
- CANCELLED_BY_USER

UI and logs may localize descriptions, but persisted codes remain stable.

## 15. Emergency stop semantics

Emergency stop:
- immediately sets global automation state PAUSED;
- prevents all new sends/claims;
- cancels pending jobs according to user choice or leaves them paused;
- does not attempt destructive cancellation of an already-generating ChatGPT response in the initial canonical implementation;
- records an audit event.

## 16. Import/export

Configuration export includes projects, chats, templates, schedules and workflows but excludes cookies/session data and, by default, captured conversation bodies/logs.

Imports are schema-validated, versioned and previewed before commit. ID collision policy is explicit: reject, replace, or clone with remapped IDs.

## 17. Accessibility contract

Critical workflows MUST be possible using keyboard and screen reader only.

Canonical UI rules:
- native button/input/select/table/details elements where suitable;
- custom combobox only when native select cannot meet the need;
- no drag-only ordering;
- background refresh never steals focus;
- live regions announce job completion/failure succinctly;
- full log details are reachable without forced announcements;
- row action buttons have unique accessible names including target name.

## 18. Testing gates

Before a subsystem is considered canonical, tests must prove:

Scheduler:
- delayed alarm recovery
- browser restart recovery
- stale lease recovery
- recurrence advancement
- collision policies

Sending:
- duplicate prevention after uncertain acknowledgement
- no send while target is generating
- retry after transient adapter error

Workflow:
- deterministic resume from persisted run
- fan-out routing dedupe
- terminal failure propagation

Adapter:
- known DOM fixtures
- locale variation
- missing/renamed controls fail closed
- streaming completion stabilization

Accessibility:
- keyboard-only CRUD for project/chat/schedule/workflow
- keyboard emergency stop
- sensible focus after add/edit/delete
- screen-reader status semantics

## 19. Architectural freeze

Implementation workers may add fields and internal helpers, but MUST NOT:
- store credentials/session cookies;
- make alarms authoritative;
- bypass durable idempotency;
- bind workflow logic directly to ChatGPT selectors;
- require mouse/drag-and-drop for a critical path;
- use remote executable code;
- silently retry an uncertain send without duplicate detection.
