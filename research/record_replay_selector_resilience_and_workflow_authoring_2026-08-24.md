# Record/replay, selector resilience, and workflow authoring reuse

Date: 2026-08-24
Repository: `Oleksii-debug/Nika-agent`

## Executive decision

The next useful reuse opportunity for Nika-agent is not another generic browser driver. It is the **workflow authoring layer**: recording user actions, generating stable locator candidates, editing recorded steps, and importing/exporting a portable browser-flow representation.

Recommended architecture:

`Nika high-level workflow DSL`

- `SEND_MESSAGE`
- `WAIT_FOR_IDLE`
- `CAPTURE_RESPONSE`
- `FORWARD_RESPONSE`
- `DELAY`
- `IF_STATE`
- `LOOP`

plus an optional embedded generic browser-flow segment:

`GENERIC_WEB_FLOW -> Chrome Recorder UserFlow-compatible steps`

This keeps ChatGPT-specific reliability rules under Nika control while allowing the editor to learn generic browser operations by recording instead of requiring users or developers to hand-author selectors.

No new mandatory runtime dependency is required by this research cycle.

---

## 1. Chrome DevTools Recorder + @puppeteer/replay

### Status

Strongly recommended as an **interchange/reference format**, not as Nika's primary runtime.

Project: `puppeteer/replay`
License: Apache-2.0
Current repository remains active in 2026; package line visible in repository is 4.x.

Relevant capabilities:

- parses and validates Chrome DevTools Recorder user flows;
- replays recordings;
- transforms recordings to other formats;
- exposes extension points before/after each step;
- supports custom replay/stringify extensions;
- provides canonical test flows for testing extensions;
- Chrome DevTools Recorder itself can export/import JSON flows and can be extended with DevTools extensions.

Sources:

- https://github.com/puppeteer/replay
- https://developer.chrome.com/docs/devtools/recorder/
- https://developer.chrome.com/blog/extend-recorder/

### Decision for Nika

Do **not** replace Nika workflow definitions with raw Recorder UserFlow.

Recorder steps are generic UI actions. Nika needs stronger domain semantics and postconditions around operations such as ChatGPT SEND, capture, forwarding, durable scheduling, leases, and ambiguity handling.

Instead, support a boundary such as:

```text
WorkflowStep
  SEND_MESSAGE
  WAIT_FOR_IDLE
  CAPTURE_RESPONSE
  FORWARD_RESPONSE
  GENERIC_WEB_FLOW
```

`GENERIC_WEB_FLOW` may contain or reference a Chrome Recorder-compatible flow.

Benefits:

1. users can record a deterministic web sequence once;
2. Nika can import it instead of asking for hand-written CSS selectors;
3. Playwright/Puppeteer export is possible for debugging and E2E reproduction;
4. future migration to another executor remains possible because the stored data is not tied to one custom script format.

Important caveat: there is an open 2026 request for a first-class JSON Schema in `puppeteer/replay`. The TypeScript types are authoritative, but Nika should maintain its own versioned import validator rather than assuming a forever-stable JSON schema.

---

## 2. Browser Agent Recorder

Project: `VelvetAbyss/browser-agent-recorder`
License: MIT
Stack: TypeScript, Manifest V3, React, Dexie/IndexedDB, Vitest.

This is the closest architectural reference found in this cycle for Nika's future **Teach/Record Workflow** function.

It records:

- clicks;
- typing;
- form changes;
- submit;
- keyboard shortcuts;
- navigation;
- SPA route changes;
- file uploads;
- drag/drop;
- browser dialogs.

The especially useful pattern is that each recorded action stores several locator candidates:

- semantic role;
- label;
- placeholder;
- visible text;
- CSS;
- XPath;

with a confidence score. Low-confidence locators are surfaced for editing.

It also has a separate editor and exports to:

- Markdown SOP;
- Playwright;
- Chrome DevTools Recorder JSON;
- agent-oriented skill packs.

Source:

- https://github.com/VelvetAbyss/browser-agent-recorder

### Decision for Nika

This repository is a **strong code-level reference and selective reuse candidate**, but not a dependency to embed wholesale.

Why it is useful:

- MV3 architecture is close to Nika;
- Dexie already matches Nika's planned storage layer;
- recording code, selector candidate generation, privacy masking, and export transformations are isolated modules;
- MIT licensing makes selective reuse legally straightforward subject to preserving notices.

Why not adopt wholesale:

- project is very young and currently has minimal adoption;
- editor is designed around visual screenshot review and drag/reorder, while Nika must be NVDA-first;
- Nika has durable workflow, scheduler, effect-journal and ChatGPT-specific contracts that the recorder does not provide.

