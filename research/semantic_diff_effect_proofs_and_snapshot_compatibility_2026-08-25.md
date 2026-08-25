# Semantic diff effect proofs, snapshot compatibility, and no-op detection

Date: 2026-08-25
Repository: `Oleksii-debug/Nika-agent`

## Executive decision

Nika already moved away from blind retry for irreversible SEND, but its next reliability boundary is stronger: **browser actions need action-specific proofs derived from fresh semantic state, not only transport success and not only a generic `ok` result.**

The strongest reusable pattern found in current open-source browser-control projects is:

`fresh semantic snapshot -> action -> fresh semantic snapshot/diff -> classify observed effect -> settle`

This is materially better than:

`click -> returned successfully -> assume success`.

For Nika, the recommendation is to add a small native `SemanticDiffEngine` and `EffectProof` contract rather than adopt another full browser-agent framework.

The same research also sharpens snapshot-ref semantics:

- refs are ephemeral and scoped to one compatible snapshot generation;
- navigation/document changes invalidate refs immediately;
- significant DOM/semantic drift can invalidate refs even without navigation;
- a diff must be computed only between snapshots proven compatible;
- mutation settlement is action-specific: a generic DOM change is not enough.

The core runtime model becomes:

`PREPARE -> BASELINE -> DISPATCH -> OBSERVE -> DIFF -> PROVE -> SETTLE`

with outcomes:

`SETTLED_SUCCESS | NO_EFFECT | WRONG_EFFECT | BLOCKED | AMBIGUOUS`.

---

## 1. Live Nika code audit

### 1.1 SEND transport safety is now materially better

`src/runtime.ts` now assigns retry policy per command:

- `send -> none`
- `status -> read_only`
- `captureLatest -> read_only`

This correctly prevents a transport exception from triggering a second SEND. An uncertain SEND is surfaced as `SEND_UNCERTAIN`.

This is an important P0 improvement and should remain a permanent invariant.

### 1.2 But successful content-script return is still not an effect proof

Current `sendToAgent()` still treats a successful `contentCommand({type:'send'})` result as sufficient to append `prompt_sent`.

That leaves a second ambiguity class:

1. content script receives the command;
2. composer is modified;
3. click/Enter is attempted;
4. handler returns `{ok:true}`;
5. page ignores, blocks, redirects, displays an error, or target was semantically wrong.

Transport succeeded, but the external effect may not have occurred.

Therefore `prompt_sent` currently means closer to `SEND command accepted by content script` than `ChatGPT user-message observed`.

This should be split into at least:

`effect_dispatched`

and

`effect_settled_success`.

### 1.3 Current per-agent serialization remains process-local

`agentQueues = new Map<string, Promise<void>>()` is useful as a live optimization, but disappears when the MV3 service worker is terminated.

It cannot be the ownership primitive for mutations. Durable lease/fencing remains necessary.

### 1.4 Scheduler still bypasses durable admission

`entrypoints/background.ts` still builds one Chrome alarm per scheduled agent and invokes `runAgentNow()` directly when each alarm fires.

Therefore current scheduling still lacks the desired separation:

`schedule due -> durable Job -> fair/paced dispatcher -> mutation authority -> action`.

This remains a priority gap independently of the semantic-diff work.

### 1.5 WAIT remains polling based

`waitUntilIdle()` still performs a one-second status loop. The previously selected direction remains valid:

`MutationObserver/event hints + durable WaitCondition + reconciliation after restart`.

The semantic-diff work in this document gives that future `WaitCondition` a stronger evidence model.

---

## 2. Open-source pattern: snapshots must be treated as generations

Several current browser automation projects independently use short-lived refs rather than durable selectors.

### Browser Control by anomalyco

`anomalyco/browser-control` is particularly useful as a reference because it controls an existing logged-in Chromium session through an extension and local relay, close to Nika's long-term LocalBridge direction.

Its compact snapshot API has several relevant properties:

- `snapshot()` is the normal read-before-act primitive;
- `ref("e12")` resolves a control from the latest snapshot;
- refs fail closed after navigation or incompatible DOM drift;
- `snapshot({diff:true})` compares against a previous *compatible* snapshot;
- diff output exposes new/current refs rather than treating old refs as permanent identity;
- page text is treated as untrusted input;
- human handoff completion is followed by independent page verification.

