# Nika Agent — Integration Coordinator Plan

## Current integrated state

The repository already contains a working architectural spine:

- WXT + Manifest V3 + TypeScript project structure;
- ChatGPT content adapter isolated from workflow logic;
- tab orchestration and idle waiting runtime;
- reusable workflow engine with send / wait / capture / forward / delay steps;
- Chrome alarm based per-agent scheduling;
- local storage and bounded logging primitives;
- accessible popup shell with agent CRUD and manual execution;
- architecture and reuse research documentation.

This means the project should now be treated as an integration-and-hardening effort, not as a greenfield prototype.

## Critical gaps

### P0 — workflow scheduler is not integrated

`background.ts` rebuilds alarms only for agents. `WorkflowDefinition` has `enabled` and steps, but no schedule field, and workflows are therefore manual-only. This conflicts with the product requirement for automated auditor -> developer -> auditor chains and different timed scenarios.

Required change:
- introduce `WorkflowScheduleSpec` or reuse a common schedule model;
- create `workflow:<id>` alarms;
- dispatch them through `runWorkflowNow`;
- persist next-run / last-run status.

### P0 — concurrency / duplicate-send protection is missing

Multiple alarms or manual runs can target the same ChatGPT chat concurrently. The current runtime only waits for ChatGPT idle state; it does not lock a Nika agent execution.

Required change:
- per-agent execution mutex/lease;
- workflow run id and step id in logs;
- idempotency guard for scheduled events;
- queue behavior: skip, enqueue, or replace must be explicit.

### P0 — workflow wait step performs a capture

The current `wait_idle` implementation calls `captureAgentResponse`, which waits and captures/logs a response even though the semantic step is only waiting. This creates unnecessary DOM extraction and misleading logs.

Required change:
- expose `waitForAgentIdle(agent)` separately;
- `wait_idle` must not capture output.

### P0 — end-to-end tests are missing

`package.json` declares Vitest but the repository currently exposes no visible test suite in the root structure. Build/compile scripts are present, but there is no evidence of selector, workflow, scheduler, or storage regression coverage.

Required test gates:
1. typecheck;
2. unit tests for workflow interpolation and execution;
3. scheduler alarm mapping tests;
4. storage migration/default tests;
5. content-adapter DOM fixture tests;
6. simulated developer -> auditor -> developer workflow;
7. accessibility checks for popup controls.

### P1 — scheduling model is too narrow

Current schedule types: interval, once, manual.

Product requirement needs:
- exact daily/weekly time;
- every N hours/minutes;
- finite repeat count;
- run after another workflow/agent completes;
- condition-based trigger;
- cooldown / minimum interval;
- start/end windows;
- enable/disable without deleting configuration.

### P1 — project model exists only as `projectId`

Agents and workflows contain `projectId`, but there is no Project entity or UI for project-level grouping.

Required entity:
- id;
- name;
- description;
- enabled;
- default completion policy;
- tags;
- optional concurrency limit.

### P1 — prompt queue / command sequence is not yet modeled

A ChatAgent has one `defaultPrompt`. The requested product requires different commands to the same chat at different times.

Required model:
- reusable PromptTemplate;
- ScheduledAction / AgentJob;
- ordered prompt sequences;
- finite/infinite recurrence;
- per-job schedule independent from the agent.

### P1 — response routing needs provenance

Forwarding currently moves raw text from a context key to another agent. Add:
- source agent id;
- source chat URL;
- capture timestamp;
- workflow run id;
- optional prefix/suffix/template;
- max length / truncation policy;
- duplicate-response hash.

### P1 — audit deliverable absent

No independent `AUDIT*.md` result is currently visible in the repository. Until that exists, QA conclusions cannot be treated as integrated evidence.

Required audit output:
- architecture defects;
- security defects;
- selector fragility;
- NVDA/accessibility defects;
- reproducible test failures;
- severity + remediation status.

## Architecture decisions to preserve

1. Keep ChatGPT DOM knowledge isolated inside the content adapter.
2. Keep authentication owned by the signed-in browser profile; never persist cookies or session secrets.
3. Prefer WXT/Chrome primitives over embedding Playwright/Puppeteer in the extension.
4. Keep automatic actions auditable through structured local logs.
5. Native accessible controls and keyboard-first UX remain a release requirement.

## Integration order

### Gate 1 — runtime correctness
- split idle waiting from capture;
- add per-agent execution lock;
- add retry/backoff policy;
- add structured run identifiers.

### Gate 2 — complete scheduling domain
- project entity;
- job entity;
- workflow schedules;
- event-based dependencies;
- repeat counts and time windows.

