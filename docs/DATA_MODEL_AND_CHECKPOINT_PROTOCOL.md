# Nika Agent Durable Data Model and Checkpoint Protocol

## Status

Architecture contract for the persistent runtime. This document is normative for scheduler, workflow and ChatGPT adapter implementations once merged.

## Goals

The runtime must survive Manifest V3 service-worker termination, Chrome restart, machine sleep and ambiguous external browser effects without losing orchestration state or blindly duplicating ChatGPT prompts.

The persistent model must support:

- many projects and many ChatGPT targets;
- multiple schedules targeting the same chat;
- manual and scheduled runs through one queue;
- developer -> auditor -> developer workflows;
- exact recovery after restart;
- per-target serialization;
- bounded retries;
- explicit quarantine for ambiguous external effects;
- deterministic audit history.

## Core principles

1. IndexedDB is the source of truth for durable runtime state.
2. In-memory Maps, Sets, promises and timers are caches/optimizations only.
3. `chrome.alarms` is a wake-up hint, not the schedule database.
4. Every irreversible browser mutation is surrounded by durable checkpoints.
5. Ambiguity after an external effect is never resolved by blind replay.
6. Workflow execution is resumable from persisted node state, not from JavaScript stack state.
7. Per-target ordering is explicit and persisted.
8. Configuration records and execution records are versioned separately.

## Logical entities

### Project

```ts
interface Project {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  schemaVersion: number;
}
```

### ChatTarget

```ts
interface ChatTarget {
  id: string;
  projectId: string;
  name: string;
  role: 'developer' | 'auditor' | 'coordinator' | 'custom';
  chatUrl: string;
  enabled: boolean;
  waitForIdleByDefault: boolean;
  idleSettleMs: number;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  schemaVersion: number;
}
```

`chatUrl` is configuration data, not authentication material. Cookies, session tokens and authorization headers must never be persisted by Nika Agent.

### PromptTemplate

```ts
interface PromptTemplate {
  id: string;
  projectId: string;
  name: string;
  body: string;
  variables: string[];
  createdAt: number;
  updatedAt: number;
  schemaVersion: number;
}
```

### Schedule

```ts
interface Schedule {
  id: string;
  projectId: string;
  targetId: string;
  promptTemplateId?: string;
  inlinePrompt?: string;
  kind: 'interval' | 'one_shot' | 'exact_time';
  enabled: boolean;
  intervalMs?: number;
  runAt?: number;
  timezone?: string;
  missedRunPolicy: 'skip' | 'latest' | 'all_bounded' | 'manual';
  maxCatchUp?: number;
  nextDueAt?: number;
  createdAt: number;
  updatedAt: number;
  schemaVersion: number;
}
```

### ScheduleCursor

Tracks materialization independently of alarm delivery.

```ts
interface ScheduleCursor {
  scheduleId: string;
  lastMaterializedOccurrenceAt?: number;
  lastReconciledAt: number;
  revision: number;
}
```

### WorkflowDefinition

```ts
interface WorkflowDefinition {
  id: string;
  projectId: string;
  name: string;
  enabled: boolean;
  entryNodeId: string;
  nodes: WorkflowNodeDefinition[];
  createdAt: number;
  updatedAt: number;
  schemaVersion: number;
}
```

Supported node families should include:

- send_message;
- wait_for_idle;
- capture_response;
- transform_text;
- route_to_chat;
- delay;
- condition;
- manual_approval;
- stop.

### Job

A Job is the durable unit claimed by workers.

```ts
interface Job {
  id: string;
  projectId: string;
  targetId?: string;
  source: 'schedule' | 'manual' | 'workflow' | 'recovery';
  sourceId?: string;
  occurrenceKey: string;
  kind: 'send' | 'workflow_resume' | 'capture' | 'reconcile';
  payload: unknown;
  status:
    | 'pending'
    | 'claimed'
    | 'running'
    | 'completed'
    | 'failed'
    | 'needs_review'
    | 'cancelled';
  priority: number;
  dueAt: number;
  attempt: number;
  maxAttempts: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  startedAt?: number;
  completedAt?: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  createdAt: number;
  updatedAt: number;
}
```

`occurrenceKey` must be unique for a logical scheduled/manual/workflow occurrence. It prevents duplicate materialization when reconciliation runs multiple times.

### WorkflowRun

```ts
interface WorkflowRun {
  id: string;
  workflowId: string;
  projectId: string;
  status: 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'needs_review' | 'cancelled';
  currentNodeId?: string;
  context: Record<string, unknown>;
  startedAt?: number;
  updatedAt: number;
  completedAt?: number;
  revision: number;
}
```

