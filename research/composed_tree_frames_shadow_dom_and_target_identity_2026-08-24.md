# Composed-tree DOM, frame identity, Shadow DOM, and safe target resolution

Date: 2026-08-24
Repository: `Oleksii-debug/Nika-agent`

## Executive decision

Nika should stop treating a browser tab as one flat DOM document.

For a reliable general browser-automation runtime, the actual target space is:

`Tab -> Frame document -> open ShadowRoot subtree -> semantic target`

The current ChatGPT adapter mostly operates in the top document and therefore does not yet expose the full problem. However, many production web interfaces embed editors, payment widgets, account controls, rich components, authentication surfaces, support tools, or custom Web Components inside iframes and Shadow DOM.

The safe architecture is therefore to make frame/document identity and composed-tree traversal explicit before generic site automation expands.

Recommended target identity:

```text
BrowserTargetIdentity {
  tabId
  frameId
  documentId
  parentDocumentId?
  navigationEpoch
  frameUrl
  topLevelConversationIdentity?
}
```

A semantic locator must then be resolved **inside exactly one current BrowserTargetIdentity**.

The core invariant is:

> A mutating action is never allowed to reuse a DOM target across a document change, frame change, or stale navigation epoch.

---

## 1. Why `tabId` is insufficient

Chrome documents that `frameId` remains stable across multiple navigations of a frame, while the document hosted inside that frame can change. Chrome therefore exposes `documentId` as a unique identifier for a particular document. `webNavigation` events also expose `parentDocumentId`, `parentFrameId`, frame type and document lifecycle.

This matters because this sequence is possible:

1. Nika resolves a Send-like button in frame 3.
2. The iframe navigates internally.
3. `frameId` can still be 3.
4. The old document is gone and a different document occupies the frame.
5. A cached target associated only with `tabId + frameId` is now stale.

For Nika, the minimum durable target key should therefore be:

`tabId + frameId + documentId + navigationEpoch`.

`documentId` is the browser-level identity; `navigationEpoch` remains our runtime invalidation counter and also covers SPA/site-profile changes where a new semantic context may exist without a traditional full document navigation.

Chrome source/documentation:

- https://developer.chrome.com/docs/extensions/reference/api/webNavigation

Key Chrome behavior:

- main frame has `frameId = 0`;
- child frames have positive frame IDs;
- `documentId` changes when a frame receives a new document;
- `parentDocumentId` can identify the owning document;
- `onHistoryStateUpdated` covers History API navigation;
- BFCache restoration may not emit `DOMContentLoaded`, so readiness cannot depend exclusively on that event.

### Decision

Add `FrameDocumentIdentity` as a first-class runtime primitive instead of extending ad-hoc `tabId` arguments everywhere.

---

## 2. Frame tree should be observable, not guessed from DOM alone

A generic adapter should not infer its complete frame topology only by scanning `<iframe>` elements in the top document.

Chrome already provides:

```text
chrome.webNavigation.getAllFrames({ tabId })
chrome.webNavigation.getFrame(...)
```

and navigation events with frame/document identity.

Recommended `FrameRegistry` materialized view:

```text
FrameRecord {
  tabId
  frameId
  documentId
  parentFrameId
  parentDocumentId?
  url
  lifecycle
  observedAt
}
```

The registry should be reconstructible at any time. It is not permanent truth and does not need event-sourcing complexity.

Important rule:

> Frame topology is runtime observation; Job/Effect state is durable truth.

If the service worker dies, Nika rebuilds the FrameRegistry and reconciles jobs against new document identities.

---

## 3. Content scripts: top frame by default, selected all-frame support later

WXT exposes the Chrome content-script capabilities we need directly:

- `allFrames`
- `matchAboutBlank`
- `matchOriginAsFallback`
- `world`
- runtime or manifest registration

Sources:

- https://wxt.dev/api/reference/wxt/interfaces/isolatedworldcontentscriptdefinition
- https://wxt.dev/guide/essentials/entrypoints

WXT defaults `allFrames` to false, which is appropriate for the current ChatGPT-specific content script.

I do **not** recommend immediately changing the existing ChatGPT content script to `allFrames: true`.

Reasons:

1. ChatGPT does not currently require broad subframe automation for its primary composer/assistant flow.
2. Every injected frame creates another messaging endpoint and another lifecycle surface.
3. Generic all-frame injection can increase ambiguity if a site contains several similar controls in different frames.
4. Cross-origin frame permissions need to remain explicit.

Instead introduce a future `FrameStrategy` in SiteProfile:

```text
TOP_ONLY
MATCHING_FRAMES
EXPLICIT_FRAME_RECIPE
ALL_ALLOWED_FRAMES
```

Default:

`TOP_ONLY`.

