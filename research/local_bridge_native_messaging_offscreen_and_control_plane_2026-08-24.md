# Local bridge, Native Messaging, offscreen documents, and browser-control control planes

Date: 2026-08-24
Repository: `Oleksii-debug/Nika-agent`

## Executive decision

The next useful architectural boundary for Nika-agent is a **LocalBridge abstraction**, but it should not be required for the first browser-only runtime.

The strongest current open-source browser-control projects increasingly converge on a hybrid pattern:

`Agent/Desktop process -> local authenticated broker -> Native Messaging bootstrap/ownership -> MV3 extension -> semantic DOM and optional chrome.debugger/CDP`

or:

`Agent/Desktop process -> local authenticated WebSocket/HTTP -> extension/offscreen document -> browser APIs`.

For Nika, the recommended long-term design is therefore:

`Browser-only Nika` remains self-contained in the extension for normal scheduling and ChatGPT workflows.

`Nika LocalBridge` becomes an optional Windows companion for capabilities that a browser extension cannot safely or ergonomically provide by itself: desktop integration, long-lived local process ownership, local file/CLI access, future MCP/agent integration, large binary transfers, machine-level observability, and cross-browser-process coordination.

The bridge transport should be **hybrid** rather than ideological:

- Native Messaging for installation identity, authenticated bootstrap, liveness, and launching/connecting the companion.
- Authenticated localhost WebSocket/HTTP/JSON-RPC for the durable high-throughput data plane when needed.
- Extension runtime messaging for browser-internal control.

Do not move workflow truth out of Dexie merely because a LocalBridge exists. Browser workflow state should remain recoverable without a continuously running local companion unless the workflow explicitly depends on desktop-side capabilities.

---

## 1. Open-source systems worth studying

### 1.1 open-browser-use

Repository: https://github.com/open-browser-use/open-browser-use
License: MIT
Status: active public preview, substantial multi-language codebase.

Why it matters:

- Drives the user's existing logged-in Chrome instead of launching an isolated automation profile.
- WebExtension backend uses MV3 + Native Messaging.
- Separates protocol/wire definitions from host, extension, SDK, and MCP layers.
- Exposes a Playwright-shaped SDK while keeping transport/backend replaceable.
- Supports both WebExtension and CDP backends behind one control model.
- Uses explicit JSON-RPC framing and generated protocol definitions.

High-value patterns for Nika:

1. **Backend-neutral protocol.**
   Nika browser operations should not know whether a future action is executed by pure DOM content script, chrome.debugger, or a LocalBridge-assisted backend.

2. **Generated/central wire contract.**
   We already decided to version BrowserCommand/ActionResult. open-browser-use strengthens the case for keeping method names, error codes, capability flags, and protocol versions in one canonical schema.

3. **Real-browser-first operation.**
   Existing user sessions are treated as the primary environment, matching Nika's real ChatGPT usage model.

4. **Separate control plane from agent-facing API.**
   This is useful if Nika later exposes MCP or desktop APIs without contaminating the browser runtime with MCP semantics.

Do not import the whole project. It is much larger than Nika's current need and its main preview is macOS/Linux oriented. Selectively copy architecture ideas and inspect reusable MIT protocol/controller components only after a dedicated code-level license/reuse review.

### 1.2 iFurySt/open-browser-use

Repository: https://github.com/iFurySt/open-browser-use
License: MIT

This separate implementation is relevant because it explicitly supports Windows installation and Native Messaging setup while preserving the same broad concept: extension + native host + SDK/MCP.

For Nika, it is a stronger operational reference than macOS/Linux-only native-host examples because Windows installation is a first-class requirement.

Reusable lessons:

- one-command native host registration;
- stable extension/native-host pairing;
- CLI `setup`, `verify`, and `doctor` flows;
- platform-specific installation hidden behind one logical bootstrap command;
- extension + companion version compatibility checks.

Nika should eventually have equivalent diagnostics:

`nika bridge install`
`nika bridge status`
`nika bridge doctor`
`nika bridge repair`

