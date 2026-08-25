# Semantic query oracles, WebDriver BiDi transport, and runtime gap audit

Date: 2026-08-25
Repository: `Oleksii-debug/Nika-agent`

## Executive decision

This research cycle intentionally does not add another autonomous browser-agent framework.

The strongest new reuse opportunities are narrower and more valuable:

1. use `@testing-library/dom` as a **test oracle/reference implementation** for user-facing semantic queries, not as the production action engine;
2. keep `dom-accessibility-api` as the small production primitive for accessible-name/description computation;
3. treat WebDriver BiDi as the preferred future **server/browser-farm transport abstraction**, while keeping Chrome Extension DOM execution as the primary local runtime;
4. keep CDP as a privileged compatibility/diagnostic escape hatch rather than the architecture-wide browser API;
5. stop accumulating architecture research without closing the implementation gap: current `src/runtime.ts` still contains blind reload/retry for mutating commands, in-memory per-agent queues, and one-second idle polling.

The resulting boundary is:

`Extension runtime -> semantic DOM + explicit capabilities`

`Server/browser farm -> BrowserTransport interface -> BiDi first -> CDP fallback when required`

`Tests -> independent semantic oracles (Testing Library + Playwright)`

---

## 1. Current implementation gap is now larger than the research gap

The repository has accumulated a strong reliability model in research documents, but the current runtime still contains several prototype-era behaviors.

### 1.1 Mutating send still goes through generic reload/retry

Current `src/runtime.ts::contentCommand()` retries every recoverable command. On the first messaging failure it reloads the tab and then retries the same command.

That remains incompatible with the already accepted ambiguity-safe SEND contract.

A message-channel failure after `send.click()` does not prove that the browser side effect failed. Therefore `SEND_MESSAGE` cannot share a generic retry wrapper with a read-only `status` operation.

Required change:

```text
READ command
  -> retry-safe policy allowed

WRITE command before external effect
  -> bounded retry only if NO_EFFECT is proven

WRITE command after possible external effect
  -> observe/reconcile
  -> SETTLED_SUCCESS | NO_EFFECT | AMBIGUOUS
  -> never blind resend
```

The unconditional `chrome.tabs.reload()` is especially unsafe because it can destroy manually typed composer content.

### 1.2 Per-agent serialization is currently memory-only

The new `agentQueues: Map<string, Promise<void>>` is useful as an immediate live-process guard. It correctly reduces same-agent interleaving while the MV3 worker remains alive.

However it is not durable authority. A service-worker restart drops the map completely.

Therefore this implementation should be treated as a temporary `MutationGate` optimization only. The durable ownership layer remains:

`Dexie lease + fencing token + mutation permit`.

### 1.3 Idle detection is still service-worker polling

`waitUntilIdle()` currently polls the content script every second and uses `sleep(1000)` until the settle window elapses.

This contradicts the event-driven/durable-wait design already established in research.

Target design:

`content script MutationObserver / state classifier`

-> state-change notification when runnable

-> durable WAITING checkpoint in Dexie

-> absolute deadline

-> restart reconciliation if the worker or tab was suspended.

The service worker should not need to remain alive for the whole ChatGPT generation interval.

### 1.4 Current dependency graph is still intentionally minimal

`package.json` currently contains only WXT, TypeScript and Vitest as dev dependencies.

That means the research stack (Dexie, XState, p-queue, webext messaging, runtime schema validation, etc.) is still mostly architectural intent rather than merged baseline code.

This is now useful information: the next phase should prioritize narrow implementation spikes and tests rather than continue adding large dependency candidates.

---

## 2. Semantic DOM: use independent query oracles

Nika's production resolver must remain small, deterministic and tightly coupled to our target identity/postcondition model.

However, implementing semantic target resolution entirely from first principles creates a risk: subtle ARIA/name/role mistakes can look correct in local fixtures while disagreeing with mature ecosystem behavior.