---

## 4. `matchOriginAsFallback` is useful but must not silently widen execution authority

Chrome MV3 can inject content scripts into related `about:`, `data:`, `blob:` and `filesystem:` frames by using `match_origin_as_fallback`. WXT exposes this as `matchOriginAsFallback`.

Chrome also changed `chrome.scripting.executeScript({ allFrames: true })` behavior in Chrome 133 to use match-origin-as-fallback-style matching by default, which can result in injection into more related frames than older code expected.

Chrome Extensions DevRel announcement:

- https://groups.google.com/a/chromium.org/g/chromium-extensions/c/D8DcJARVM90

This is a subtle security/reliability point.

For Nika:

`frame can technically receive content script` does **not** imply `frame is approved as an automation target`.

The target must still pass:

- SiteProfile origin/path policy;
- FrameStrategy;
- current `documentId` check;
- semantic target resolution;
- ActionPolicy approval;
- postcondition.

---

## 5. Shadow DOM: use composed-tree semantics, not one giant deep CSS selector

Playwright provides a very useful reference behavior: most of its locators automatically work through **open Shadow DOM** while XPath does not pierce shadow roots. It still does not support closed shadow roots.

Source:

- https://playwright.dev/docs/locators

This supports a key architectural decision for Nika:

> Shadow-root traversal belongs inside the semantic resolver, not inside SiteProfile as long chains of `.shadowRoot.querySelector(...)` calls.

A `LocatorRecipe` should remain semantic:

```text
role=button
accessibleName="Send"
scope=form/composer
```

The resolver can walk open shadow roots while evaluating that recipe.

Do not encode targets as:

```text
x-app$ x-toolbar$ div:nth-child(4) > button
```

unless used only as a low-confidence fallback.

---

## 6. Open-source Shadow DOM libraries compared

### 6.1 `shadow-dom-selector`

Repository:

- https://github.com/elchininet/shadow-dom-selector

Current npm package observed during this research: `6.2.3`, Apache-2.0, TypeScript declarations included.

Capabilities:

- normal shadow-aware query selection;
- recursive deep query;
- sync and async APIs;
- explicit traversal through nested open shadow roots.

Strengths:

- current maintenance;
- very small scope;
- permissive license;
- TypeScript;
- could save us from writing CSS-oriented shadow traversal primitives.

Weaknesses for Nika:

- it remains primarily a **CSS selector** engine;
- `deepQuerySelector()` can be expensive on large DOMs;
- it does not provide our semantic role/name resolution, frame identity, evidence, strict mutation contract, or postcondition model.

Decision:

**Reference / optional utility spike, not baseline dependency yet.**

If we later need explicit CSS fallback through complex Web Components, this is the best currently active small candidate I found.

### 6.2 `query-selector-shadow-dom`

This older library pioneered deep `querySelector` across shadow roots and is MIT. The maintained ecosystem status is much weaker: the package line is old and several package mirrors describe it as effectively abandoned.

Decision:

**Do not adopt.** Its concepts are useful, but the newer `shadow-dom-selector` is a better candidate if we need one.

### 6.3 `shadow-dom-testing-library`

Repository:

- https://github.com/KonnorRogers/shadow-dom-testing-library

It extends Testing Library with `getByShadowRole`, `findByShadowLabelText`, and similar queries.

Its strongest value for Nika is not runtime production code but testing:

- fixtures containing Web Components;
- semantic tests that prove role/name queries work through open roots;
- regression comparison with our own composed-tree resolver.

Decision:

**Potential test-only dependency**, not production resolver.

---

## 7. Closed Shadow DOM must be treated as a capability boundary

Normal page JavaScript cannot traverse a `mode: "closed"` shadow root via `element.shadowRoot`.

Therefore DOM automation should not pretend all Web Components are equivalent.

Suggested capability result:

```text
OPEN_SHADOW_DOM_SUPPORTED
CLOSED_SHADOW_DOM_OPAQUE
```

If a critical control exists only inside a closed root, allowed escalation paths are explicit:

1. site-provided structured capability (WebMCP or page API);
2. narrowly justified MAIN-world/page bridge if the application exposes a usable public hook;
3. read-only CDP Accessibility/DOMSnapshot spike;
4. privileged CDP action only if product policy explicitly enables it;
5. otherwise fail closed.

We should **not** monkey-patch `attachShadow()` globally as baseline behavior. That pattern is invasive, timing-sensitive and can break page assumptions.

---

## 8. Cross-origin iframe automation is a permissions problem as well as a DOM problem

A same-origin iframe and a cross-origin iframe look similar visually but have very different DOM access rules.

Nika's content script inside one frame can inspect that frame's DOM, but the top-frame script cannot arbitrarily traverse another origin's document.