The key idea for Nika is not to copy its Playwright/relay architecture. It is to copy the **snapshot compatibility discipline**.

Reference:

- https://github.com/anomalyco/browser-control
- https://github.com/anomalyco/browser-control/blob/main/skills/browser-control/SKILL.md

### browserclaw

`browserclaw` similarly defines refs as belonging to the snapshot that created them. After navigation or DOM changes, old refs are not considered durable handles and the caller is expected to take a new snapshot.

It also marks page-derived snapshot content as untrusted, matching Nika's `PageTrustEnvelope` direction.

Reference:

- https://github.com/idan-rubin/browserclaw

### BrowserControl (vision-first)

The separate `adityasasidhar/browsercontrol` project rebuilds element numbering after each action and explicitly states that element numbers expire after every action. Its rule is effectively:

> do not plan multiple mutations from one observation; act once, observe again.

Although its primary targeting is visual Set-of-Marks rather than semantic DOM, that lifecycle principle is valuable.

Reference:

- https://github.com/adityasasidhar/browsercontrol

### BAT

The 2026 BAT project is a particularly strong conceptual reference because it normalizes accessibility state after an action and detects a no-op by comparing before/after state rather than assuming a successful command produced an effect. It also uses fingerprint-based stale detection and a bounded escalation ladder.

Reference:

- https://sathvik.info/work/bat

### OpenDevBrowser

OpenDevBrowser continues to provide a mature `snapshot -> refs -> actions` model, backend-node resolution and target-scoped FIFO execution. It reinforces that refs and actions should be target-aware and that same-target mutations should not race.

Reference:

- https://github.com/freshtechbro/opendevbrowser

---

## 3. New Nika primitive: SnapshotGeneration

Nika should stop thinking of a semantic snapshot as only a tree payload.

Each snapshot should have an identity envelope similar to:

```ts
interface SnapshotGeneration {
  snapshotId: string;
  capturedAt: string;
  tabId: number;
  frameId: number;
  documentId?: string;
  navigationEpoch: number;
  conversationIdentity?: string;
  siteProfileVersion: string;
  adapterVersion: string;
  semanticHash: string;
  compatibilityKey: string;
}
```

The exact fields can evolve, but the semantics matter.

`compatibilityKey` should change when comparing old/new refs is unsafe. Likely inputs include:

- tab target identity;
- frame/document identity;
- navigation epoch;
- SiteProfile major/semantic version;
- semantic snapshot schema version.

A snapshot diff is legal only when compatibility is proven.

If compatibility is not proven:

`DIFF_BASELINE_INCOMPATIBLE`

and the runtime takes a full fresh snapshot instead of manufacturing a misleading diff.

---

## 4. Refs are recipes/provenance, not permanent object identities

Earlier research already selected Playwright-like `LocatorRecipe` rather than stored HTMLElement identity. This cycle refines the relation between recipe and ref.

Recommended distinction:

### LocatorRecipe

Longer-lived semantic instruction for finding a target again.

Examples:

- role `button`, accessible name `Send`, scoped to composer;
- role `textbox`, semantic purpose `message_body`;
- `data-testid=send-button` as a lower-level candidate.

### SemanticRef

Short-lived proof that a particular target was resolved in a particular snapshot generation.

Example:

```ts
interface SemanticRef {
  refId: string;
  snapshotId: string;
  targetRecipeId: string;
  semanticFingerprint: string;
  documentId?: string;
  navigationEpoch: number;
}
```

A mutation never executes merely because `refId` exists.

Immediately before mutation:

1. mutation permit is still valid;
2. current document/navigation identity matches;
3. recipe re-resolves;
4. strict uniqueness is satisfied;
5. live fingerprint is compatible;
6. action precondition still holds.

This is deliberately stricter than normal macro automation.

---

## 5. SemanticDiffEngine

The new reusable core should compare compact semantic snapshots, not raw HTML.

Raw DOM diffs are too noisy because modern React applications frequently mutate:

- generated classes;
- wrapper nodes;
- hydration markers;
- transient loading nodes;
- timestamps;
- telemetry-related attributes.

A semantic diff should instead compare normalized nodes such as:

```ts
interface SemanticNode {
  nodeKey: string;
  role?: string;
  accessibleName?: string;
  semanticPurpose?: string;
  textFingerprint?: string;
  state?: {
    disabled?: boolean;
    expanded?: boolean;
    selected?: boolean;
    checked?: boolean | 'mixed';
    busy?: boolean;
  };
  provenance: {
    documentId?: string;
    frameId: number;
    scope?: string;
  };
}
```

Diff output can be intentionally small:

```ts
interface SemanticDiff {
  added: SemanticNode[];
  removed: SemanticNode[];
  changed: SemanticNodeChange[];
  unchangedCount: number;
  beforeHash: string;
  afterHash: string;
}
```

The runtime should not store full snapshots forever. Store hashes + bounded evidence and retain full snapshots only for diagnostic windows or failures.

---

## 6. A generic DOM change is not a postcondition

This is the most important constraint.

Suppose Nika clicks Send and the page changes because:

- an unrelated toast appears;
- the sidebar updates;
- an advertisement/banner changes;
- a network status indicator toggles.

A non-empty DOM diff does **not** prove SEND succeeded.

Each mutating capability needs an `EffectProofSpec`.

Example:

```ts
interface EffectProofSpec {
  proofType: string;
  requiredObservations: string[];
  forbiddenObservations?: string[];
  settleWindowMs?: number;
}
```

For `SEND_MESSAGE`, proof should be approximately:

- a new user-message exists after the baseline message identity;
- normalized text/hash corresponds to intended prompt;
- message belongs to current conversation/document;
- composer is no longer in the pre-dispatch prepared state;
- no blocking/rate-limit/error state superseded the send.

Generation beginning can be useful supporting evidence, but should not be the only proof.

For `GENERIC_CLICK`, proof may be one of:

- target state changed as expected;
- expected element appeared/disappeared;
- URL/document changed according to the action contract;
- form validation state changed.

For `FILL_FIELD`:

- current semantic field value equals intended normalized value;
- field remains the same semantic target;
- validation has not rejected it.

Thus settlement is capability-specific.

---

## 7. EffectProof and settlement outcomes

Recommended result model:

```ts
type SettlementOutcome =
  | 'SETTLED_SUCCESS'
  | 'NO_EFFECT'
  | 'WRONG_EFFECT'
  | 'BLOCKED'
  | 'AMBIGUOUS';

interface EffectProof {
  effectId: string;
  actionType: string;
  outcome: SettlementOutcome;
  baselineSnapshotId: string;
  observedSnapshotId?: string;
  diffHash?: string;
  evidence: EvidenceItem[];
  settledAt: string;
}
```

Meaning:

### SETTLED_SUCCESS

Expected action-specific postcondition is positively observed.

### NO_EFFECT

Observation succeeded and establishes that the intended external effect did not occur.

This state is important because only here can some operations become safely retryable.

### WRONG_EFFECT

A mutation occurred, but it is not the expected one.

Example: click opened a menu instead of submitting.

### BLOCKED

The action could not proceed because a semantic blocker was observed: modal, disabled control, login requirement, rate limit, human-only gate, etc.

### AMBIGUOUS

Nika cannot prove whether the external effect occurred. No blind retry.

This is the state used for crash/channel loss after mutation when observation cannot establish outcome.

---

## 8. Retry policy becomes proof-aware

Current Nika already distinguishes `none` vs `read_only` at transport level.

The next layer should distinguish transport retry from action retry.

Suggested model:

```ts
type RetryClass =
  | 'READ_SAFE'
  | 'MUTATION_RETRY_IF_NO_EFFECT_PROVEN'
  | 'MUTATION_AMBIGUITY_SENSITIVE'
  | 'ADMIN_DESTRUCTIVE';
```

Examples:

- snapshot/status: `READ_SAFE`;
- opening a deterministic non-destructive accordion could potentially be `MUTATION_RETRY_IF_NO_EFFECT_PROVEN`;
- SEND/FORWARD: `MUTATION_AMBIGUITY_SENSITIVE`;
- reload/rebind with possible manual composer content: `ADMIN_DESTRUCTIVE`.

The critical improvement is:

`transport error` is not equivalent to `NO_EFFECT`.

Only an explicit post-recovery observation can produce `NO_EFFECT`.

---