The best mitigation is **differential testing**.

For the same DOM fixture, compare Nika's resolver against independent mature engines.

Recommended test oracles:

1. `@testing-library/dom`
2. Playwright `getByRole()` / locator behavior
3. browser accessibility/CDP snapshots only for selected diagnostics

No one oracle is perfect. Agreement among independent implementations is much stronger evidence than self-consistency.

---

## 3. `@testing-library/dom` is a strong test-only reuse candidate

### 3.1 Why it matters

DOM Testing Library is designed around querying pages the way users perceive them rather than implementation details.

Its `getByRole(role, {name})` handles implicit roles and accessible names and supports semantic state filters such as `selected`, `busy`, `checked`, `pressed`, `expanded`, heading level and value constraints.

This maps closely to Nika's `LocatorRecipe` concept.

Example differential fixture:

```text
Nika.resolve({ role: 'button', accessibleName: 'Send' })

vs

getByRole(container, 'button', { name: 'Send' })
```

If the two disagree, the fixture becomes a regression case that requires analysis.

### 3.2 Why it should not become the production action engine

`@testing-library/dom` is a testing package, not an automation runtime.

It has a larger dependency surface than `dom-accessibility-api`, including `aria-query`, formatting/debugging utilities and testing-oriented code.

More importantly, it does not solve Nika-specific requirements:

- `tabId/frameId/documentId/navigationEpoch` identity;
- stale-target invalidation;
- open Shadow DOM traversal policy;
- strict mutation authority;
- leases/fencing;
- postcondition evidence;
- ambiguous external side effects;
- durable recovery.

Therefore recommendation:

**Adopt as dev/test dependency when semantic resolver tests land. Do not ship it as the core locator runtime unless bundle measurements later prove that selective reuse is actually simpler.**

### 3.3 Testing Library has edge cases, so it is an oracle, not truth

Its public issue tracker still contains current edge cases around `inert`, password inputs, `aria-labelledby`, role behavior and related semantics.

That is not a reason to reject it. It is precisely why differential testing is valuable.

A mature oracle can still be wrong; Nika should fail closed when engines disagree on a mutating target rather than silently select a candidate.

Suggested result:

`SEMANTIC_ORACLE_DISAGREEMENT`

for selected development/canary checks.

---

## 4. Keep `dom-accessibility-api` as the production primitive

`dom-accessibility-api` remains a good baseline candidate because it is focused and zero-dependency. It computes accessible names/descriptions according to the W3C accessible-name specification and is validated against Web Platform Tests.

Its browser test status is strong but not perfect, which again argues for differential fixtures rather than assuming any library is a full browser accessibility tree implementation.

Recommended production responsibilities:

```text
compute accessible name
compute accessible description
small semantic descriptor creation
```

Nika should own the surrounding logic:

```text
composed-tree traversal
role derivation / explicit SiteProfile hints
strict candidate cardinality
TargetIdentity
fingerprints
postconditions
```

Do not add `aria-query` separately unless we actually need direct programmatic access to the WAI-ARIA role model. `@testing-library/dom` already consumes it in tests, and a duplicate production dependency would add little value today.

---

## 5. Proposed semantic differential-test matrix

Create a fixture suite covering at least:

### Basic semantic targeting

- explicit `role=button` + `aria-label`;
- implicit `<button>` role;
- `aria-labelledby` with nested content;
- duplicated accessible names;
- hidden and `aria-hidden` targets;
- disabled targets;
- `contenteditable` composer;
- textbox with placeholder and label.

### Modern application edge cases

- `inert` subtree;
- React re-render replacing the underlying node;
- wrappers added around the target;
- duplicated Send-like controls;
- locale change (`Send`, Ukrainian localized label, etc.);
- dynamically changing accessible name;
- target removed and recreated during resolution.

### Tree topology

