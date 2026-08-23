# Nika-agent — Open-source landscape and architecture recommendation

Date: 2026-08-24

## Executive conclusion

For Nika-agent, the fastest and most appropriate base is a Manifest V3 Chrome extension that works inside the user's existing logged-in Chrome session. Avoid making Selenium, a separate Playwright browser, or a Windows UI-automation app the primary architecture. Those approaches add extra browser/profile/session complexity that is unnecessary for the first production target.

The best reusable design patterns found are:

1. **Automa** — strong reference for browser-extension-native workflow automation, scheduling, reusable workflow blocks and browser task execution.
2. **Playwriter / Playwright Chrome Extension / browser-control** — strong reference for controlling an already-running Chrome session and reusing current cookies/logins.
3. **Cordyceps / CRX-Browser-Use** — experimental but highly relevant reference for Playwright/Puppeteer-style APIs implemented directly inside a Chrome extension without an external browser process.
4. **Hypha Navigator / browser-agent-bridge** — relevant reference for tab pinning, DOM indexing, command transport, tab isolation and extension/service-worker architecture.
5. **UI.Vision RPA** — mature reference for record/replay, macros, schedules and RPA concepts, but its AGPL/commercial licensing means code reuse must be treated carefully.
6. **Dexie.js** — recommended local IndexedDB abstraction for workflows, chat records, schedules, execution history and logs.

## Recommended Nika-agent architecture

### Core runtime

- Chrome Extension, Manifest V3.
- TypeScript.
- Background service worker for orchestration.
- Content scripts for ChatGPT DOM interaction.
- Side panel or full extension page for the main management UI.
- chrome.alarms for scheduled execution.
- chrome.tabs / chrome.scripting for tab and page control.
- IndexedDB via Dexie.js for durable local data.

### Why this model

The user's existing Chrome session already contains the authenticated ChatGPT web session. A browser-extension-native implementation therefore avoids separate login handling and avoids API costs. It also permits the user to keep working in other windows/tabs while Nika-agent operates on pinned target tabs.

### Chat adapter layer

Do not hard-code all ChatGPT selectors throughout the codebase. Create a dedicated adapter, for example:

- `ChatGPTAdapter.detectState()`
- `ChatGPTAdapter.findComposer()`
- `ChatGPTAdapter.sendMessage(text)`
- `ChatGPTAdapter.isGenerating()`
- `ChatGPTAdapter.waitForCompletion()`
- `ChatGPTAdapter.getLatestAssistantResponse()`
- `ChatGPTAdapter.copyLatestResponse()`

Selectors and heuristics should live in one place and use layered strategies:

1. semantic role/accessible name;
2. stable attributes when available;
3. DOM structure fallback;
4. text fallback as last resort.

This is essential because ChatGPT DOM structure can change.

## Scheduling design

Use `chrome.alarms`, not `setInterval`, for durable extension scheduling. Important caveat: alarms do not wake a sleeping PC. Missed alarms fire when the device wakes; repeating alarms do not replay every missed occurrence.

Therefore workflow schedule records should be persisted and reconciled whenever the service worker starts.

Each schedule should support:

- exact time;
- every N minutes/hours;
- one-shot run;
- repeat count;
- active/inactive;
- allowed time window;
- retry policy;
- next run;
- last run;
- concurrency policy.

## Workflow engine recommendation

Nika-agent should not initially embed a large external workflow engine. A compact native graph/state-machine model is sufficient and easier to audit.

Suggested node types:

- SEND_MESSAGE
- WAIT_FOR_IDLE
- WAIT_DURATION
- COPY_RESPONSE
- FORWARD_RESPONSE
- OPEN_CHAT
- ACTIVATE_CHAT
- IF_STATE
- RETRY
- LOOP
- STOP
- LOG

Suggested triggers:

- scheduled time;
- chat became idle;
- previous step succeeded;
- previous step failed;
- manual start;
- another workflow completed.

Example:

`AUDITOR finishes -> COPY_RESPONSE -> OPEN_CHAT DEV3 -> SEND_MESSAGE(template + copied text) -> WAIT_FOR_IDLE -> LOG`

## Existing projects — evaluation

### Automa
Repository: https://github.com/AutomaApp/automa

Strengths:
- browser-extension-native;
- visual block workflows;
- scheduled automation;
- form filling, repetitive work, scraping and screenshots;
- large existing codebase and ecosystem.

Use for Nika-agent:
- architecture study;
- workflow data model ideas;
- schedule handling ideas;
- UI inspiration;
- browser-extension automation patterns.

Caution:
- source is AGPL / commercial-license mixed. Do not copy code into Nika-agent until license implications are deliberately accepted.

### Microsoft Playwright Chrome Extension
Repository path: https://github.com/microsoft/playwright/tree/main/packages/extension

Strengths:
- explicitly connects automation to pages in the user's existing browser;
- reuses existing browser profile state, cookies and sessions;
- maintained in Playwright ecosystem.

Use for Nika-agent:
- study transport architecture;
- study existing-session browser control;
- testing harness and development tooling.

### Playwriter
Repository: https://github.com/remorses/playwriter

Strengths:
- controls the user's existing Chrome rather than spawning a separate browser;
- preserves cookies, extensions and login state;
- exposes Playwright-style control.

Use for Nika-agent:
- reference architecture for real-session automation;
- debugging/testing infrastructure.

