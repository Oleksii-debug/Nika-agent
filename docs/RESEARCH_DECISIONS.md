# Research Decisions

## Decision summary

### Extension framework: WXT — ADOPT

Reasons:
- active open-source project;
- supports MV3 and multiple browsers;
- TypeScript-first;
- file-based entry points;
- fast HMR/reload;
- no requirement to use a hosted proprietary backend.

Plasmo was evaluated as an alternative. It has strong React/TypeScript support, storage and messaging helpers, but its repository still labels the framework alpha. Keep it as fallback/reference rather than canonical baseline.

### UI surface: Chrome Side Panel + full workspace — ADOPT

The Side Panel API is available in MV3 and is specifically designed to keep an extension UI alongside browsing content. It is preferable to a popup for a persistent control surface. The full workspace/options page hosts complex editors and logs.

### Scheduler: chrome.alarms + persistent reconciliation — ADOPT

`chrome.alarms` can schedule periodic work, but alarms may be delayed and device sleep does not wake the device. Therefore alarms are wake-up hints, not the authoritative schedule. The authoritative queue lives in IndexedDB and is reconciled whenever the worker starts or receives an alarm.

### Persistence: Dexie/IndexedDB + chrome.storage for settings — ADOPT

`chrome.storage.local` is useful for extension state but has a default quota; `storage.sync` is much smaller. Nika-agent may accumulate large prompt, response and event histories, so structured run data belongs in IndexedDB. `chrome.storage.sync` is reserved for small preferences.

### E2E/dev harness: Playwright — ADOPT

Playwright provides Chromium/Chrome automation, auto-waiting, assertions, tracing and parallel tests. It should be used in development/QA, not embedded as the runtime engine of the extension.

### Runtime interaction: content scripts + semantic DOM adapter — ADOPT

The production extension already runs in Chrome and should interact with ChatGPT through content scripts and extension APIs. Prefer semantic selectors (ARIA roles/labels and stable attributes) over visible localized text or screen coordinates.

## Research targets for next passes

1. Compare WXT extension testing patterns with CRXJS and raw Vite.
2. Evaluate Dexie behavior in Manifest V3 contexts and service-worker lifecycle constraints.
3. Catalogue resilient ChatGPT composer, generation-state and assistant-message signals without baking volatile selectors into workflow logic.
4. Evaluate optional `chrome.offscreen` usage only if a concrete requirement cannot be satisfied by service worker/content scripts.
5. Determine the minimum host permissions and whether optional host permissions can reduce installation scope.
6. Evaluate accessible workflow editor patterns using native controls before introducing any custom graph UI.
7. Review open-source workflow/RPA projects for reusable recurrence, queue, retry and state-machine concepts; avoid importing large frameworks unless their licensing and runtime footprint are justified.

## Sources consulted

- Chrome Extensions `chrome.alarms` API documentation, updated 2026-08-13.
- Chrome Extensions Side Panel API documentation.
- Chrome Extensions Storage API documentation.
- Chrome Extensions API reference for MV3.
- WXT project and documentation.
- Plasmo project and documentation.
- Playwright project documentation.
- Dexie 4.x documentation/blog.

## License policy

Before any third-party code is copied or vendored into this repository, record:
- upstream repository and exact commit/tag;
- license;
- files copied;
- modifications;
- update strategy.

Prefer package dependencies over copied source when practical. Do not paste code from repositories with unclear or incompatible licensing.