### NodeCheckpoint

Every workflow node transition must be persisted.

```ts
interface NodeCheckpoint {
  id: string;
  runId: string;
  nodeId: string;
  sequence: number;
  phase:
    | 'ready'
    | 'prepared'
    | 'effect_started'
    | 'effect_observed'
    | 'completed'
    | 'failed'
    | 'needs_review';
  inputSnapshot?: unknown;
  outputSnapshot?: unknown;
  externalIntentId?: string;
  errorCode?: string;
  createdAt: number;
  updatedAt: number;
}
```

### SendIntent

A send intent exists before the composer is mutated.

```ts
interface SendIntent {
  id: string;
  jobId: string;
  runId?: string;
  nodeId?: string;
  targetId: string;
  promptHash: string;
  promptPreview: string;
  phase:
    | 'prepared'
    | 'composer_written'
    | 'submit_started'
    | 'confirmed_in_transcript'
    | 'not_observed'
    | 'ambiguous'
    | 'cancelled';
  createdAt: number;
  updatedAt: number;
}
```

`promptPreview` must be bounded and is for diagnostics only. The full prompt may remain in the job payload or workflow context according to retention settings.

### CapturedResponse

```ts
interface CapturedResponse {
  id: string;
  runId?: string;
  jobId?: string;
  targetId: string;
  messageIdentity?: string;
  text: string;
  textHash: string;
  capturedAt: number;
}
```

### ExecutionEvent

Append-only operational audit trail.

```ts
interface ExecutionEvent {
  id: string;
  timestamp: number;
  projectId?: string;
  targetId?: string;
  jobId?: string;
  runId?: string;
  nodeId?: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  code: string;
  message: string;
  details?: unknown;
}
```

## IndexedDB stores and indexes

Recommended Dexie stores:

```text
projects:          &id, name, enabled, updatedAt
chatTargets:       &id, projectId, [projectId+enabled], name, updatedAt
promptTemplates:   &id, projectId, name, updatedAt
schedules:         &id, projectId, targetId, enabled, nextDueAt, [enabled+nextDueAt]
scheduleCursors:   &scheduleId, lastReconciledAt
workflows:         &id, projectId, enabled, updatedAt
workflowRuns:      &id, workflowId, projectId, status, updatedAt
nodeCheckpoints:   &id, runId, [runId+sequence], [runId+nodeId], phase
jobs:              &id, &occurrenceKey, status, dueAt, targetId, [status+dueAt], [targetId+status]
sendIntents:       &id, jobId, targetId, phase, updatedAt
responses:         &id, targetId, runId, jobId, capturedAt, textHash
events:            &id, timestamp, projectId, targetId, jobId, runId, code
meta:              &key
```

The exact Dexie syntax may be adjusted for browser compatibility, but the lookup capabilities above are architectural requirements.

## Transaction boundaries

### Materializing a scheduled occurrence

One IndexedDB transaction must:

1. read schedule + cursor;
2. derive due logical occurrences;
3. apply missed-run policy;
4. insert jobs using unique `occurrenceKey`;
5. advance cursor;
6. commit.

If the transaction aborts, neither cursor advancement nor partial job insertion may survive.

### Claiming a job

One transaction must:

1. verify `status === pending` or reclaimable claimed state;
2. verify no active mutating lease for the same target;
3. set `claimed`, `leaseOwner`, `leaseExpiresAt`;
4. increment revision/updatedAt;
5. commit before browser work begins.

### Completing a job

Persist output/checkpoint first, then mark job completed in the same transaction when feasible.

## Per-target serialization

Mutating operations for the same ChatTarget must never execute concurrently.

A runtime may execute multiple jobs globally, but only one active mutating lease may exist per target.

Read-only state inspection can be concurrent only if it cannot race with composer mutation or transcript capture semantics.

## Checkpoint protocol for external effects

### Send message node

Required sequence:

1. Acquire durable job/target lease.
2. Persist NodeCheckpoint(`prepared`).
3. Persist SendIntent(`prepared`) with hash of exact prompt text.
4. Resolve/open target tab.
5. Observe ChatGPT state.
6. If configured, wait for verified idle.
7. Write exact prompt into composer.
8. Persist SendIntent(`composer_written`).
9. Persist NodeCheckpoint(`effect_started`) before invoking submit.
10. Invoke submit exactly once for this attempt.
11. Re-observe transcript.
12. If matching user message is confirmed, persist SendIntent(`confirmed_in_transcript`) and NodeCheckpoint(`effect_observed`).
13. Persist NodeCheckpoint(`completed`) and advance workflow/job state.

