# Actor-per-chat, WebMCP, and settled-action patterns for Nika-agent

Date: 2026-08-24
Repository: `Oleksii-debug/Nika-agent`

## Executive decision

This cycle investigated three areas that can materially simplify or harden Nika-agent without adding another generic browser-agent framework:

1. **actor-per-chat execution** as an alternative mental model to scattered locks/queues;
2. **WebMCP** as a future site-native interaction path that can bypass brittle DOM actuation when a site exposes structured tools;
3. **settled-action verification** from modern accessibility-snapshot browser runtimes, where an action is not declared successful until a fresh observation proves the page changed as expected.

The recommendation is:

- **ADOPT THE PATTERN now:** model each chat as a single-writer logical actor, even if implemented with Dexie + queue + lease rather than a full actor framework;
- **DO NOT adopt `do-runtime` as a production dependency now:** it is technically impressive but currently 0.x, heavy for Nika's needs, and its original portions are FSL-1.1-MIT rather than immediate MIT;
- **ADD a future `SiteCapabilityProvider` boundary:** `WebMCPProvider` first when the page exposes compatible tools, `DomSiteProvider` as the deterministic fallback;
- **DO NOT make WebMCP a baseline dependency:** the spec is still a Community Group draft/origin-trial surface in Chrome and can change;
- **ADOPT settled-action semantics now:** every mutating browser action returns `PENDING_OBSERVATION`, `SETTLED_SUCCESS`, `NO_EFFECT`, `WRONG_EFFECT`, or `AMBIGUOUS`, rather than treating `click()`/`dispatchEvent()` as success;
- **KEEP `@webext-core/messaging` for extension-context messaging:** Comlink/Cap'n Web are useful references for future worker/offscreen/local-relay RPC, not replacements for the current typed extension protocol.

This strengthens the existing Nika architecture without increasing baseline runtime complexity.

---

## 1. Current Nika baseline

The current repository remains intentionally minimal at dependency level: WXT, TypeScript, and Vitest are the only committed dependencies today. The previous research direction already selected Dexie, XState, p-queue, `@webext-core/messaging`, and `dom-accessibility-api` as likely additions.

The important point for this cycle is that we should avoid importing a large actor/workflow/browser framework unless it removes more complexity than it creates.

Nika's target workload is unusual:

- tens of independent ChatGPT conversations;
- each conversation may be read concurrently;
- each conversation must have only one mutating owner at a time;
- scheduler events can arrive concurrently;
- a service worker can die at any time;
- tabs can be frozen/discarded/recreated;
- a SEND side effect can become ambiguous after crash;
- user manual work must never be overwritten.

That workload maps naturally to an actor model even if the implementation stays small.

---

## 2. `do-runtime`: a serious actor-model reference, not a baseline dependency

### What it is

`WebMCP-org/do-runtime` ports Cloudflare Durable Object semantics into TypeScript for browser and Node environments. The browser version uses:

- one root actor per Web Worker;
- SQLite-WASM over OPFS;
- input and output gates;
- named actor identity;
- transactional storage;
- durable alarms;
- MessagePort RPC;
- an offscreen-document supervisor in its Chrome MV3 example.

It was explicitly extracted from a Chrome-agent project that needed Durable Object semantics inside an extension.

The most relevant invariant is **single-threaded actor processing that survives `await`**: a second call cannot interleave with a currently executing event for the same actor. This is exactly the semantic Nika wants for mutating work on one chat.

### Why the pattern is valuable for Nika

Instead of reasoning globally:

`dispatcher -> lock DEV17 -> workflow -> unlock DEV17`

we can reason conceptually:

`ChatActor("DEV17").send(command)`

The actor owns:

- target binding;
- mutation ordering;
- lease/fencing state;
- last observed response identity;
- current ambiguous effect;
- circuit-breaker state;
- queue of pending mutations.

The actor processes one mutation at a time.

Reads can either be served from cached durable state or exposed through explicit read-only methods.

### Why we should not adopt `do-runtime` now

Despite the architectural fit, it is not the right Nika dependency today.

Reasons:

1. It is a 0.x project.
2. It brings SQLite-WASM, OPFS, Web Workers, gated globals, alarm machinery and an offscreen supervisor when Nika can currently meet its needs with IndexedDB/Dexie.
3. Its original implementation is source-available under FSL-1.1-MIT and converts to MIT after two years; only workerd-derived portions are Apache-2.0. This is not as clean as our preferred MIT/Apache dependency policy.
4. Nika does not need Cloudflare Durable Object API compatibility.
5. A full actor-per-worker model for 30-100 chats would be operationally heavier than necessary inside an extension.

### Decision

**REFERENCE ONLY.**

We should copy the semantics, not the runtime:

- actor identity = `chatId`;
- one mutating command at a time per chat;
- state changes durable before acknowledging them;
- durable alarm intent separated from physical Chrome alarms;
- stale-reference fencing;
- supervisor/runtime separation.

Implementation remains our lighter stack:

`Dexie + per-chat durable queue/lease + fencing token + p-queue dispatcher + XState workflow`.

---

## 3. Actor-per-chat model for Nika

Introduce a logical contract even if no actor library is used:

```ts
interface ChatActorState {
  chatId: string;
  targetBinding: ChatTargetBinding;
  mutationOwner?: string;
  fencingToken: number;
  circuitState: 'closed' | 'half_open' | 'open';
  ambiguousEffectId?: string;
  lastObservedUserMessage?: MessageIdentity;
  lastObservedAssistantResponse?: ResponseIdentity;
  nextAllowedMutationAt?: number;
}
```

Commands:

```text
READ_STATUS
READ_LATEST_RESPONSE
ACQUIRE_TARGET
SEND_MESSAGE
WAIT_RESPONSE
CAPTURE_RESPONSE
RECOVER_AMBIGUOUS_EFFECT
RELOAD_TARGET
RELEASE_TARGET
```

The important rule:

> All mutating commands for one `chatId` are serialized through the same logical actor lane.

This removes an entire class of local races.

### Actor and workflow are not the same thing

Do not merge these concepts.

**Workflow actor/run** answers:

> Which business step happens next?

**Chat actor** answers:

> Who may mutate this conversation now and in what order?

A Developer->Auditor workflow can interact with several chat actors.

Example:

```text
Workflow Run 991
  -> DEV17 actor: SEND_MESSAGE
  -> DEV17 actor: WAIT/CAPTURE
  -> AUDIT03 actor: SEND_MESSAGE
  -> AUDIT03 actor: WAIT/CAPTURE
```

This separation will remain valid if a future Nika Server replaces the extension-side workflow engine.

---

## 4. WebMCP is now important enough to design for, but not depend on

### Current state as of 2026-08-24

WebMCP is a proposed web standard that allows sites to expose structured JavaScript tools to browser agents instead of forcing the agent to infer operations from DOM clicks and fields.

The current WebMCP draft is a W3C Community Group Draft, not a Recommendation. Chrome documentation still classifies it as an origin-trial / intent-to-experiment surface. Chrome 149 introduced the origin trial; Chrome 150 deprecates `navigator.modelContext` in favor of `document.modelContext`.

Chrome's own documentation explicitly positions WebMCP as more reliable than actuation because the site declares a tool's purpose and schema directly.

This is strategically relevant to Nika.

### Why it changes our future architecture

Today Nika must implement:

```text
semantic snapshot
-> locate composer
-> fill composer
-> locate Send
-> click
-> verify user-message
```

If a future version of ChatGPT or another target site exposes a structured tool such as:

```text
send_message({ conversationId, text })
```

then Nika should prefer the site-native structured capability over DOM actuation.

But workflow code must not care which path was used.

### New abstraction: `SiteCapabilityProvider`

Recommended boundary:

```ts
interface SiteCapabilityProvider {
  probe(target: BrowserTarget): Promise<SiteCapabilities>;
  execute(command: SiteCommand): Promise<ActionResult>;
}
```

Implementations:

```text
WebMCPProvider
DomSiteProvider
```

Selection:

```text
probe WebMCP
  if compatible trusted tool exists -> WebMCPProvider
  else -> DomSiteProvider
```