The UI should expose the same operations through accessible buttons so command-line use is optional.

### 1.3 Hermes Chrome

Repository: https://github.com/leaf76/hermes-chrome
License: MIT
Current README identifies companion + extension v1.8.x.

Hermes is particularly valuable because it combines:

- Chrome MV3 extension;
- Native Messaging host;
- authenticated localhost bridge;
- Windows Scheduled Task autostart;
- shared pairing token;
- optional MCP adapter;
- policy allow/deny controls;
- health endpoints and explicit bridge status.

Architecture:

`Native Messaging host -> ensures local bridge is running -> extension pairs to localhost bridge -> clients use CLI/MCP/HTTP`.

This is close to the recommended Nika long-term pattern.

Important lesson: Native Messaging does not need to carry all runtime traffic. It can serve as a trusted bootstrap/lifecycle path while the actual control plane uses localhost RPC.

For Nika this is especially useful because Chrome's Native Messaging protocol is asymmetric in message limits: Chrome documents a maximum single message of 1 MB from native host to Chrome and 64 MiB from Chrome to the native host. That is enough for control messages but a poor universal transport for large screenshots, traces, archives, or future diagnostic payloads.

Therefore Nika should keep bridge control messages small and move large artifacts through a separate localhost/file channel with references/hashes rather than embedding them in Native Messaging JSON.

### 1.4 Chrome Faithful

Repository: https://github.com/bpc-oss/chrome-faithful
License: MIT
Status: experimental, explicitly Windows-first.

Relevant architecture:

- controls exact real Chrome profiles;
- authenticated localhost bridge;
- MV3 extension;
- `chrome.debugger` for deeper browser control;
- offscreen document owns a persistent WebSocket so service-worker suspension does not terminate the bridge connection.

This project is useful because it demonstrates a production-shaped answer to a hard question: where should a long-lived connection live in MV3?

However, Nika should not copy its offscreen-WebSocket pattern blindly.

Chrome 116+ explicitly allows active WebSocket traffic in an extension service worker to reset its idle timer. Therefore a service-worker WebSocket is viable on modern Chrome. Offscreen should only be introduced when a real requirement exists for DOM/window APIs, worker spawning, media, or a deliberately separated connection supervisor.

Use an offscreen document as a capability-specific helper, not as a hidden Manifest V2 background page replacement.

### 1.5 Chrome Agent Bridge

Repository: https://github.com/escapeWu/chrome-agent-bridge
License: MIT
Status: very new; macOS/Linux native-host installation only in current initial release.

Why it matters:

- semantic page snapshots;
- atomic click/fill/key/select actions;
- lifecycle monitoring;
- sanitized network monitoring;
- optional raw CDP channel;
- local authenticated token model;
- explicit security boundary around dangerous CDP power.

Strong design lesson: expose **safe semantic capabilities by default**, and make raw CDP an explicitly privileged capability.

Nika should follow the same principle if `chrome.debugger` is ever introduced:

Default:

`semantic snapshot`
`resolve target`
`click/fill/send`
`verify postcondition`.

Advanced/admin only:

`raw CDP` or unrestricted Runtime/Network/DOM commands.

Do not give ordinary workflows a generic `executeJavaScript` or raw `sendCommand` primitive unless a site adapter specifically requires it and policy permits it.

---

## 2. Native Messaging: where it fits and where it does not

Chrome Native Messaging gives an extension a browser-supported path to a registered local application.

Important properties from Chrome's current documentation:

- requires the `nativeMessaging` extension permission;
- native host is registered at OS level;
- Windows registration uses a registry key pointing to the native-host manifest;
- host manifest has explicit `allowed_origins` containing exact extension IDs;
- `runtime.connectNative()` creates a persistent Port and keeps the host process alive until the port is destroyed;
- `runtime.sendNativeMessage()` starts a host per message and only consumes the first response;
- content scripts cannot directly call Native Messaging and must route through an extension page/service worker;
- protocol is length-prefixed UTF-8 JSON over stdin/stdout;
- host -> Chrome message maximum is 1 MB;
- Chrome -> host maximum is 64 MiB.

