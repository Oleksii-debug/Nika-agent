# Determinism escalation, action cache invalidation, and mutation serialization

Date: 2026-08-24
Repository: `Oleksii-debug/Nika-agent`

## Executive decision

The next useful abstraction for Nika is not another autonomous browser agent. It is a **determinism escalation ladder** that keeps known workflows cheap and inspectable, and invokes semantic/AI resolution only when deterministic resolution genuinely fails.

Recommended policy:

`known SiteProfile locator -> live re-resolution -> postcondition -> fingerprint-assisted heal proposal -> semantic resolver -> AI resolver only as fallback -> autonomous agent never on critical mutating paths`

This cycle also confirms two runtime rules:

1. all mutating actions for one target/chat must be serialized;
2. cached actions/locators are hints, never authority. Every cached action must be revalidated against the current navigation epoch, page identity, semantic fingerprint, and postcondition contract before mutation.

---

## 1. Stagehand: useful as a design reference, not a production dependency inside the extension

Stagehand v3 provides an unusually clear automation spectrum:

- direct deterministic browser APIs for known navigation;
- `observe()` to resolve a natural-language intent into a concrete action;
- `act(Action)` to replay that concrete action without another LLM call;
- per-step AI actions when markup varies;
- a full autonomous agent only for genuinely open-ended tasks;
- self-healing and action caching for repeated production flows.

Official Stagehand material explicitly recommends atomic actions and reuse of `observe()` results with deterministic `act(action)` calls. Its current API exposes action caching and a self-healing mode. This is a strong architectural reference for Nika because it avoids reasoning again on every run.

However, Stagehand itself is designed around Playwright/Chromium automation and browser sessions, not MV3 service-worker durability or control of already-open user-owned ChatGPT tabs from a normal extension content-script architecture.

Decision: **do not add Stagehand to the Chrome-extension runtime**. Reuse its determinism spectrum as a policy model.

Sources:

- https://github.com/browserbase/stagehand
- https://github.com/browserbase/stagehand/blob/main/packages/docs/v3/references/act.mdx
- https://github.com/browserbase/skills/blob/main/skills/browser-use-to-stagehand/references/guide.md

---

## 2. Nika should have an explicit DeterminismLevel

Add an execution policy dimension such as:

```ts
type ResolutionLevel =
  | 'SITE_PROFILE'
  | 'CACHED_RECIPE'
  | 'FINGERPRINT_HEAL'
  | 'SEMANTIC_RESOLVE'
  | 'AI_RESOLVE'
  | 'AUTONOMOUS';
```

Recommended use:

### SITE_PROFILE

Known, versioned locator recipes and pre/postconditions. This is the normal ChatGPT path.

Example:

`role=button + accessibleName=Send`

with scope and page identity constraints.

### CACHED_RECIPE

A previously successful LocatorRecipe/action plan. It is replayable only after fresh validation.

### FINGERPRINT_HEAL

When the canonical locator fails, compare the current DOM with the known-good semantic fingerprint and produce a candidate repair.

### SEMANTIC_RESOLVE

Search the fresh accessibility/DOM snapshot by role, accessible name, label, relation, SiteSkill hints, form purpose, and local structure.

### AI_RESOLVE

Ask a model to rank/resolve candidates only if deterministic and semantic resolution cannot produce one safe target.

### AUTONOMOUS

Open-ended agent planning. This should be unavailable by default for critical SEND/forward/destructive workflows.

The runtime must record which level was required. This gives a useful reliability metric: a healthy SiteProfile should execute mainly at levels 1-2. A rising fallback rate is a compatibility warning before total failure.

---

## 3. Action caches are optimization, not truth

Stagehand's cached `observe -> act` pattern is valuable, but its current implementation/history also illustrates a limitation: generated actions have relied heavily on XPath, and structural DOM changes can invalidate those cached paths. A 2026 Stagehand issue specifically discusses preferring stable attributes because XPath-oriented caching is brittle under wrapper/reordering changes.

For Nika, a cached action must therefore include more than a selector:

```ts
interface CachedActionRecipe {
  capability: string;
  siteProfileVersion: string;
  navigationEpoch: number;
  conversationIdentity?: string;
  locator: LocatorRecipe;
  targetFingerprint: ElementFingerprint;
  preconditionId: string;
  postconditionId: string;
  successfulRuns: number;
  lastValidatedAt: string;
}
```

Before replay:

1. verify protocol/site profile version;
2. verify tab/document/navigation epoch;
3. resolve locator freshly;
4. require exactly one candidate;
5. compare semantic fingerprint;
6. run actionability/precondition checks;
7. dispatch;
8. verify the postcondition.