## 9. Snapshot-diff compatibility and React rerenders

There are two failure modes to distinguish.

### Navigation incompatibility

Document/navigation identity changed.

Old refs must fail immediately.

### Structural incompatibility without navigation

React may replace the entire subtree while URL/document identity remains the same.

Old backend nodes or DOM references may vanish even though the logical page is unchanged.

Therefore compatibility should also consider a bounded semantic baseline/fingerprint.

If the structure changes beyond a threshold, Nika should not attempt a detailed line-by-line diff against the stale generation. It should produce:

`SNAPSHOT_REBASED`

then establish a new baseline.

This avoids false certainty from trying to map heavily rewritten trees.

---

## 10. Diff as an observability primitive

Semantic diff is useful beyond settlement.

It can power:

### Compact run logs

Instead of logging full DOM:

`+ user-message hash=...`

`- stop button`

`~ assistant message fingerprint changed`.

### Side Panel operator timeline

Readable NVDA-friendly events:

- `Нове повідомлення користувача підтверджено.`
- `Кнопка Stop зникла.`
- `Відповідь стабільна протягом 2 секунд.`

### Adapter degradation detection

If a known action suddenly produces large unexpected semantic diffs, mark adapter/site health degraded.

### Failure bundles

Store only relevant before/after semantic slices plus hashes instead of dumping private full page content.

This improves privacy and makes diagnostics substantially easier.

---

## 11. Comparison of approaches

| Approach | Strength | Weakness | Nika decision |
| --- | --- | --- | --- |
| Raw CSS/XPath + success return | Simple | brittle; no proof | Reject as mutation success model |
| Raw DOM HTML diff | Captures everything | extremely noisy; privacy/storage cost | Diagnostic only |
| Screenshot pixel diff | Works for canvas/visual UI | theme/zoom/layout noise; weak semantics | Optional fallback/diagnostics |
| Accessibility/semantic normalized diff | user-facing meaning; compact; screen-reader aligned | needs our normalization rules | **Adopt** |
| Playwright/browser-control snapshot diff | Mature reference semantics | external runtime / not extension-native | Reuse pattern, not dependency |
| Full autonomous browser-agent loop | flexible | non-deterministic and overpowered for known workflows | Escalation only |

The accessibility/semantic diff has an additional advantage for Nika: it aligns automation evidence with the same semantic information important for NVDA-oriented interaction.

---

## 12. Should Nika adopt a library for semantic diff?

No strong dependency is justified yet.

Existing libraries/frameworks generally bundle semantic snapshots with their own Playwright/CDP runtime. Nika's extension execution boundary needs:

- `documentId/navigationEpoch` provenance;
- SiteProfile semantics;
- ChatGPT-specific message identity;
- Effect Journal linkage;
- ActionPolicy;
- MV3 durable recovery.

A generic object-diff package would save little because the hard problem is normalization and proof semantics, not calculating array differences.

Therefore implement a small deterministic module ourselves and test it against independent browser oracles.

Potential dev/test oracles remain:

- `@testing-library/dom`;
- Playwright `getByRole`/ARIA snapshots;
- controlled fixtures.

---

## 13. New recommended modules

No new production dependency is required.

Add small Nika primitives:

### `SemanticSnapshot`

Compact normalized current UI state.

### `SnapshotGeneration`

Provenance/compatibility envelope.

### `SemanticDiffEngine`

Computes bounded meaningful before/after differences.

### `EffectProofSpec`

Capability-specific definition of what success means.

### `EffectProofEvaluator`

Evaluates observations/diffs and produces settlement.

### `SnapshotCompatibilityGuard`

Rejects diffs and stale refs across incompatible generations.

### `ObservationReconciler`

After restart/crash, gets a fresh snapshot and determines whether a pending effect can become `SETTLED_SUCCESS`, `NO_EFFECT`, or remains `AMBIGUOUS`.

---

## 14. SEND-specific target design

For ChatGPT, a robust first implementation should capture a baseline before dispatch:

- latest user-message identity/fingerprint;
- latest assistant-message identity;
- composer content fingerprint;
- generating/idle state;
- current conversation identity;
- snapshot/document/navigation provenance.

After dispatch, observe until one of these happens:

### Success candidate