If the worker dies after step 9, recovery must reconcile the transcript before deciding whether another submit is safe.

### Wait-for-idle node

This node has no irreversible external effect.

Persist:

- ready -> waiting metadata;
- last observed evidence;
- completed only after multi-signal idle confirmation and settle window.

A restart simply resumes observation.

### Capture response node

1. Persist prepared checkpoint.
2. Read the expected latest assistant message.
3. Compute message identity/hash.
4. Insert `CapturedResponse` using a dedupe key/constraint suitable for the implementation.
5. Persist completed checkpoint with response id.

Capture is read-only and may be safely repeated if deduplicated.

### Route-to-chat node

Routing creates a downstream Job. The node is complete only after that Job is durably inserted with a unique occurrence key derived from `(workflowRunId, nodeId, routeSequence)`.

A restart may retry insertion; uniqueness converts it into idempotent materialization.

## Recovery algorithm

On service-worker startup, alarm wake, extension startup and explicit resume:

1. open/migrate DB;
2. clear/reclassify expired leases;
3. inspect jobs in `claimed`/`running` whose lease expired;
4. inspect `SendIntent` and node checkpoints;
5. for read-only or pre-effect jobs, return safely to `pending` when policy permits;
6. for `effect_started` sends, reconcile ChatGPT transcript;
7. if the intended prompt is positively observed, continue after send;
8. if positively absent and the adapter can establish that no submit occurred, controlled retry may be allowed;
9. if evidence is ambiguous, set `needs_review` and do not resend;
10. reconcile schedules and materialize current due jobs;
11. resume eligible workflow runs from durable checkpoints.

## Missed-run policies

### skip

Discard missed logical occurrences and schedule the next future one.

### latest

Materialize only the latest due occurrence. Recommended default for recurring `Продовжуй`-style prompts after sleep/restart.

### all_bounded

Materialize historical occurrences up to `maxCatchUp`. Never create an unbounded burst.

### manual

Record that occurrences were missed but require user approval before creating mutating jobs.

## Retry policy

Safe automatic retry candidates:

- state reads;
- tab discovery;
- adapter observations;
- response capture with dedupe;
- downstream job insertion with uniqueness;
- transient browser messaging failures before any external effect starts.

Not automatically replayable without reconciliation:

- ChatGPT message submit;
- any future file upload;
- destructive browser/page actions;
- actions where external success cannot be proven absent.

## Retention and privacy

Default retention should be configurable separately for:

- execution events;
- captured responses;
- completed jobs;
- workflow context.

Never store:

- ChatGPT cookies;
- session/local-storage auth tokens;
- authorization headers;
- browser credentials.

Exports must exclude secret browser/session state by construction.

## Schema migration rules

1. Every persistent database change increments a DB schema version.
2. Migrations must be deterministic and idempotent within Dexie upgrade transactions.
3. Existing user configuration must not be silently discarded.
4. Runtime must fail closed if a migration cannot complete.
5. Database downgrade is unsupported unless an explicit reverse migration exists.
6. Import/export format has its own version independent from IndexedDB version.

## Acceptance gates

The persistent runtime is not production-ready until deterministic tests prove at minimum:

- duplicate schedule reconciliation does not duplicate jobs;
- machine sleep with `latest` does not create prompt bursts;
- two jobs for one target serialize;
- worker death before composer mutation is safely replayable;
- worker death after send begins does not blindly replay;
- transcript reconciliation can continue after a confirmed prior send;
- ambiguous prior send becomes `needs_review`;
- response capture is deduplicated across restart;
- downstream workflow routing is idempotent;
- expired pre-effect leases are reclaimable;
- expired post-effect leases are reconciled/quarantined;
- workflow resumes from node checkpoint rather than restarting from node 1;
- emergency stop prevents acquisition of new mutating jobs while preserving durable state.

## Implementation sequence

1. Establish Dexie schema and migration/version framework.
2. Make Job + occurrence uniqueness the canonical queue contract.
3. Implement durable per-target lease claim/reclaim.
4. Add WorkflowRun + NodeCheckpoint persistence.
5. Add SendIntent persistence before composer mutation.
6. Implement adapter transcript reconciliation.
7. Convert workflow engine from stack-local progress to durable node resumption.
8. Add deterministic restart/crash tests.
9. Only then expand higher-level workflow/UI features that depend on reliable delivery semantics.