If any validation fails, discard the cache hit and escalate resolution. Never execute a stale cached DOM target simply because it worked previously.

Source:

- https://github.com/browserbase/stagehand/issues/1555

---

## 4. Fingerprint-based healing is worth implementing, but healing must propose rather than silently rewrite

Several open-source self-healing locator projects converge on a simple useful pattern: capture a known-good element fingerprint, then score the current DOM when the locator breaks.

Useful fingerprint dimensions:

- ARIA role;
- accessible name / aria-label;
- `data-testid`;
- stable id/name;
- input type;
- normalized visible text;
- form/region scope;
- nearby semantic labels;
- stable attributes;
- DOM relationships;
- optional geometric/location hints only at low weight.

The `self-healing-locator-agent` reference also demonstrates an important policy: return a confidence score and refuse low-confidence healing. `playwright-smart-locators` uses known-good DOM snapshots and emits a proposed healed file for review rather than silently rewriting the canonical test source.

This exactly matches Nika's previously chosen `SiteProfilePatchProposal` model.

Recommended thresholds:

- high confidence + strong postcondition: execute once as `VALIDATED_ONCE`, but do not modify canonical profile;
- medium confidence: require semantic/AI disambiguation or operator approval;
- low confidence/tie: fail closed as `TARGET_AMBIGUOUS`.

A wrong heal on SEND is much worse than an honest failure.

References:

- https://github.com/AbrarRagib/self-healing-locator-agent
- https://github.com/AxeForging/playwright-smart-locators
- https://github.com/KhvichaDev/kd-selector-heal

Decision: implement a small first-party fingerprint scorer rather than import one of these young/testing-oriented libraries.

---

## 5. AgentQL: useful conceptual reference for semantic queries, but not Nika's local runtime

AgentQL provides natural-language semantic selectors and structured extraction. Its main useful idea for Nika is separating *what the element means* from *how it is structurally located*.

Example intent:

`send_button`

instead of permanently encoding one CSS/XPath selector.

That semantic concept is valuable for SiteSkills, recorded workflows and generic form automation.

However, AgentQL is an AI-powered SDK/service-oriented automation stack around Playwright/browser sessions. Nika's core must keep working locally, deterministically, in user-owned Chrome tabs, without a required external semantic-query service.

Decision: **do not add AgentQL**. Borrow the semantic-query concept for `LocatorRecipe` and `FormSnapshot` naming.

Sources:

- https://github.com/tinyfish-io/agentql
- https://docs.agentql.com/concepts/query-language

---

## 6. FSB is the strongest new Chrome-extension architecture reference in this cycle

`fullselfbrowsing/FSB` is a current DOM-first MV3 Chrome-extension browser agent. It is especially relevant because it is not merely a Playwright/headless framework.

Useful architecture patterns found in FSB:

- popup + persistent Side Panel + options/control UI;
- MV3 background worker routing;
- content scripts that create DOM refs, execute actions and wait for stable state;
- DOM snapshots/deltas and ARIA/form data;
- explicit post-action verification;
- stuck/repeated-action detection;
- local MCP bridge that translates into the same extension runtime routes;
- diagnostics/doctor/status tools;
- site guides and procedural memory;
- manual tools preferred for auditability/recovery over a full autonomous loop;
- read-only operations can bypass the mutation queue;
- mutating tools are serialized to prevent simultaneous click/type/upload/navigation from multiple clients.

The most reusable invariant is:

> reads may be concurrent; mutations must pass through a serialization chokepoint.

This maps directly to Nika's per-chat actor/FIFO design.

FSB also explicitly verifies after actions and treats the browser as the source of truth. That independently confirms Nika's `DISPATCH -> OBSERVE -> SETTLED_*` contract.

But FSB is **not suitable for code reuse as a baseline dependency** for two reasons:

1. it currently stores/owns important running session state through its background-worker architecture rather than Nika's stronger crash-resumable Dexie model;
2. its current repository license is Business Source License 1.1, not permissive MIT/Apache code that should be copied into Nika.

So FSB is architectural research/reference only.

Source:

- https://github.com/fullselfbrowsing/FSB

---

## 7. Mutation serialization should become a formal runtime chokepoint

Nika already has the conceptual `ChatActor(chatId)` and per-chat FIFO. This cycle strengthens it into a capability-level rule.

Every capability gets an effect class:

```ts
type EffectClass = 'READ' | 'WRITE' | 'ADMIN';
```