The correct model is therefore not:

`top content script recursively reads everything`.

It is:

`one frame endpoint per permitted document`.

Conceptually:

```text
Background / Dispatcher
  -> target FrameDocumentIdentity
      -> content endpoint in that document
          -> semantic resolver
          -> action / snapshot
```

This is another reason to make `frameId/documentId` part of BrowserCommandV1 rather than hiding frame selection inside a CSS selector.

---

## 9. BrowserCommand should explicitly identify the target document

Future command envelope:

```text
BrowserCommandV1 {
  protocolVersion
  commandId
  target: {
    tabId
    frameId
    documentId
    navigationEpoch
  }
  operation
  payload
}
```

On receipt, the content endpoint validates:

1. it is running in the expected frame/document;
2. protocol versions match;
3. context is not invalidated;
4. navigation epoch/site identity match;
5. only then does it resolve the locator/action.

If identity does not match:

```text
TARGET_DOCUMENT_STALE
TARGET_FRAME_MISSING
TARGET_FRAME_REPLACED
```

No blind reroute to the first frame that happens to contain a matching button.

---

## 10. A global semantic snapshot should be a graph, not flattened HTML

For generic web automation, eventually Nika may need a tab-wide view.

Do not flatten all frame DOM and Shadow DOM into one synthetic HTML string. That loses crucial trust and navigation boundaries.

Use a graph-like snapshot:

```text
TabSnapshot
  DocumentNode(top, documentId=A)
    SemanticNode(...)
    ShadowRootNode(hostRef=...)
      SemanticNode(...)
    FrameEdge(frameId=4, documentId=B)
      DocumentNode(...)
        SemanticNode(...)
```

Every semantic ref carries a document scope.

Benefits:

- duplicate "Submit" buttons in different frames remain distinguishable;
- evidence can identify exactly where an action occurred;
- stale-document invalidation becomes cheap;
- SiteSkill can describe frame transitions explicitly;
- future accessibility/CDP data can be attached without collapsing security boundaries.

Suggested ref form:

```text
ref = doc:<shortDocumentId>/node:<localRef>
```

The serialized identifier can remain compact; the important part is that scope is explicit.

---

## 11. Playwright's FrameLocator is the right conceptual reference

Playwright `FrameLocator` represents a recipe for locating a frame and then locating an element within it. It is strict and fails if multiple frames match unless the caller intentionally disambiguates.

Source:

- https://playwright.dev/docs/api/class-framelocator

This maps cleanly to Nika's deterministic-first philosophy.

Suggested new recipe type:

```text
FrameRecipe {
  originPattern?
  urlPattern?
  accessibleName?
  parentFrameRecipe?
  iframeElementLocator?
}
```

Then:

```text
TargetRecipe {
  frame: FrameRecipe | TOP_FRAME
  locator: LocatorRecipe
}
```

Again, the recipe is not a live object. It is re-resolved against current frame/document state before every mutating action.

---

## 12. Frame and Shadow DOM resolution must remain strict

The existing strictness principle now applies at three layers:

### Frame selection

- 0 matching permitted frames -> `FRAME_NOT_FOUND`
- 1 -> continue
- 2+ -> `FRAME_AMBIGUOUS`

### Semantic locator

- 0 -> `TARGET_MISSING`
- 1 -> continue
- 2+ -> `TARGET_AMBIGUOUS`

### Postcondition

- proven effect -> settled success
- proven no effect -> retry only if policy permits
- unknown -> ambiguous

No `.first()` fallback across frames or shadow roots for mutating actions.

---

## 13. MutationObserver needs a ShadowRoot-aware observation plan

A `MutationObserver` attached to `document` does not magically observe every independently rooted shadow subtree in the way a generic composed-tree observer would need.

If Nika later needs to track dynamic Web Components, the observer layer should:

1. discover relevant open shadow roots;
2. attach observers only to roots participating in the current capability;
3. detect newly attached relevant open roots;
4. remove observers on document/context invalidation;
5. treat observers as fast signals, never durable truth.

Do **not** observe every node of every root across dozens of tabs permanently.

The current rule still stands:

`MutationObserver = opportunistic event source`

`fresh semantic snapshot = truth for action settlement`.

---

## 14. `aria-query`: useful data, but probably redundant in production

`aria-query` provides programmatic mappings for the WAI-ARIA roles model and implicit HTML role relationships. It is Apache-2.0 and very widely used.

Source:

- https://www.npmjs.com/package/aria-query

However Nika already selected `dom-accessibility-api`, which computes accessible names/descriptions and is closer to the actual semantic target problem.

Decision:

- do not add `aria-query` as another production dependency unless our resolver needs explicit role metadata not already available through current tooling;
- it can still be useful indirectly in test tooling or as a reference source.

