# Nika-agent Canonical Merge Contract

Status: architecture gate 5

This document defines the authoritative integration order and ownership rules for the current parallel architecture/runtime branches. Its purpose is to prevent duplicate canonical models, merge-order errors, and runtime regressions while Nika-agent is being developed concurrently.

## 1. Current runtime dependency chain

The implementation branches form one cumulative runtime chain and must be integrated in dependency order:

1. PR #5 — Runtime Gate 1: operation serialization and correlated runs.
2. PR #7 — Runtime Gate 2: durable IndexedDB scheduler and restart-safe job queue. Base: Gate 1.
3. PR #9 — Runtime Gate 3: durable SendIntent and ChatGPT transcript reconciliation. Base: Gate 2.
4. PR #10 — Runtime Gate 4: durable workflow checkpoints and restart recovery. Base: Gate 3.

Do not merge #7, #9, or #10 directly to `main` ahead of their base gate unless the branch is explicitly rebased and verified to contain the full required predecessor history.

The preferred integration path is sequential merge of the runtime gates, with CI/typecheck/test verification after every gate.

## 2. Architecture-document branches

PRs #3, #4, #6, and #8 are design contracts, not independent competing implementations.

Their intended relationship is cumulative:

- #3: system-level MV3 orchestration architecture;
- #4: typed runtime/domain contracts and dependency boundaries;
- #6: ChatGPT adapter and scheduler failure/recovery contracts;
- #8: durable data model and workflow checkpoint protocol.

These documents must be reconciled into one coherent normative documentation set. No developer should treat contradictory older wording as authoritative merely because it exists in an earlier PR.

Priority when two documents differ:

1. implemented and verified safety invariant in the newest runtime gate;
2. newer specialized architecture contract;
3. earlier general architecture description.

## 3. Canonical sources of truth by concern

### Scheduler correctness

Authoritative model:
- IndexedDB/Dexie durable jobs and schedule cursors;
- `chrome.alarms` is only a wake/reconciliation mechanism;
- missed occurrences are materialized according to explicit policy;
- default for Continue-style interval automation is `latest`, not replay-all;
- no `setTimeout`, `setInterval`, module-level `Map`, or service-worker memory may be required for correctness.

### Per-chat serialization

At most one mutating operation may own a ChatTarget at a time.

The lease/arbitration state required for restart correctness must be durable. In-memory FIFO/locks may exist only as optimization around the durable state.

### Irreversible message send

Canonical sequence:

`persist durable intent/checkpoint -> establish transcript baseline -> mutate composer -> submit once -> observe/reconcile transcript -> persist confirmed/ambiguous result`

A transport error or service-worker death after submission must never cause blind resend.

Ambiguous result => `needs_review`.

### ChatGPT state detection

No single DOM control is authoritative. `Stop generating` / generation controls are evidence only.

State must be derived from multiple signals including composer readiness, generation indicator, transcript turn identity/count, mutations/stability, navigation/error state, and bounded timeouts.

Unknown state must fail safe and must not trigger a blind send.

### Response capture

Primary path is transcript DOM extraction of the identified assistant turn. Clipboard/Copy UI is not a correctness dependency.

Captured responses should have durable identity/hash sufficient to avoid duplicate routing.

### Workflow recovery

Workflow execution resumes from persisted run/step checkpoints, not from step 1.

A side-effecting node follows:

`persist step-start -> execute/reconcile effect -> persist outputs -> advance durable cursor`

`SEND_MESSAGE` / `ROUTE_TO_CHAT` use deterministic idempotency keys.

### UI/accessibility

Chrome Side Panel is the primary operator surface.

All critical actions must be possible via keyboard and NVDA without drag-and-drop or graph-only interaction.

A structured ordered-step workflow editor is canonical. A visual graph may be added later only as an optional view.

## 4. Required merge gates

No runtime gate is canonical merely because its PR is mergeable.

Before each runtime merge:

1. TypeScript compile/typecheck must pass.
2. Unit tests for newly introduced state transitions must pass.
3. Existing tests must remain green.
4. No runtime path may regress duplicate-send safety.
5. Migration from the previous IndexedDB schema version must be verified.
6. Critical restart/crash test vectors relevant to that gate must pass.
7. Keyboard/NVDA critical path must remain intact for any UI change.

If GitHub Actions is not yet configured, creating CI is a release-blocking integration task, not optional cleanup.

## 5. Immediate integration order

### Phase A — runtime spine

Merge/verify in this order:

`#5 -> #7 -> #9 -> #10`

After #10 lands, create one integration checkpoint on `main` and run the full runtime recovery suite.

### Phase B — canonical documentation

Reconcile #3/#4/#6/#8 against the integrated runtime and merge a single coherent documentation result. Avoid merging duplicated contradictory versions unchanged.

At that point mark older superseded statements explicitly or consolidate files so developers have one clear source per subsystem.

### Phase C — UI expansion

Only after the durable runtime spine is stable should the project expand aggressively into:

- schedule editor;
- workflow editor;
- run/needs-review console;
- operator logs;
- import/export;
- bulk chat management.

The UI must consume runtime APIs; it must not invent its own scheduling or workflow truth.

## 6. Known remaining architecture gaps after Runtime Gate 4

These are the next high-value gaps:

1. Workflow definition version pinning/snapshots for active runs.
2. Alarm-driven wake/resume for long `WAIT_FOR_IDLE` / `DELAY` states without requiring a still-live worker.
3. Selector profile/version diagnostics for ChatGPT DOM evolution.
4. Durable `needs_review` operator resolution protocol.
5. Bounded concurrency/backpressure policy under 50–100 configured chats.
6. Schema migration tests across IndexedDB versions.
7. Import/export schema versioning and validation.
8. CI that builds the extension and runs unit/integration tests on every PR.
9. Playwright fixture/E2E harness for representative ChatGPT DOM states without relying on a live authenticated production chat in ordinary CI.
10. Privacy/retention controls for stored prompts, assistant responses, and logs.

## 7. Next architecture gate

The next architecture work should focus on **workflow definition versioning + operator recovery semantics**, not another broad system overview.

Required deliverables:

- immutable `WorkflowRevision` or snapshot contract;
- rules for editing workflows while runs are active;
- exact `needs_review` resolution actions (`confirm_sent`, `retry_after_proven_absent`, `cancel`, `skip`, `replace_payload` where safe);
- audit/event requirements for manual recovery;
- restart-safe wake strategy for waiting workflow nodes;
- tests covering workflow edit during execution and ambiguous send recovery.

## 8. Non-negotiable safety invariants

1. Never blindly replay an ambiguous ChatGPT send.
2. Never use volatile service-worker memory as the only correctness state.
3. Never allow two concurrent mutating owners for one ChatTarget.
4. Never replay every missed hourly Continue occurrence after sleep by default.
5. Never make clipboard/visible Copy button a required response-capture dependency.
6. Never make mouse, drag-and-drop, visual graph, or coordinate automation required for normal operation.
7. Never couple core workflow state directly to ChatGPT selectors; all DOM access stays behind the adapter boundary.
8. Never merge a later runtime gate before its base dependency is integrated or rebased and fully verified.
