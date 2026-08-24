# Nika-agent Reuse Matrix

Status: architecture research decision record.

The project should reuse mature libraries for infrastructure but avoid importing frameworks that duplicate Chrome's native runtime or obscure durable recovery semantics.

| Component | Decision | Why | Boundary |
|---|---|---|---|
| WXT | ADOPT | MV3/MV2, TypeScript, file-based entrypoints, active ecosystem, MIT | Build/dev/publish framework only; Chrome APIs remain explicit |
| React | ADOPT for extension UI | Mature accessible UI ecosystem and straightforward Side Panel/workspace composition | Prefer native HTML semantics; do not require a heavyweight component suite |
| Dexie | ADOPT | Practical typed IndexedDB wrapper suitable for structured persistent data | Local IndexedDB only; Dexie Cloud is not required |
| Zod | ADOPT | Runtime schema validation for imports, persisted records and message boundaries | Validation layer, not domain workflow engine |
| Vitest | ADOPT | Fast TypeScript unit tests | Unit/domain tests |
| Playwright | ADOPT for QA/dev | Browser automation, tracing, assertions and extension E2E capability | Test harness only; never embedded as production runtime |
| XState v5 | EVALUATE / bounded adoption | Strong TypeScript state machines and actor model; useful for adapter/workflow state transitions | Durable truth must stay in plain IndexedDB records; no opaque actor snapshot as sole recovery source |
| @wxt-dev/storage | REFERENCE / limited use | Convenient WXT storage abstraction | Use for small preferences if helpful; not high-volume logs/jobs |
| chrome.storage.sync | ADOPT narrowly | Native synced preferences | UI/settings only; quota is too small for response bodies/logs |
| chrome.storage.session | OPTIONAL cache | Fast service-worker-friendly ephemeral storage | Never authoritative across browser restart |
| chrome.offscreen | DEFER | Useful only when service-worker DOM access is genuinely needed | Do not add permission until a concrete requirement exists |
| CRXJS / raw Vite | REJECT as primary | Viable alternatives but would duplicate build-framework evaluation already solved by WXT | Keep as fallback if WXT creates a blocker |
| Plasmo | FALLBACK only | Useful extension framework but current project status is less conservative for this product | Do not mix with WXT |
| Puppeteer/Selenium | REJECT at runtime | External browser automation is unnecessary inside an extension and complicates user-session control | May be used only for research/testing if justified |
| coordinate/OCR automation | REJECT as primary | Fragile, inaccessible, focus-sensitive | Emergency diagnostics only, not canonical behavior |
| external workflow engines / cloud queues | REJECT initially | Overkill and conflicts with local-first/no-server requirement | Re-evaluate only if server mode becomes an explicit product requirement |

## Native Chrome APIs to prefer

- `chrome.sidePanel` for persistent operator surface.
- `chrome.alarms` only as a wake-up mechanism around a persistent scheduler.
- `chrome.runtime` messaging for extension-context communication.
- `chrome.tabs` for locating/focusing/opening configured chat tabs when needed.
- `chrome.scripting` only when static content-script declarations cannot satisfy injection needs.
- IndexedDB for durable jobs/runs/responses/events.

## Dependency rules

1. Pin exact major versions through the package manager and commit the lockfile.
2. Record license and upstream URL for every direct dependency.
3. Prefer package dependency over copied source.
4. If source is vendored, record upstream commit/tag, copied paths, modifications and update policy.
5. No remotely hosted executable JavaScript; Manifest V3 forbids the architecture anyway.
6. Avoid UI component packages that force inaccessible custom widgets where native controls suffice.
7. Bundle-size cost must be justified for every new runtime dependency.

## Current research findings

### WXT

WXT remains the canonical build framework. Its current documentation advertises MV2/MV3 support, TypeScript, file-based entrypoints, multi-browser builds and an active module ecosystem. It also exposes browser APIs through a cross-browser `browser` abstraction, so a separate webextension-polyfill is not required by default.

### Chrome alarms and service-worker lifecycle

Chrome extension service workers are intentionally ephemeral. Global variables are not durable. Alarms do not wake sleeping hardware; missed repeating alarms fire at most once after wake and then reschedule. Therefore Nika-agent must persist jobs and reconcile due work after every wake/start event rather than infer correctness from alarm history.

### IndexedDB

Chrome's own extension documentation confirms IndexedDB is available from extension service workers. Extension-origin IndexedDB is shared across extension pages/service worker, while content-script web storage belongs to the host page. Nika-agent should therefore keep database access inside extension contexts and pass messages from content scripts rather than opening the canonical database from page context.

### Side Panel

The Side Panel API is MV3-capable and intended to host extension UI alongside normal browsing. It remains the best primary operator surface. Complex editors and full logs should live in a dedicated extension workspace page linked from the side panel.

### XState

XState v5 is a zero-dependency TypeScript-capable state-machine/orchestration library. It is technically suitable for bounded adapter/chat state machines. It should not define persistence format or be required to reconstruct a WorkflowRun after service-worker termination; plain domain records remain authoritative.

## Next research questions

1. Measure WXT + React + Dexie + Zod baseline bundle size before adding XState.
2. Prototype durable job claiming in IndexedDB and verify transaction behavior under simultaneous service-worker/UI access.
3. Test whether static content-script registration is sufficient for all supported ChatGPT origins; avoid `scripting` permission if possible.
4. Create a selector/evidence fixture corpus for ChatGPT composer, streaming, error and response states without relying on localized button names.
5. Establish minimum supported Chrome version. Chrome 120+ is a practical baseline because alarm minimum periods and service-worker behavior are better aligned with modern MV3 semantics; decide explicitly before release.
6. Validate Side Panel keyboard/NVDA behavior in real Chrome, not only automated accessibility tooling.