For ChatGPT today, expect `DomSiteProvider` to remain authoritative unless live probing proves ChatGPT exposes a suitable WebMCP surface.

### Important security rule

Do not blindly trust every WebMCP tool exposed by arbitrary page content.

WebMCP's own security guidance recognizes prompt-injection and agent-safety risks. Nika should require:

- expected origin;
- expected tool name/schema;
- SiteProfile allowlist;
- explicit mutation classification;
- same Effect Journal and postcondition/evidence contract as DOM actions where feasible.

Structured tool exposure improves targeting; it does not eliminate authorization or side-effect accounting.

### Decision

**DESIGN THE ABSTRACTION NOW; DO NOT ADD THE DEPENDENCY NOW.**

No baseline WebMCP polyfill is needed for Nika's first release.

Add a feature probe later behind an experimental capability flag.

---

## 5. Open-source WebMCP implementations worth tracking

### `GoogleChromeLabs/use-webmcp-tool`

Chrome-maintained React hook for sites that expose tools. It feature-detects the experimental API and follows current spec changes.

Value to Nika: source-of-truth reference for current browser API shape, not a runtime dependency because Nika is the agent/consumer rather than the page author.

**Decision: REFERENCE.**

### `ripulio/web-mcp`

MIT monorepo containing:

- Chrome extension;
- MCP server;
- WebMCP polyfill;
- tool registry;
- DevTools support.

Value to Nika: useful reference for discovery/bridge architecture and capability exposure across extension/native boundaries.

Project is currently small; do not make it foundational.

**Decision: SPIKE/REFERENCE.**

### `WebMCP-org/npm-packages`

Provides polyfills, browser transports, extension tools and a smart DOM reader.

Value to Nika: track the WebMCP ecosystem and inspect its extension/tool transport boundaries, but avoid adopting a broad package set until the spec stabilizes.

**Decision: TRACK.**

---

## 6. Settled-action semantics: adopt now

A repeated pattern appears in newer browser automation runtimes:

```text
snapshot
-> action
-> fresh observation
-> prove settlement
```

This is stronger than ordinary automation libraries that equate a successful API call with a successful user-visible effect.

### `caveman-browse`

A particularly useful reference is `JuliusBrussee/caveman-browse`.

Its action API can return that the action is **not settled yet**, and it requires a focused re-snapshot to prove that the app updated. The runtime explicitly avoids claiming success when it has not observed success.

This maps almost exactly to our Nika SEND problem.

### `vercel-labs/agent-browser`

Also uses accessibility snapshots and refs. A click can fail because another element is covering the target, and the runtime instructs the caller to handle the covering modal/banner and take a fresh snapshot before retrying.

This supports our existing decision that `NO_EFFECT`, `BLOCKED`, and `WRONG_TARGET` must be first-class outcomes rather than generic exceptions.

### Recommended Nika action lifecycle

Replace binary action success with:

```text
PREPARED
DISPATCHED
PENDING_OBSERVATION
SETTLED_SUCCESS
NO_EFFECT
WRONG_EFFECT
BLOCKED
AMBIGUOUS
FAILED
```

For `SEND_MESSAGE`:

```text
PREPARED
  composer verified
  target conversation verified

DISPATCHED
  click/Enter issued

PENDING_OBSERVATION
  no conclusion yet

fresh snapshot
  -> intended user-message appears: SETTLED_SUCCESS
  -> composer unchanged + no message: NO_EFFECT
  -> wrong message/target changed: WRONG_EFFECT
  -> modal/error state: BLOCKED
  -> communication/crash before conclusion: AMBIGUOUS
```

This should become part of `ActionResultV1`.

### `settled` must not mean `idle`

Distinguish:

**Action settled** = we know what happened to the action.

**Chat idle** = ChatGPT has finished generating.

A SEND can become `SETTLED_SUCCESS` immediately after the new user-message is observed while the chat is still `GENERATING` for minutes.

This distinction improves throughput because the dispatcher can release the SEND side-effect boundary without waiting for the full response.

---

## 7. Cap'n Web and Comlink: future RPC options, not current extension messaging

### Comlink