### Recommendation

If Nika adds a Windows companion, use `connectNative()` rather than `sendNativeMessage()` for the bootstrap/control relationship.

Use cases:

- companion discovery;
- authenticated pairing;
- companion launch/liveness;
- version handshake;
- rotate/recover localhost session credentials;
- obtain bridge endpoint/capability advertisement;
- emergency shutdown/repair.

Do not use Native Messaging as the only binary/data plane for:

- large screenshots;
- long response archives;
- rrweb traces;
- browser traces;
- large file transfer;
- continuous high-volume telemetry.

Prefer content-addressed local artifacts or a localhost stream for those.

---

## 3. Localhost WebSocket/HTTP versus Native Messaging

These are complementary.

### Native Messaging strengths

- Chrome owns host process startup.
- Exact extension ID can be allowlisted in native-host manifest.
- No listening TCP port is required for the initial bootstrap.
- Good trust anchor for extension-to-local-companion pairing.
- Natural Windows installer integration.

### Native Messaging weaknesses

- installation/registry complexity;
- asymmetric message size limit;
- JSON/stdin/stdout framing only;
- Chrome lifecycle owns connection process semantics;
- poor fit for large binary streaming and general-purpose local APIs.

### Localhost WebSocket/HTTP strengths

- standard tooling;
- streams/events are easy;
- large payloads and artifact transfer are easier;
- desktop/CLI/MCP processes can share one broker;
- independent process supervision;
- easy health/status endpoints.

### Localhost weaknesses

- must authenticate every connection;
- must bind to loopback only by default;
- requires CSRF/origin/token protections depending on transport;
- requires process startup/liveness management;
- port collisions and stale processes must be handled;
- exposing the bridge on LAN is a major security escalation.

### Recommended Nika hybrid

`Extension -> Native Messaging -> LocalBridge bootstrap`

then

`Extension <-> authenticated localhost WebSocket/RPC`

when the data plane is useful.

If no LocalBridge feature is being used, there should be no requirement to keep that process running.

---

## 4. Offscreen documents: narrow capability, not durability layer

Chrome's Offscreen API exists because service workers lack `window` and DOM APIs.

Current important constraints:

- Chrome 109+ MV3;
- explicit `offscreen` permission;
- only one offscreen document per installed extension/profile at a time (normal/incognito split can each have one);
- only `chrome.runtime` extension API is directly exposed in the offscreen document;
- document must be bundled static HTML;
- it cannot be focused;
- creation requires an explicit reason and justification.

Current reasons include DOM parsing/scraping, iframe scripting, blobs, media and workers, among others.

### Nika recommendation

Do **not** use offscreen for:

- primary workflow state;
- authoritative scheduler;
- queue ownership;
- leases;
- Effect Journal;
- a fake persistent MV2 background page.

Potential legitimate future uses:

1. connection supervisor if service-worker WebSocket behavior proves insufficient in real forced-suspension testing;
2. spawning a dedicated worker for compute-heavy local processing;
3. Blob/object-URL handling for large local exports;
4. audio/media capabilities if Nika later gains them;
5. limited DOM parsing of extension-owned data.

All durable state must still be persisted outside the offscreen document.

---

## 5. Service-worker WebSocket is more viable than older MV3 guidance suggests

Chrome's service-worker lifecycle documentation states that Chrome 116 introduced a significant improvement: active WebSocket connections extend extension service-worker lifetime, and WebSocket send/receive activity resets the idle timer.

This changes the design tradeoff.

Before adding an offscreen supervisor solely to keep a localhost socket alive, Nika should test:

`service worker WebSocket -> localhost bridge -> heartbeat/event traffic -> forced idle -> sleep/wake -> network interruption -> reconnect`.

If this passes our durability gates, keep the socket in the service worker and avoid an extra execution context.