Policy:

- `READ`: may run concurrently if it does not invalidate snapshot assumptions;
- `WRITE`: one at a time per target/chat;
- `ADMIN`: exclusive, explicit approval rules, and may need project/global exclusion depending on the operation.

Examples:

`status`, `snapshot`, `capture` -> READ

`send`, `fill`, `click`, `forward` -> WRITE

`reload`, `navigate away`, `CDP`, target rebind -> ADMIN/WRITE depending on semantics.

Implementation should keep two layers:

1. live in-process FIFO (`p-queue`) for efficiency;
2. durable Dexie lease + fencing token for authority and crash recovery.

The live queue must never replace the durable lease.

---

## 8. Introduce resolution telemetry and compatibility budgets

A new useful metric follows directly from the determinism ladder.

For each site/profile/capability, store counts such as:

- deterministic hit rate;
- cached-recipe hit rate;
- fingerprint-heal rate;
- semantic fallback rate;
- AI fallback rate;
- ambiguous target count;
- postcondition failure rate;
- average settle latency.

Example health policy:

- >= 98% SITE_PROFILE/CACHED_RECIPE success: HEALTHY;
- fallback rate above 5%: DEGRADED;
- AI resolution required for canary SEND: HOLD_BATCH;
- postcondition failure or ambiguous SEND: OPEN_CIRCUIT for that SiteProfile/chat.

This makes compatibility measurable instead of binary.

For a 50-chat batch, Nika can gate release based on the canary's resolution level. If the canary unexpectedly needs AI or healing for a previously deterministic Send button, the batch should pause instead of multiplying the risk across all chats.

---

## 9. Recommended ActionResolver architecture

```text
Capability request
    |
    v
SiteProfileResolver
    | success
    v
Fresh target validation
    | fail
    v
CachedRecipeResolver
    | fail
    v
FingerprintHealer
    | ambiguous/low confidence
    v
SemanticResolver
    | unresolved
    v
AIResolver (policy permitting)
    | unresolved
    v
FAIL CLOSED
```

For every successful branch:

```text
resolve
-> strict uniqueness
-> actionability/precondition
-> Effect Journal PREPARED
-> mutation FIFO + lease/fencing
-> DISPATCH
-> fresh observation
-> postcondition
-> SETTLED_SUCCESS / NO_EFFECT / WRONG_EFFECT / BLOCKED / AMBIGUOUS
```

No resolver is allowed to bypass postcondition verification.

---

## 10. Dependency decisions

### Keep/adopt

- WXT
- Dexie
- XState
- p-queue
- @webext-core/messaging
- dom-accessibility-api
- native MutationObserver / Web Locks / chrome.alarms

### Implement small first-party modules

- `ActionResolver`
- `ElementFingerprint`
- `FingerprintScorer`
- `ResolutionTelemetry`
- `CachedActionRecipe`
- `MutationGate`

### Reference only

- Stagehand
- FSB
- AgentQL
- self-healing-locator-agent
- playwright-smart-locators
- kd-selector-heal

### Do not add

- a full autonomous browser-agent framework inside the extension;
- an external semantic locator service as a requirement;
- silent self-healing that rewrites canonical SiteProfiles;
- persistent XPath-only action cache.

---

## 11. Next implementation spikes

1. Add `ResolutionLevel` and resolution telemetry to ActionResult/evidence.
2. Build `ElementFingerprint` from accessible role/name, stable attrs and local semantic scope.
3. Create deterministic fingerprint fixtures where class/wrapper/order change while element meaning stays constant.
4. Implement `CachedActionRecipe` with navigationEpoch/siteProfileVersion invalidation.
5. Build `MutationGate` and prove concurrent READ + serialized WRITE for one chat.
6. Create a forced stale-cache test: cached Send locator from old epoch must fail closed.
7. Create healing fixtures with two near-equal buttons and verify `TARGET_AMBIGUOUS`, not `.first()`.
8. Canary policy: batch must not release if deterministic resolution unexpectedly escalates to AI/healing.
9. Record metrics over repeated ChatGPT fixture runs to establish a compatibility budget.

## Final recommendation

Nika should not compete with general browser agents by adding more agentic reasoning. It should become more deterministic than them on known workflows.

The best production pattern observed this cycle is:

`deterministic skeleton + cached recipes + strict live revalidation + bounded semantic healing + AI only as escalation + serialized mutations + mandatory postconditions`.

That architecture gives Nika a controlled path through DOM drift without turning every click into an LLM decision and without silently accepting a wrong healed target.