- nested open Shadow DOM;
- iframe containing identical role/name;
- stale document after frame navigation;
- same locator recipe across two navigation epochs.

For every fixture:

```text
Nika resolver result
Testing Library result
Playwright result
expected contract result
```

Mutating actions require exactly one live target under the Nika contract even when an external oracle would permit a looser query.

---

## 6. WebDriver BiDi is becoming the correct future server transport

WebDriver BiDi is now a real W3C cross-browser automation effort rather than a theoretical future protocol.

The current editor's draft is dated 18 August 2026. Chromium maintains the `GoogleChromeLabs/chromium-bidi` implementation, which translates BiDi to CDP where necessary. Puppeteer already supports BiDi automation for Chrome and Firefox.

This gives Nika a useful future direction for browser-farm/server architecture.

Instead of making the future server API equal to CDP, define our own transport-neutral interface:

```ts
interface BrowserTransport {
  listContexts(): Promise<BrowserContextInfo[]>;
  navigate(target: TargetIdentity, url: string): Promise<NavigationEvidence>;
  snapshot(target: TargetIdentity): Promise<SemanticSnapshot>;
  perform(action: BrowserAction): Promise<TransportActionResult>;
  subscribe(events: BrowserEventSubscription): AsyncIterable<BrowserEvent>;
}
```

Potential implementations:

```text
ExtensionDomTransport   - current real logged-in Chrome
WebDriverBiDiTransport  - preferred future browser farm
CdpTransport            - Chromium-specific privileged fallback
```

The workflow/runtime should never depend directly on BiDi or CDP command names.

---

## 7. Why BiDi should not replace the Chrome Extension runtime

The local Nika use case is special:

- existing logged-in everyday Chrome;
- user-visible tabs;
- cooperative human handoff;
- browser-extension permissions;
- direct DOM/content-script integration;
- NVDA/operator Side Panel.

WebDriver BiDi normally belongs to an automation session controlled through a driver/browser transport. It does not automatically solve extension lifecycle, Side Panel control, existing-user-tab adoption or ChatGPT-specific semantic verification.

Therefore:

**Do not attempt to rewrite local Nika around WebDriver BiDi.**

Keep extension DOM control as Tier 0.

BiDi becomes relevant for:

- isolated browser profiles;
- Nika Server browser workers;
- cross-browser execution;
- remote browser sessions;
- standardized event subscriptions;
- reducing future hard dependence on Chromium-only CDP.

---

## 8. BiDi is not yet a complete CDP replacement

Puppeteer still uses CDP by default for Chrome because not all required CDP capabilities are represented in WebDriver BiDi yet.

The Chromium BiDi implementation itself exposes `BiDi+` extensions such as `goog:cdp.sendCommand`, which is a practical admission that some Chromium-specific capabilities still require CDP access.

Therefore the transport strategy should be capability based, not ideological:

```text
Standard capability available in BiDi
  -> use BiDi

Needed feature unavailable in BiDi but available in controlled Chromium worker
  -> use narrowly scoped CDP fallback

Privileged/raw CDP requested by workflow/page
  -> blocked unless explicit runtime policy allows it
```

This matches the capability-provider architecture already chosen for DOM/WebMCP/CDP.

---

## 9. BrowserTransport capability negotiation

Future server/bridge workers should publish a capability handshake rather than making workflows guess their backend.

Example:

```json
{
  "transport": "webdriver-bidi",
  "protocolVersion": "...",
  "browser": "chrome",
  "capabilities": {
    "browsingContext": true,
    "script": true,
    "networkEvents": true,
    "userPrompts": true,
    "cdpFallback": true,
    "accessibilitySnapshot": false
  }
}
```

`WorkflowCompiler` then resolves a high-level Nika capability into an implementation supported by that target.

A workflow must never encode `goog:cdp.sendCommand` or raw BiDi commands directly.

---

## 10. New recommendation: capability conformance tests

Once more than one transport/provider exists, implement the same behavioral contract suite against each provider.