If it fails under required conditions, promote the connection to an offscreen supervisor, but preserve durable state in Dexie.

Decision should be driven by E2E evidence, not old MV3 folklore.

---

## 6. chrome.debugger/CDP: optional escalation tier

Chrome's `chrome.debugger` API exposes a restricted but powerful set of CDP domains including Accessibility, DOM, DOMSnapshot, Input, Network, Page, Runtime, Storage, Target and Tracing.

It requires the `debugger` permission, which is high-impact and user-visible.

Chrome 118+ also keeps the extension service worker alive while an active debugger session exists.

### Where CDP can help Nika

- accessibility-tree snapshots independent of page DOM helpers;
- robust Input dispatch when synthetic page events fail;
- DOMSnapshot/diagnostic evidence;
- network/error diagnostics;
- deep automation for sites impossible through content-script DOM alone.

### Why it should not be baseline

- broad privilege;
- stronger permission warning/trust burden;
- DevTools attachment conflicts: Chrome fires `onDetach` when DevTools takes over a debuggee;
- exposes a much larger attack surface;
- makes simple ChatGPT automation unnecessarily complex.

### Recommended capability tiers

Tier 0 — normal extension APIs + content-script semantic DOM.

Tier 1 — site-specific MAIN-world bridge, only when required.

Tier 2 — `chrome.debugger` semantic adapter with allowlisted CDP methods.

Tier 3 — raw CDP only in explicit developer/admin mode.

The workflow engine should request a capability, never a transport implementation:

`SiteCapabilityProvider.perform(SEND_MESSAGE)`

instead of

`chrome.debugger.sendCommand(...)`.

---

## 7. Side Panel should become the main operational UI

Chrome Side Panel API is mature enough to be the natural primary Nika operator surface:

- Chrome 114+;
- can remain open while the user changes tabs;
- extension page has access to Chrome APIs;
- can be global or tab-specific;
- can be opened from user interactions;
- newer Chrome versions expose open/close lifecycle events and layout information.

For Nika this is much better than making the popup the main application.

Popup should become a small launcher/status surface.

Side Panel should own:

- project/agent list;
- queue state;
- active workflow runs;
- warnings/AMBIGUOUS effects;
- bridge status;
- Pause All / Resume;
- scheduler controls;
- accessibility-first workflow editor;
- diagnostics.

The Side Panel must remain a projection/controller, not workflow truth. It can disappear at any time; Dexie remains authoritative.

### Accessibility implication

Side Panel is a normal extension document and therefore a better NVDA target than transient popup-only interaction.

Keep native document semantics:

- headings;
- buttons;
- lists/tables where appropriate;
- `aria-live` only for meaningful state transitions;
- no drag-and-drop-only interactions;
- deterministic focus restoration.

---

## 8. Observability pattern from current open-source extensions

A useful reference is `vibery-studio/debug-helper`, an MV3 extension that separates capture contexts:

- ISOLATED world for DOM/user-event capture;
- MAIN world for console/network interception;
- service worker buffers events and flushes in batches;
- screenshots go to IndexedDB;
- structured session/event records remain separate.

This reinforces a useful Nika design:

`runtimeEvents` should be batched append-only observability, not one giant rewritten storage array.

For high-frequency diagnostic events:

`memory buffer -> batch every N events / T seconds -> Dexie transaction`.

But do not sacrifice crash-critical events. Job claim, Effect PREPARED, Effect DISPATCHED, AMBIGUOUS and SETTLED transitions must be persisted synchronously at their transaction boundaries.

So Nika observability should have two classes:

### Durable critical audit

- job claim/release;
- lease/fencing token;
- effect transitions;
- workflow checkpoint;
- recovery decisions;
- security/policy decisions.

Persist immediately/atomically.

### Diagnostic telemetry

- DOM mutation counts;
- selector candidate scores;
- heartbeat status;
- performance timings;
- low-value repeated health checks.

Batch and prune.

---

## 9. Security contract for LocalBridge

If a LocalBridge is added, treat it as a privileged local daemon, not a convenience helper.