A user-message newer than baseline appears and its normalized prompt fingerprint matches the intended prompt.

Then settle:

`SETTLED_SUCCESS`.

### Definite no-effect candidate

After a bounded observation/recovery window:

- no new user-message;
- composer still contains exactly the prepared prompt;
- no generating state began;
- no blocker/error occurred;
- document identity is compatible.

This may establish:

`NO_EFFECT`.

The runtime can then apply the capability's retry policy or require operator decision.

### Blocked candidate

Login/rate-limit/modal/disabled/error state is positively observed:

`BLOCKED`.

### Uncertain candidate

The document navigated, service worker died in the critical interval, page became unavailable, or evidence is inconsistent:

`AMBIGUOUS`.

Never convert ambiguity into automatic resend.

---

## 15. Testing strategy

The semantic-diff layer should have a deterministic fixture suite before use with live ChatGPT.

Required cases:

1. click generates expected semantic state change -> success;
2. click returns normally but page does nothing -> `NO_EFFECT`;
3. unrelated toast changes -> not success;
4. wrong dialog opens -> `WRONG_EFFECT`;
5. blocker appears -> `BLOCKED`;
6. target node is replaced by React but semantic identity stays equivalent -> re-resolve succeeds;
7. duplicate semantic targets appear -> `TARGET_AMBIGUOUS`;
8. navigation changes document -> old baseline is incompatible;
9. SPA rerender changes structure substantially -> snapshot rebases;
10. service-worker restart after dispatch but before observation -> reconciliation from durable effect;
11. intended user-message already exists after restart -> settle success without resend;
12. no user-message and exact prepared composer remains -> potential `NO_EFFECT` path;
13. same prompt text existed historically before baseline -> must not be confused with the new effect;
14. locale changes accessible name but SiteProfile candidate set still resolves correctly;
15. iframe/shadow provenance remains distinct.

For differential semantic testing, compare Nika resolution against Testing Library and Playwright where practical.

---

## 16. Updated implementation priority

The current research backlog is now large enough that new framework discovery should be secondary to implementation.

Recommended order:

1. Keep the existing one-shot SEND transport rule and regression tests.
2. Add Dexie and durable `effects` table.
3. Add Effect states: `PREPARED`, `DISPATCHING`, `PENDING_OBSERVATION`, settlement outcomes.
4. Add `SnapshotGeneration` and compatibility guard.
5. Implement minimal ChatGPT semantic baseline.
6. Implement `SemanticDiffEngine` for only the nodes needed by ChatGPT SEND/response first.
7. Implement `EffectProofEvaluator` for SEND.
8. Change `prompt_sent` logging to distinguish dispatch vs observed commit.
9. Add crash-after-click reconciliation fixtures.
10. Move per-agent authority to durable lease/fencing; keep in-memory queue only as fast local serialization.
11. Replace one-second wait polling with durable WaitCondition observers/reconciliation.
12. Replace per-agent alarm fan-out with durable due-job admission and paced dispatcher.
13. Expand generic semantic diff only after the ChatGPT path is proven.

---

## 17. Final stack decision from this cycle

No new large production dependency.

Keep:

- WXT;
- TypeScript;
- Dexie as selected durable store;
- XState for workflow/state-machine semantics;
- p-queue for live admission/pacing;
- `@webext-core/messaging` for typed extension transport;
- `dom-accessibility-api` for production semantic primitives;
- native MutationObserver/webNavigation/tabs APIs.

Use as architecture/reference material:

- anomalyco/browser-control;
- browserclaw;
- OpenDevBrowser;
- BAT;
- BrowserControl Set-of-Marks lifecycle.

The important reuse is **behavioral contract**, not code volume.

---

## Final conclusion

Nika's reliability should now be defined by evidence, not commands.

A browser mutation has three distinct facts:

1. Nika attempted to dispatch it.
2. The transport reported something.
3. The website entered the expected semantic state.

Only the third fact permits a successful workflow checkpoint.

Therefore the next runtime milestone should implement:

`durable effect + compatible before/after semantic snapshots + capability-specific proof`.

This closes the gap between "we stopped blind retries" and the much stronger property Nika actually needs: **after failures, rerenders and restarts, the system can explain what it knows happened, what it knows did not happen, and what remains genuinely ambiguous.**