For example:

`NavigateCapabilityContract`

`SemanticSnapshotCapabilityContract`

`ClickSettlementCapabilityContract`

`FormFillCapabilityContract`

`WaitConditionCapabilityContract`.

Run the same fixtures against:

```text
DomSiteProvider
Playwright test adapter
future WebDriverBiDiTransport
future CdpTransport
```

The important output is not whether low-level implementation calls differ. The output must satisfy the same high-level Nika evidence contract.

This is the cleanest way to prevent future server/browser-farm work from silently weakening the safety guarantees established in the extension.

---

## 11. Comparison summary

| Candidate | Best use in Nika | Adopt now? | Reason |
| --- | --- | --- | --- |
| `dom-accessibility-api` | production accessible name/description primitive | Yes, when resolver implementation starts | small, zero deps, focused |
| `@testing-library/dom` | semantic differential tests / oracle | Yes, test-only | mature user-facing role/name queries |
| `aria-query` | WAI-ARIA role metadata | No separate dependency yet | indirect dependency is sufficient for current need |
| Playwright locators | E2E semantic oracle / real-browser acceptance | Yes, test layer | mature live re-resolution/actionability |
| WebDriver BiDi | future server/browser-farm transport | Architecture now, implementation later | cross-browser standard and active ecosystem |
| Chromium BiDi mapper | reference/implementation infrastructure | No direct extension dependency | useful server-side/tooling building block |
| CDP | privileged Chromium fallback / diagnostics | Only behind explicit policy | powerful but browser-specific and high privilege |

---

## 12. Updated implementation priority

The research is now mature enough that implementation should dominate the next cycles.

Recommended order:

1. Remove generic mutating-command retry/reload from `src/runtime.ts`.
2. Introduce `EffectClass` / `RetryClass` in executable code.
3. Split SEND into `PREPARE -> DISPATCH -> OBSERVE -> SETTLE`.
4. Introduce durable job/effect/lease schema (Dexie spike).
5. Replace `waitUntilIdle()` polling with `WaitCondition` + content-script observer + durable reconciliation.
6. Keep in-memory `agentQueues` only as a live optimization; introduce durable fencing.
7. Implement small production `SemanticResolver` using `dom-accessibility-api`.
8. Add `@testing-library/dom` as test-only differential oracle.
9. Add Playwright E2E oracle fixtures.
10. Only after the extension execution contract is passing forced-crash tests, create `BrowserTransport` ADR/spike for WebDriver BiDi.

---

## 13. Acceptance gates for this research decision

Before semantic resolver is considered stable:

- Nika, Testing Library and Playwright agree on the normal role/name fixture matrix;
- known disagreements are explicitly documented and tested;
- duplicate Send-like targets fail closed;
- stale document/epoch always fails closed;
- React node replacement does not break a recipe that should remain semantically valid.

Before a future BiDi provider is accepted:

- same high-level capability contract passes against local fixture pages;
- browser-specific fallback is explicitly surfaced in evidence;
- raw protocol commands cannot be supplied by imported workflows;
- transport reconnect never turns an ambiguous WRITE into a blind retry;
- server/browser worker recovery preserves Nika effect semantics.

---

## Final conclusion

The useful open-source reuse boundary is becoming clearer.

Nika should not outsource its reliability model to a browser-agent framework. Instead it should borrow mature, narrow implementations where they are objectively better:

- W3C accessible-name computation from `dom-accessibility-api`;
- semantic query behavior as a differential oracle from Testing Library and Playwright;
- standardized remote browser transport from WebDriver BiDi when server-side browser workers arrive.

Everything that defines Nika's actual safety remains ours:

`TargetIdentity + leases/fencing + mutation authority + ambiguity handling + postconditions + durable workflow recovery`.

The next bottleneck is no longer finding libraries. It is converting the accepted contracts into executable code and forced-failure tests.