Minimum contract:

1. Bind localhost only by default (`127.0.0.1` / `::1`).
2. High-entropy installation/session secret.
3. Native-host `allowed_origins` restricted to the exact Nika extension ID.
4. Protocol version handshake before any action.
5. Capability advertisement and negotiation.
6. Per-command IDs and replay protection where mutating commands cross the bridge.
7. No raw shell execution in the ordinary browser workflow API.
8. File access restricted by explicit capability/policy.
9. Redact secrets/tokens from logs.
10. Rotate bridge session credentials after repair/re-pair.
11. Fail closed if extension and companion versions are incompatible.
12. Optional policy file for allowed capabilities/sites.
13. Network exposure beyond loopback must be a separate explicit feature, disabled by default.

A local bearer token that can drive authenticated browser tabs is effectively a browser-control credential.

---

## 10. Proposed Nika LocalBridge protocol boundary

Do not expose OS implementation details to browser workflows.

Suggested high-level protocol:

### Handshake

`bridge.hello`

returns:

- protocolVersion;
- bridgeVersion;
- instanceId;
- platform;
- capabilities;
- sessionId;
- maximum inline payload;
- artifact transport capabilities.

### Health

`bridge.health`

returns:

- connected;
- uptime;
- extensionSeenAt;
- current sessions;
- warnings.

### Artifact layer

`artifact.put`
`artifact.get`
`artifact.stat`
`artifact.delete`

Payloads above a small threshold should use local files/stream references rather than Native Messaging bodies.

### Browser-assist capability (future)

`browser.observe`
`browser.diagnose`
`browser.cdp` — privileged tier only.

### Desktop capability (future)

Explicit separately permissioned namespaces rather than a generic command executor.

---

## 11. Architecture comparison

| Option | Strength | Weakness | Nika decision |
|---|---|---|---|
| Extension only | Simple install/runtime; least privilege | Cannot access native OS capabilities | **Baseline now** |
| Native Messaging only | Chrome-owned local host trust/bootstrap | Install complexity; 1 MB host->Chrome limit; poor bulk stream | **Use for bootstrap/control if companion added** |
| Localhost WebSocket/HTTP only | Flexible and fast; easy multi-client integration | Must solve secure bootstrap and daemon lifecycle | **Use as optional data plane, not initial trust anchor** |
| Native Messaging + localhost bridge | Strong bootstrap + flexible data plane | More moving parts | **Preferred future LocalBridge architecture** |
| Offscreen persistent supervisor | Window/DOM/worker capabilities; can own long-lived connection | Extra lifecycle/context complexity; easy to misuse as background page | **Only if E2E proves needed** |
| chrome.debugger/CDP | Powerful semantic/diagnostic/control primitives | Broad permission and attack surface | **Optional escalation tier** |
| Remote-debugging Chrome | Excellent automation/CI | Not the user's ordinary logged-in Chrome model | **Testing/server scenarios only** |

---

## 12. Dependency/reuse decisions

### Adopt architecture ideas now

- open-browser-use: backend-neutral browser protocol and generated wire contract.
- Hermes Chrome: Native Messaging bootstrap + authenticated localhost companion.
- Chrome Faithful: connection-supervisor and exact-profile thinking; test before copying offscreen design.
- Chrome Agent Bridge: safe semantic API by default, raw CDP behind explicit privilege.

### Do not add as dependencies now

- entire open-browser-use runtime;
- Hermes bridge runtime;
- Chrome Faithful;
- Chrome Agent Bridge.

Reason: Nika's current browser runtime can remain far smaller and more deterministic.

Selective source reuse may be considered only module-by-module after checking license, dependency footprint, tests, and fit.

### Native APIs preferred

- `chrome.runtime.connectNative`;
- `WebSocket`;
- `chrome.offscreen` if justified;
- `chrome.sidePanel`;
- `chrome.debugger` only at optional capability tier.

No wrapper library is required merely to access these APIs.

---

## 13. New implementation priorities