Recommended code-review targets:

- `src/content/recorder.ts`
- `src/shared/selector.ts`
- `src/shared/exporters.ts`
- `src/shared/db.ts`
- `src/shared/types.ts`

The next developer spike should compare its selector-candidate generation against Nika's semantic locator strategy.

---

## 3. rrweb

Project: `rrweb-io/rrweb`
License: MIT
Status: mature and active; repository had roughly 20k stars and was updated in July 2026.

rrweb records:

- initial DOM snapshots;
- DOM mutations;
- user interactions;
- subsequent page changes;

and can replay those events later.

Current 2.x guidance is to use:

- `@rrweb/record`
- `@rrweb/replay`

rather than the older monolithic `rrweb` package.

Sources:

- https://github.com/rrweb-io/rrweb
- https://github.com/rrweb-io/rrweb/blob/main/guide.md

### What rrweb is good for in Nika

Not for primary automation execution.

It is potentially very valuable for:

1. **diagnostic recording** around failed runs;
2. reproducible bug reports when ChatGPT DOM changes;
3. optional circular/ring recording of a small recent window;
4. audit evidence for unexpected page transitions;
5. developer reproduction without requiring a user to describe what visually happened.

### What rrweb should not become

Do not use raw rrweb events as the Nika workflow language.

A replay stream reproduces browser state/history; it does not give the reliability semantics needed for:

- postcondition-driven SEND;
- recovery-safe idempotency;
- per-chat leases;
- scheduler logic;
- semantic adaptation when the site changes.

### Privacy and storage warning

Recording ChatGPT pages can capture sensitive conversation content. Any rrweb integration must therefore be:

- explicitly opt-in;
- local by default;
- short-retention/ring-buffer by default;
- configurable to mask user-entered text and sensitive DOM;
- excluded from normal production telemetry.

Also avoid unsafe replay options that enable scripts inside replayed snapshots unless there is a compelling isolated debugging need.

Decision: **optional diagnostics feature only**, not MVP dependency.

---

## 4. Selenium IDE

Project: `SeleniumHQ/selenium-ide`
License: Apache-2.0
Status: mature record/playback ecosystem.

Selenium IDE provides useful architectural references:

- recorder;
- standardized project/command model;
- playback runtime;
- command metadata;
- code export plugins;
- reusable shared API/model packages.

Source:

- https://github.com/SeleniumHQ/selenium-ide

### Decision for Nika

Reference only.

The current application architecture is broader/heavier than required for a WXT Chrome extension and is centered around Selenium/WebDriver execution rather than the existing-session DOM-first runtime Nika needs.

However, its separation of:

`model -> command metadata -> runtime -> exporter`

is a good pattern for the Nika workflow editor.

Nika should similarly avoid embedding editor-specific assumptions inside the runtime.

---

## 5. Playwright CRX and Chrome-native recorder execution

Project: `ruifigueira/playwright-crx`

Playwright CRX packages Playwright-like recorder/player behavior inside a Chrome extension and relies on `chrome.debugger` for its transport.

Source:

- https://github.com/ruifigueira/playwright-crx

### Decision

Reference for the future advanced transport/recording mode, not baseline runtime.

Nika should continue using content scripts and semantic DOM for core ChatGPT actions because:

- permissions are narrower;
- architecture is simpler;
- we already operate inside the authenticated page;
- it avoids making debugger permission mandatory.

But Playwright CRX is evidence that an optional advanced recorder/debugger layer can later be introduced without replacing the workflow model.

---

## 6. Recorder-generated selectors: adopt candidate sets, not one selector

The most important design conclusion from recorder projects is that a recorded step should not persist only one CSS selector.

Recommended Nika structure:

```ts
interface LocatorCandidate {
  kind: 'role' | 'label' | 'placeholder' | 'text' | 'testid' | 'css' | 'xpath';
  value: string;
  confidence: number;
  source: 'recorded' | 'generated' | 'manual';
}

interface RecordedTarget {
  candidates: LocatorCandidate[];
  expectedRole?: string;
  expectedName?: string;
  textFingerprint?: string;
}
```

Runtime resolution order should remain semantic-first:

1. accessible role + name;
2. stable label/placeholder/test id;
3. structural/CSS fallback;
4. XPath only as a final compatibility fallback.

After resolving a candidate, the postcondition still determines success.

This is more resilient than replaying an exact selector captured weeks earlier.

---

## 7. Proposed "Teach Nika" authoring mode

