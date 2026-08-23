# Nika Agent Architecture

## Product boundary

Nika Agent automates the signed-in ChatGPT web interface. It does not call the OpenAI API and does not store ChatGPT credentials. Authentication remains owned by the browser profile.

## Runtime components

1. **MV3 background service worker**
   - owns schedules via `chrome.alarms`;
   - resolves configured agents;
   - opens or reuses inactive ChatGPT tabs;
   - dispatches workflow actions;
   - writes execution logs.

2. **ChatGPT content adapter**
   - runs only on `https://chatgpt.com/*`;
   - detects generating/idle state;
   - finds the composer;
   - submits prompts;
   - captures the latest assistant response;
   - isolates unstable web-page selectors from the workflow engine.

3. **Workflow engine**
   - executes typed steps: send, wait, capture, forward, delay;
   - stores captured outputs in per-run context;
   - supports developer -> auditor -> developer chains without API calls.

4. **Local persistence**
   - `chrome.storage.local` stores agents, workflows and bounded execution logs;
   - no cookies, ChatGPT tokens or browser-session secrets are persisted by Nika Agent.

5. **Accessible control UI**
   - keyboard-first popup;
   - labelled native controls for NVDA;
   - live status region;
   - agent CRUD and manual execution.

## Scheduling model

Intervals and one-shot events are mapped to `chrome.alarms`. The popup does not need to remain open. Chrome itself must remain running; the target ChatGPT tab may be inactive and can be created by the extension.

## Reliability rules

- Never send while the target chat reports active generation when `waitForIdle` is enabled.
- Require a configurable idle settle period before considering generation complete.
- Reuse an exact configured chat URL where possible.
- If a content bridge is unavailable, reload the target tab once and retry.
- Bound waits with timeouts and log failures.
- Keep all ChatGPT DOM knowledge behind one adapter so selector changes require one localized repair.

## Security rules

- Restrict host access to `chatgpt.com`.
- Do not export cookies, session storage, auth headers or account secrets.
- Do not execute remote code.
- Treat copied assistant text as untrusted data when forwarding between workflows.
- Preserve an audit log for automatic actions.

## Planned extension points

- project registry and project-specific agent sets;
- workflow editor;
- conditional steps and retries;
- multiple prompt queues per agent;
- exact-time and calendar-like scheduling;
- response-copy-button adapter with DOM-text fallback;
- log viewer/export;
- import/export of configuration;
- optional local companion process only if browser limitations later require it.