This research changes the roadmap in the following way.

### Browser runtime first

1. Finish Dexie Job/Lease/Effect model.
2. Typed/versioned messaging.
3. Actor/FIFO per chat.
4. Semantic DOM + settled actions.
5. One-wake scheduler + pacing.
6. Side Panel as primary operational UI.

### LocalBridge boundary second

7. Define `LocalBridgeClient` interface with `DisconnectedBridge` implementation.
8. Define versioned bridge handshake/capability schema.
9. Build a minimal Windows Native Messaging spike.
10. Add `bridge doctor` tests for registry/host manifest/version pairing.
11. Compare persistent `connectNative()` against Native Messaging bootstrap + localhost WebSocket.
12. Test service-worker WebSocket on Chrome 116+ before introducing offscreen.
13. Add offscreen supervisor only if forced-lifecycle tests demonstrate a real gap.

### Advanced browser control later

14. `chrome.debugger` read-only Accessibility/DOMSnapshot spike.
15. Compare semantic snapshot quality with content-script resolver.
16. Decide whether CDP adds enough robustness to justify the `debugger` permission.
17. Never enable raw CDP in ordinary workflows by default.

---

## 14. Forced E2E gates before adopting LocalBridge

A bridge is only useful if it survives real lifecycle failures.

Required tests:

1. Chrome starts before companion.
2. Companion starts before Chrome.
3. Native host missing.
4. Native host manifest points to missing executable.
5. Extension ID changed after unpacked rebuild.
6. Companion version incompatible.
7. Native port disconnects mid-request.
8. Service worker suspends while bridge is connected.
9. Windows sleep/resume.
10. Bridge process crashes and restarts.
11. Port already occupied.
12. Stale pairing token.
13. Large artifact exceeds Native Messaging response limit.
14. Two Chrome profiles attempt to pair.
15. DevTools opens while optional debugger session is attached.
16. Localhost request arrives without valid authentication.
17. Browser workflow remains recoverable if LocalBridge is absent for a bridge-independent job.

A LocalBridge architecture that cannot pass these tests should not become a dependency of core scheduling.

---

## 15. Final recommendation

Nika should remain a **browser-native durable workflow engine first**, with LocalBridge as an optional capability extension.

The strongest future architecture is:

`Side Panel / Scheduler`
`        -> Dexie durable runtime`
`        -> ChatActor / SiteCapabilityProvider`
`        -> semantic DOM (default)`
`        -> chrome.debugger (optional privileged tier)`
`        -> LocalBridgeClient (optional)`
`              -> Native Messaging bootstrap`
`              -> authenticated localhost RPC/WebSocket data plane`
`              -> Windows companion / future MCP / desktop capabilities`.

This keeps the core simple while preserving a credible path to desktop integration and server/agent orchestration.

The most important negative decision from this cycle is equally important: **do not use an offscreen document or a local daemon to hide MV3 lifecycle problems that Dexie checkpoints and proper recovery should solve.** Offscreen and LocalBridge are capabilities, not substitutes for durable state.

## Sources

- Chrome Native Messaging: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
- Chrome Runtime API: https://developer.chrome.com/docs/extensions/reference/api/runtime
- Chrome Offscreen API: https://developer.chrome.com/docs/extensions/reference/api/offscreen
- Chrome extension service-worker lifecycle: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- Chrome Side Panel API: https://developer.chrome.com/docs/extensions/reference/api/sidePanel
- Chrome Debugger API: https://developer.chrome.com/docs/extensions/reference/api/debugger
- open-browser-use: https://github.com/open-browser-use/open-browser-use
- iFurySt/open-browser-use: https://github.com/iFurySt/open-browser-use
- Hermes Chrome: https://github.com/leaf76/hermes-chrome
- Chrome Faithful: https://github.com/bpc-oss/chrome-faithful
- Chrome Agent Bridge: https://github.com/escapeWu/chrome-agent-bridge
- debug-helper: https://github.com/vibery-studio/debug-helper