A practical authoring mode can be implemented without LLM/API use.

### User journey

1. Open the target page/chat.
2. Choose `Record workflow`.
3. Perform the desired actions once.
4. Stop recording.
5. Nika converts raw events into a small step list.
6. User edits each step in a keyboard-accessible form.
7. Nika validates targets and postconditions.
8. Save as reusable workflow/template.

The recorder should capture low-level facts, but the editor should encourage promotion to high-level Nika actions.

Example:

Raw recording:

```text
click composer
input "Продовжуй"
click send
```

Normalization for ChatGPT:

```text
SEND_MESSAGE("Продовжуй")
```

This is crucial. We want recording to simplify authoring, not to turn Nika into a brittle click macro system.

---

## 8. Workflow editor implications for NVDA

Do not copy screenshot-centric recorder UIs directly.

A recorded flow should be exposed as an ordered semantic list:

```text
Step 1 of 4
Action: Navigate
URL: ...

Step 2 of 4
Action: Send message
Target chat: DEV01
Message: Продовжуй

Move up
Move down
Edit
Delete
Test step
```

For locator editing, expose candidates as a normal list/table with text descriptions, confidence and a `Test locator` button.

No essential authoring operation should depend on:

- dragging blocks;
- interpreting screenshots;
- selecting an element by mouse overlay.

A visual picker may exist as an optional convenience for sighted users, never as the only path.

---

## 9. Storage model for recorded flows

Do not store large session recordings together with durable workflow state.

Suggested separation:

### Durable workflow tables

- workflows
- workflowSteps
- recordedTargets
- locatorCandidates
- schedules
- jobs
- effects

### Optional diagnostics tables

- debugSessions
- debugChunks
- screenshotEvidence

Recorded rrweb/debug data should have explicit expiry/cleanup policies.

---

## 10. Comparison

| Candidate | Best use in Nika | License | Adopt now? |
|---|---|---|---|
| Chrome Recorder UserFlow | portable generic flow import/export | Chromium tooling | Yes, as compatibility format |
| `@puppeteer/replay` | parser/validator/transform reference | Apache-2.0 | Strong candidate for tooling/tests, not browser runtime |
| Browser Agent Recorder | recorder + selector candidates + editor/export patterns | MIT | Code-level reuse spike |
| rrweb | diagnostics/session reproduction | MIT | Optional later |
| Selenium IDE | mature record/playback architecture reference | Apache-2.0 | Reference only |
| Playwright CRX | recorder/advanced debugger transport | open source | Advanced/reference only |

---

## 11. Updated build decisions

### Keep

- WXT
- TypeScript
- Dexie
- XState
- p-queue
- `@webext-core/messaging`
- `dom-accessibility-api`
- native MutationObserver
- Chrome alarms/storage/session APIs

### Add to roadmap, not mandatory runtime yet

- Chrome Recorder UserFlow import/export
- optional `@puppeteer/replay` tooling in dev/test environment
- "Teach Nika" recorder mode
- locator-candidate model
- optional local rrweb diagnostic ring buffer

### Do not do

- do not make recorded CSS selector the source of truth;
- do not use rrweb replay as workflow execution;
- do not replace high-level ChatGPT actions with low-level clicks;
- do not make `chrome.debugger` mandatory for recording;
- do not build an inaccessible drag-only workflow editor.

---

## 12. Recommended next implementation/research slices

1. Define `RecordedTarget` + `LocatorCandidate` types.
2. Build a tiny content-script recorder spike for click/input/navigation.
3. Compare selector output against `browser-agent-recorder/src/shared/selector.ts`.
4. Normalize recorded ChatGPT composer/send actions into `SEND_MESSAGE`.
5. Add Chrome Recorder UserFlow import/export prototype.
6. Test `@puppeteer/replay` parsing/transform in dev tooling only.
7. Add accessible recorded-step editor prototype.
8. Add `Test locator` with semantic evidence.
9. Prototype a short local-only rrweb diagnostic ring buffer separately from durable workflow storage.
10. Run live ChatGPT canary after recording to confirm SPA navigation and locator invalidation behavior.

## Final recommendation

Nika should become **recordable without becoming macro-based**.

The reusable pattern is:

`record low-level user actions -> generate multiple semantic locator candidates -> normalize known site operations into high-level Nika actions -> edit accessibly -> execute through verified Nika runtime`.

That gives the user the convenience of no-code recording while preserving the reliability architecture already established for durable scheduling, ChatGPT-specific postconditions, ambiguity-safe SEND and recovery.