This follows the continuing rule: avoid duplicate libraries that solve adjacent portions of the same accessibility problem.

---

## 15. Recommended architecture additions

No large framework change is needed.

Add small primitives:

```text
FrameDocumentIdentity
FrameRegistry
FrameRecipe
TargetRecipe
ComposedTreeWalker
ShadowRootRegistry
FrameScopedSemanticSnapshot
```

Extend:

```text
BrowserCommandV1.target
SemanticRef.scope
ActionEvidence.targetIdentity
```

Current stack remains:

```text
WXT
TypeScript
Dexie
XState
p-queue
@webext-core/messaging
dom-accessibility-api
native MutationObserver
chrome.webNavigation
chrome.scripting
```

Possible future small test/runtime candidates:

```text
shadow-dom-testing-library   -> tests
shadow-dom-selector          -> only if our CSS fallback really needs it
```

Do not adopt now:

```text
query-selector-shadow-dom    -> old/weak maintenance
another full browser-agent framework
full Playwright in production extension
```

---

## 16. New fixture matrix

Before Nika claims generic web-interface support, create controlled fixtures for:

### A. Open Shadow DOM

- button inside one open root;
- nested open roots;
- duplicate button outside and inside root;
- root replaced after React/WebComponent rerender.

Expected:

fresh semantic resolution still finds the correct target; cached live nodes are never reused.

### B. Closed Shadow DOM

Expected:

`CLOSED_SHADOW_DOM_OPAQUE`, then explicit escalation/fail-closed.

### C. Same-origin iframe

- top page and frame both have `Submit`;
- target recipe explicitly selects frame.

Expected:

no cross-frame ambiguity.

### D. Cross-origin iframe with permission

Expected:

frame endpoint receives command and reports exact `documentId`.

### E. Cross-origin iframe without permission

Expected:

`FRAME_NOT_ACCESSIBLE`, not silent failure or top-frame fallback.

### F. iframe navigation preserving frameId

1. resolve target in document A;
2. navigate same iframe to document B;
3. attempt action with A identity.

Expected:

`TARGET_DOCUMENT_STALE`.

### G. SPA change inside frame

Expected:

navigation epoch invalidates semantic refs even if the physical document remains.

### H. BFCache restore

Expected:

reconciliation does not depend only on DOMContentLoaded.

---

## 17. Implementation priority

This is not ahead of the current durable SEND work, but it should be implemented before broad generic-site automation.

Recommended order:

1. Finish Dexie Job/Effect/Lease foundations.
2. Add protocol/document versioning already planned.
3. Add `FrameDocumentIdentity` to BrowserCommand.
4. Build `FrameRegistry` from `webNavigation`.
5. Add top-frame `TargetRecipe` support without changing current ChatGPT behavior.
6. Implement composed-tree traversal for open Shadow DOM.
7. Add frame-scoped semantic snapshots.
8. Add strict `FrameRecipe` resolution.
9. Run the fixture matrix above.
10. Only then enable generic SiteProfiles that target child frames or Web Components.

---

## 18. Final decision table

| Component / approach | Decision | Reason |
|---|---|---|
| `chrome.webNavigation` frame/document identity | Adopt | Browser-native identity and navigation lifecycle |
| `documentId` in target contract | Adopt | Prevent stale frame/document actions |
| WXT `allFrames` | Selective | Useful, but too broad as universal default |
| `matchOriginAsFallback` | Selective | Needed for related opaque frames, but widens injection surface |
| Playwright FrameLocator model | Reuse concept | Strict frame recipe is excellent; no production Playwright needed |
| Playwright open-shadow locator behavior | Reuse concept | Correct model for semantic composed-tree resolution |
| `shadow-dom-selector` | Spike only | Current, small, permissive; mostly CSS-oriented |
| `query-selector-shadow-dom` | Reject | Older/weak maintenance |
| `shadow-dom-testing-library` | Test candidate | Good semantic Shadow DOM fixture coverage |
| Closed-shadow monkey patching | Reject baseline | Invasive and brittle |
| Flatten all frames/shadows into one HTML string | Reject | Loses identity/security/staleness boundaries |
| Frame-scoped semantic graph | Adopt design | Preserves provenance and enables reliable invalidation |

---

## Final architectural rule

For Nika, a browser element is never identified merely by a selector.

It is identified by:

```text
current tab
+ current frame
+ current document
+ current navigation epoch
+ current semantic locator recipe
+ fresh resolution
+ strict uniqueness
+ postcondition evidence
```

Shadow DOM only changes how the locator is resolved. Iframes change the document authority itself.

That distinction should become part of the runtime before Nika expands from a ChatGPT-specific automation system into a broad web-interface automation platform.