### anomalyco/browser-control
Repository: https://github.com/anomalyco/browser-control

Architecture:
`Agent/CLI -> local relay -> browser extension -> user's browser`

Strengths:
- existing Chromium session;
- Playwright against real profile;
- small, understandable architecture.

Use for Nika-agent:
- optional future local relay architecture if pure-extension restrictions become limiting.

### Cordyceps / CRX-Browser-Use
Repository: https://github.com/adam-s/cordyceps

Strengths:
- demonstrates Playwright/Puppeteer-like client APIs inside a Chrome extension using extension/DOM APIs;
- avoids mandatory CDP/external driver;
- includes structured page snapshot concepts.

Use for Nika-agent:
- research source for robust DOM abstraction;
- inspiration for generic browser action API.

Caution:
- proof-of-concept / much less mature than Playwright or Automa. Treat as research, not a dependency until evaluated.

### Hypha Navigator
Repository: https://github.com/amun-ai/hypha-navigator

Relevant ideas:
- tab listing/open/close/activate/navigation;
- pinned target tab;
- smart indexed DOM;
- input/click/select operations;
- extension service architecture.

Most important Nika-agent lesson:
A workflow can remain attached to its own target tab while the human user browses elsewhere. This directly matches the desired user experience.

### browser-agent-bridge
Repository: https://github.com/ypresto/browser-agent-bridge

Relevant ideas:
- service worker + content script division;
- tab isolation;
- permission checks;
- DOM-core abstraction;
- validated message transport.

Use for Nika-agent:
- security and session-isolation patterns.

### UI.Vision RPA
Repository: https://github.com/A9T9/RPA

Strengths:
- mature browser RPA;
- macro recorder;
- Selenium IDE compatibility;
- Chrome/Edge/Firefox;
- scheduling and repetitive automation concepts.

Use for Nika-agent:
- feature checklist inspiration;
- macro/replay concepts;
- error-handling ideas.

Caution:
AGPL/commercial licensing. Do not embed/copy source casually.

### Dexie.js
Repository: https://github.com/dexie/Dexie.js
License: Apache-2.0.

Recommended for:
- projects;
- chats;
- workflows;
- workflow steps;
- schedules;
- execution runs;
- logs;
- response snapshots;
- settings.

## What should NOT be the primary architecture

### Selenium
Not recommended as the product core. It normally requires an external driver/browser-control process and is less natural for extension-native interaction with the user's existing ChatGPT tabs.

### Standalone Puppeteer/Playwright process
Useful for testing and optional future power-user/local-relay mode, but should not be required to run normal Nika-agent workflows.

### Windows mouse/keyboard automation
Avoid as primary mechanism. Coordinate-based UI automation is fragile and unnecessary when DOM access is available.

### OCR/computer vision
Keep only as optional future fallback for sites where DOM access is insufficient. ChatGPT automation should be DOM/semantic-first.

## User-interface recommendation

Use a persistent side panel or full extension management page, not a tiny popup as the main interface.

Main navigation:

1. Dashboard
2. Projects
3. Chats
4. Workflows
5. Schedules
6. Runs / Logs
7. Templates
8. Settings

### Chat editor

Fields:
- Project
- Chat name
- Role
- URL
- Enabled
- Pinned automation tab
- Default command template
- Completion detection strategy
- Timeout
- Retry policy

### Workflow editor

For NVDA, the primary editor should be a structured step list rather than only a visual graph.

Each row/step:
- step number;
- action type combo box;
- target chat combo box;
- parameters;
- on-success action;
- on-failure action;
- enabled checkbox.

A visual graph may be added later, but accessibility must not depend on it.

### Schedule editor

Controls:
- trigger type combo box;
- interval / exact time;
- start date;
- optional end date or count;
- active checkbox;
- missed-run policy;
- retry count;
- Save / Run now / Disable buttons.

## NVDA/accessibility requirements

- native HTML controls first;
- explicit labels;
- logical heading hierarchy;
- no unlabeled icon-only buttons;
- keyboard-complete operation;
- status updates announced with an ARIA live region;
- accessible tables with headers;
- combo boxes must expose selected values;
- drag-and-drop must always have keyboard alternatives;
- workflow steps must be reorderable with buttons/keyboard, not only mouse drag.

## Immediate development recommendation

1. Build the extension shell in Manifest V3 + TypeScript.
2. Implement ChatGPT adapter and tab registry first.
3. Implement Dexie persistence.
4. Implement `chrome.alarms` schedule reconciliation.
5. Implement workflow state machine.
6. Implement response capture/forwarding.
7. Implement accessible management UI.
8. Add Playwright-based automated regression tests for ChatGPT adapter selectors and core UI where feasible.

## Dependency policy

Before adding a dependency:

- confirm license;
- confirm active maintenance;
- confirm Manifest V3/browser compatibility;
- prefer small libraries with clear purpose;
- avoid dependencies requiring remote code execution, because MV3 extension CSP and Chrome Web Store policies make this problematic.

## Current preferred stack

- Manifest V3
- TypeScript
- native Chrome APIs
- Dexie.js / IndexedDB
- accessible HTML UI
- lightweight internal workflow state machine
- Playwright for development/testing, not mandatory runtime

## Research status

This document is the initial architecture-relevant open-source scan. Next research rounds should inspect source structure of Automa, Playwriter, Cordyceps and browser-agent-bridge in detail and extract reusable patterns at module/API level while respecting licenses.