### Gate 3 — workflow routing
- capture provenance;
- response hashing / duplicate prevention;
- templated forwarding;
- queue semantics.

### Gate 4 — UI
- Projects screen;
- Chats/Agents screen;
- Jobs/Schedules screen;
- Workflows screen;
- Logs screen;
- Settings screen;
- accessible validation and live status announcements.

### Gate 5 — tests and audit
- unit + integration tests;
- packaged extension smoke test;
- NVDA keyboard pass;
- independent audit report;
- all P0 findings closed before release packaging.

## Recommended UI information architecture

The popup should remain a fast status/control surface. Full configuration should use an extension Options page rather than forcing complex workflow editing into a small popup.

Popup:
- global Start/Pause;
- current running jobs;
- next scheduled actions;
- quick Run now;
- recent errors;
- Open Control Center button.

Options / Control Center:

1. Projects
2. Chats
3. Jobs
4. Workflows
5. Logs
6. Settings

Use native labelled text fields, comboboxes, checkboxes, buttons and tables/list views. Avoid drag-and-drop-only workflow editing. Every operation must be reachable by keyboard and announced by NVDA.

## Release definition

Nika Agent should not be called functionally complete until a user can configure this sequence entirely from UI:

1. Add Developer chat URL.
2. Add Auditor chat URL.
3. Schedule a Developer prompt.
4. Wait for the Developer response to finish.
5. Capture that response.
6. Forward it to Auditor with an audit instruction.
7. Wait for Auditor completion.
8. Capture the audit.
9. Forward the audit back to Developer.
10. Repeat according to a configured schedule or finite run count.
11. Review complete logs and errors without opening DevTools.

That scenario is the minimum end-to-end acceptance workflow for the product vision.

## Coordinator checkpoint — 2026-08-24

Live `main` was re-verified before issuing the next integration order. No implementation commit newer than the coordinator plan is currently integrated. The P0 findings above therefore remain open and should be treated as blocking defects, not backlog suggestions.

### Next merge contract

The next implementation merge should be deliberately narrow and must close Gate 1 before adding more UI surface or advanced scheduling.

Required code-level outcomes:

1. Add `waitForAgentIdle(agent, timeoutOverride?)` to `src/runtime.ts` and change workflow `wait_idle` to call it without capturing or logging a response.
2. Introduce an execution lease keyed by agent id. Every send/capture/wait operation that touches a chat must run under the same arbitration policy.
3. Define queue policy explicitly. Default recommendation: enqueue scheduled work per agent; reject or surface a clear conflict for duplicate manual starts; never silently send two prompts to the same chat concurrently.
4. Add `runId` and `stepId` provenance to execution logs so every workflow action can be reconstructed later.
5. Add bounded retry with exponential backoff for transient content-script/tab messaging failures. Do not retry semantic failures such as missing agent, disabled agent or invalid configuration.
6. Add unit tests covering idle-wait separation, locking, duplicate-start protection and retry termination.

### Domain contract for the following merge

Only after Gate 1 passes, extend `src/types.ts` with first-class domain entities instead of inflating `ChatAgent`:

- `Project`
- `PromptTemplate`
- `AgentJob`
- `WorkflowSchedule`
- `RunRecord`

An `AgentJob` should own the scheduled prompt/action, recurrence rules and finite repeat count. `ChatAgent` should represent the destination chat and completion policy, not every future command that may be sent to it.

Recommended trigger model:

- manual;
- once at timestamp;
- interval;
- daily/weekly exact time;
- after job/workflow completion;
- after captured response;
- bounded retry trigger.

Each trigger must support enable/disable and, where meaningful, start window, end window, cooldown and maximum executions.

### Integration conflict resolution

If parallel developers produce overlapping implementations, merge by responsibility rather than commit age:

- DOM selectors and ChatGPT page behavior belong only in `chatgpt.content.ts` or a dedicated adapter module;
- tab/message/retry/locking behavior belongs in runtime infrastructure;
- scheduling belongs in a scheduler module, not UI handlers;
- workflow orchestration must consume runtime/scheduler APIs and must not query DOM directly;
- popup/options UI may call background commands but must not execute workflow logic itself.

Reject integrations that duplicate these responsibilities across layers even if they appear to work locally.

### Stop conditions for release claims

Do not call the extension complete while any of the following is true:

- workflow alarms cannot run autonomously;
- the same chat can receive concurrent sends;
- a wait step creates a fake capture event;
- the user cannot configure different scheduled commands for one chat;
- developer -> auditor -> developer cannot complete end-to-end without manual copy/paste;
- no reproducible tests cover selectors, scheduler and workflow routing;
- critical controls cannot be operated with keyboard/NVDA.