GoogleChromeLabs Comlink is Apache-2.0, tiny, mature, and turns `postMessage`/MessagePort communication with Workers into proxy-style RPC.

It is useful if Nika later moves heavy storage/snapshot processing into dedicated Web Workers.

However, Comlink should not replace `@webext-core/messaging` for current background/content/popup communication because:

- Nika needs explicit command IDs and protocol versions;
- tab identity is part of the protocol;
- action results need schema validation;
- browser extension contexts have lifecycle semantics beyond generic Worker RPC.

**Decision: REFERENCE / possible worker-only dependency later.**

### Cap'n Web

Cloudflare's Cap'n Web provides capability-based bidirectional RPC over MessagePort, WebSocket and HTTP and supports streams, callbacks, pass-by-reference objects and promise pipelining.

It is powerful and is used by `do-runtime` for cross-worker communication.

Potential future use:

```text
extension <-> offscreen supervisor <-> dedicated worker
```

or:

```text
extension <-> local Windows relay
```

But it is unnecessary for the MVP command path and adds a more sophisticated capability model than Nika presently needs.

**Decision: REFERENCE; reconsider only when a real offscreen/local-relay transport is implemented.**

---

## 8. Offscreen document should remain a supervisor option, not workflow authority

`do-runtime` demonstrates a legitimate Chrome MV3 pattern:

```text
service worker
-> offscreen document supervisor
-> Web Worker actor runtime
```

This can survive service-worker eviction better for long-lived worker connections.

But Nika should not use an offscreen document merely to cheat MV3 into having a permanent background page.

Potential justified future uses:

- hold a local relay/WebSocket connection;
- supervise a dedicated storage/actor worker;
- clipboard operations;
- APIs requiring DOM/window context.

Not justified:

- source of truth for schedules;
- only copy of workflow state;
- endless timer loop.

Durable truth remains Dexie/IndexedDB.

---

## 9. Comparison table

| Candidate/pattern | Strength | Weakness | Nika decision |
|---|---|---|---|
| `do-runtime` | True browser actor semantics, gates, SQLite, alarms, MV3 example | Heavy, 0.x, FSL for original portions | Reference only |
| Actor-per-chat pattern | Eliminates same-chat mutation races conceptually | Must still persist/recover state | Adopt architecture |
| WebMCP | Site-declared structured tools, potentially much more reliable than DOM | Experimental draft/origin trial; site support unknown | Design provider boundary, no dependency |
| `use-webmcp-tool` | Chrome-maintained current API reference | Producer-side React hook, not Nika's use case | Reference |
| `ripulio/web-mcp` | MIT extension/server/polyfill implementation | Small/young ecosystem | Spike/reference |
| `caveman-browse` settled actions | Refuses to claim success without re-observation | External CLI/runtime, not extension-native Nika | Adopt semantics |
| `agent-browser` snapshots/coverage detection | Fresh refs and obstruction detection | Separate browser runtime | Reference |
| Comlink | Mature tiny Worker RPC | Too implicit for Nika browser-command protocol | Possible worker-only later |
| Cap'n Web | Powerful capability RPC, MessagePort/WebSocket | More complexity than current needs | Future bridge reference |
| TanStack Workflow | Type-safe durable append-only execution | Very young, server-focused stores today | Track for Nika Server |
| Weft | Browser/WebExtension durable workflow support | Pre-1.0 experimental browser surface | Spike only |

---

## 10. New Nika contracts from this cycle

### 10.1 `ChatActor`

Logical single-writer boundary keyed by `chatId`.

It does **not** require an actor library.

### 10.2 `SiteCapabilityProvider`

```text
WebMCPProvider
DomSiteProvider
```

Future extension to other sites becomes cleaner because workflow code depends on capabilities rather than DOM selectors.

### 10.3 `ActionSettlement`

Add explicit settlement status to every mutating action:

```ts
type ActionSettlement =
  | 'pending_observation'
  | 'settled_success'
  | 'no_effect'
  | 'wrong_effect'
  | 'blocked'
  | 'ambiguous';
```

### 10.4 `ObservationEvidence`

A successful action should include proof tied to a fresh snapshot/navigation epoch:

```ts
interface ObservationEvidence {
  snapshotId: string;
  navigationEpoch: number;
  conversationIdentity: string;
  beforeFingerprint?: string;
  afterFingerprint: string;
  matchedPostconditions: string[];
}
```

---

## 11. Implementation implications for the existing code

The current prototype `sendPrompt()` returns success immediately after clicking Send or dispatching Enter. That API should eventually become two layers:

```text
dispatchSend()
observeSendSettlement()
```

This is important because the first function may succeed while the second returns `AMBIGUOUS` after a context failure.

Likewise, the background workflow should not hold a single monolithic call until ChatGPT is idle. After SEND settlement it can persist:

```text
WAITING_FOR_RESPONSE
```

and release the runtime lane.

The logical chat actor still owns mutation ordering, while waiting/capture can be resumed from durable workflow state later.

---

## 12. Recommended next implementation/research sequence

1. Add `ActionSettlement` to the planned `ActionResultV1` schema.
2. Split SEND into `PREPARE -> DISPATCH -> OBSERVE` in the controlled ChatGPT fixture.
3. Add deterministic fixtures for:
   - successful SEND;
   - click with no effect;
   - modal covering Send;
   - wrong conversation after SPA navigation;
   - worker death after dispatch before observation;
   - user-message already present on recovery.
4. Introduce a lightweight `ChatActorCoordinator` abstraction keyed by `chatId`; back it with the already-planned Dexie lease/fencing + dispatcher rather than a new actor dependency.
5. Add `SiteCapabilityProvider` interface with only `DomSiteProvider` implemented initially.
6. Add a feature-detection-only WebMCP probe behind an experimental flag; do not use it for production mutations until a real target site and schema are verified.
7. Revisit Comlink/Cap'n Web only if Nika introduces an offscreen supervisor or dedicated Worker runtime.
8. Keep `do-runtime` as a conformance/pattern reference for actor gates, stale-reference fencing and durable alarm semantics.

---

## 13. Final recommendation

The architecture is converging on a stronger model:

```text
Schedules / workflows
        |
        v
Durable jobs
        |
        v
Dispatcher
        |
        v
ChatActor(chatId)   <- single-writer logical boundary
        |
        v
SiteCapabilityProvider
   |               |
   v               v
WebMCPProvider   DomSiteProvider
                    |
                    v
             SemanticSnapshot
                    |
                    v
             DISPATCH ACTION
                    |
                    v
             fresh observation
                    |
                    v
       SETTLED / NO_EFFECT / AMBIGUOUS
```

The highest-value lesson from the new open-source landscape is not to import another large framework. It is to adopt the semantics those frameworks have proven:

- **single-writer actors for per-target mutation ordering;**
- **structured site tools when the web platform/site provides them;**
- **fresh observation before claiming browser-side success.**

These three patterns fit Nika's existing Dexie/XState/semantic-adapter direction and reduce failure modes without making the extension substantially heavier.

## Sources reviewed

- `WebMCP-org/do-runtime`: https://github.com/WebMCP-org/do-runtime
- Chrome WebMCP overview: https://developer.chrome.com/docs/ai/webmcp
- Chrome WebMCP imperative API: https://developer.chrome.com/docs/ai/webmcp/imperative-api
- WebMCP draft: https://webmachinelearning.github.io/webmcp/
- `GoogleChromeLabs/use-webmcp-tool`: https://github.com/GoogleChromeLabs/use-webmcp-tool
- `ripulio/web-mcp`: https://github.com/ripulio/web-mcp
- `WebMCP-org/npm-packages`: https://github.com/WebMCP-org/npm-packages
- `JuliusBrussee/caveman-browse`: https://github.com/JuliusBrussee/caveman-browse
- `vercel-labs/agent-browser`: https://github.com/vercel-labs/agent-browser
- `GoogleChromeLabs/comlink`: https://github.com/GoogleChromeLabs/comlink
- `cloudflare/capnweb`: https://github.com/cloudflare/capnweb
- `TanStack/workflow`: https://github.com/TanStack/workflow
- `stevekinney/weft`: https://github.com/stevekinney/weft
