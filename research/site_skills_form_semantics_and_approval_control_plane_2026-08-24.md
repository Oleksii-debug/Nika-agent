# Site skills, whole-form semantics, and approval-aware browser control

Date: 2026-08-24
Repository: `Oleksii-debug/Nika-agent`

## Executive decision

This research cycle compared two recent MV3 browser-agent implementations that are unusually close to Nika-agent's product direction: `Shijou87/Brow` and `amun-ai/hypha-navigator`, with `OpenDevBrowser` and `agent-browser` as additional reference points.

The strongest reusable ideas are not a new framework. They are four architectural boundaries that Nika should adopt:

1. **Site knowledge must be a first-class, versioned capability layer**, separate from raw DOM selectors.
2. **Forms should be modeled as semantic units**, not as unrelated input boxes.
3. **Model visibility and execution permission must be separate**, especially for mutating tools.
4. **The side panel should be a true operator control plane**, while background/content runtimes own execution and DOM semantics.

The baseline runtime remains WXT + TypeScript + Dexie + XState + p-queue + typed messaging. This cycle does not justify adding LangGraph, Hypha RPC, or another browser-agent framework to the extension.

---

## 1. Brow: the most relevant current reference for Nika's in-browser architecture

`Shijou87/Brow` is an Apache-2.0 experimental MV3 browser agent that runs inside the user's real Chrome session and uses the side panel as its product surface.

Its runtime is split into:

- side panel: UI coordination, approval flow, workflow staging;
- agent runtime: tool assembly and model execution;
- background service worker: tab lifecycle, discovery and routing;
- content script: semantic Browser Snapshots, workflow recording and DOM execution;
- shared contracts/storage.

This split is very close to what Nika should converge on.

The important part is not LangGraph. The useful part is the ownership boundary: **background does routing, content script owns DOM semantics, side panel owns operator interaction, shared contracts define the wire and storage model**.

Source:
- https://github.com/Shijou87/Brow
- https://github.com/Shijou87/Brow/blob/main/docs/maintainer-architecture.md

### Decision for Nika

Keep these boundaries explicit:

```text
SidePanel
  -> Operator state, approvals, queue visibility, diagnostics

Background service worker
  -> Scheduler wake-up, dispatcher, tab lifecycle, message routing

Content script / SiteAdapter
  -> Snapshot, locator resolution, DOM actions, postconditions

Dexie
  -> Durable truth
```

Do not let the Side Panel become the durable workflow runtime just because it has a longer visible lifetime.

---

## 2. Whole-form semantics are worth adopting

Brow exposes a `browser_form_snapshot` rather than treating every input independently.

Its form model includes:

- hidden/offscreen field metadata;
- inferred field purposes;
- safe current values;
- validation cues;
- combobox selection state;
- popup option refs;
- submit semantics.

This is significantly stronger than the normal automation loop:

```text
find textbox -> type
find textbox -> type
find checkbox -> click
find submit -> click
```

For Nika, this matters beyond ChatGPT. Once generic web workflows are supported, forms are one of the most common automation surfaces.

### Proposed Nika contract

```ts
interface FormSnapshot {
  formId: string;
  navigationEpoch: number;
  fields: FormField[];
  submitTargets: LocatorRecipe[];
  validationSummary: ValidationCue[];
}

interface FormField {
  fieldId: string;
  purpose: FieldPurpose | 'unknown';
  label?: string;
  role?: string;
  required: boolean;
  currentValue?: SafeValue;
  validation?: ValidationCue[];
  locators: LocatorCandidate[];
}
```

The critical design choice is `purpose`, not just raw label text.

Example field-purpose vocabulary:

- `email`
- `full_name`
- `first_name`
- `last_name`
- `phone`
- `address_line_1`
- `city`
- `country`
- `search_query`
- `message_body`
- `unknown`

For ChatGPT specifically, the composer can be modeled as `message_body`, but ChatGPT remains handled by a site-specific adapter because SEND has stronger ambiguity and postcondition rules than a generic form submit.

### Decision

Add `FormSnapshot` only after the core ChatGPT runtime is durable. Do not add another library yet; Brow's implementation is a design/code-reading reference first.

Source:
- https://github.com/Shijou87/Brow/blob/main/docs/extension-features.md

---

## 3. Site-specific skills should be promoted into a real Nika subsystem

Hypha Navigator and Brow both independently implement reusable site-specific knowledge.

Hypha Navigator stores **per-origin site skills** and automatically exposes the site's skill index alongside operation results. Brow has user-managed Domain Skills with domain/path/page matching, plus built-in Interaction Skills.

This matches a problem Nika will otherwise solve badly with growing code branches and selector tables.

### Why a SiteSkill is different from a SiteProfile

A `SiteProfile` should remain deterministic machine configuration:

- URL matchers;
- capabilities;
- selectors/locator recipes;
- health probes;
- adapter version;
- known blockers;
- completion rules.

A `SiteSkill` is procedural knowledge:

- how to perform a workflow on this site;
- which surface to prefer;
- common edge cases;
- recovery hints;
- human-readable instructions;
- optional reusable examples.

So:

```text
SiteProfile = executable site contract
SiteSkill   = reusable procedural knowledge
```

They should not be merged into one object.

### Candidate portable format: Agent Skills

The open Agent Skills specification uses a `SKILL.md` with required `name` and `description`, optional metadata/resources/scripts, and progressive disclosure. The current specification is maintained openly and has a validation reference implementation.

This is attractive for Nika because site knowledge could later be exported/imported without inventing a proprietary Markdown format.

Possible Nika skill layout:

```text
chatgpt-research-workflow/
  SKILL.md
  references/
    chatgpt-ui-notes.md
  assets/
    example-workflow.json
```

But Nika should not execute arbitrary skill scripts from imported skills by default. Imported skills are untrusted content.

### Security rule

SiteSkill activation does **not** grant permissions.

A skill may describe that a SEND is useful, but ActionPolicy and user approval still decide whether SEND is executable.

Sources:
- https://github.com/amun-ai/hypha-navigator
- https://github.com/agentskills/agentskills
- https://agentskills.io/specification

---

## 4. Human approval must be a policy layer, not UI decoration

Brow separates what the model can see from what it may execute. It also approval-gates untrusted MCP app rendering and agent-generated skill proposals.

This is a strong pattern for Nika.

Nika already needs different safety levels for operations:

```text
READ
WRITE
ADMIN / RECOVERY
```

This should become a real `ActionPolicy` contract.

### Proposed model

```ts
type ApprovalMode =
  | 'auto'
  | 'once_per_run'
  | 'once_per_site'
  | 'always'
  | 'blocked';

interface ActionPolicy {
  capability: Capability;
  retryClass: RetryClass;
  approvalMode: ApprovalMode;
  requiresFreshSnapshot: boolean;
  requiresPostcondition: boolean;
}
```

Examples:

```text
READ_SNAPSHOT
  approval = auto

SEND_MESSAGE to explicitly configured Nika agent chat
  approval = auto or once_per_run

Generic form submit on unknown site
  approval = always

Reload tab containing unsent user text
  approval = always

Raw CDP execute_script
  approval = blocked by default
```

### Important invariant

**The model may know a tool exists without automatically having authority to run it.**

This is useful even when Nika is not LLM-driven. It creates a clean boundary between workflow definition and actual browser authority.

Source:
- https://github.com/Shijou87/Brow/blob/main/docs/extension-features.md

---

## 5. Agent-generated site knowledge must require approval

Brow allows the agent to propose Domain Skills, but proposals do not become active automatically.

Nika should adopt the same rule for self-healing knowledge.

Example:

1. ChatGPT changes its Send button semantics.
2. Nika's canary discovers a successful alternative locator.
3. Runtime records evidence.
4. Nika creates a `SiteProfilePatchProposal` or `SiteSkillProposal`.
5. User/developer reviews and approves it.
6. Only then does it become durable active configuration.

Do not let a runtime repair silently rewrite canonical SiteProfile logic after one success.

### Proposed states

```text
PROPOSED
VALIDATED_ONCE
VALIDATED_MULTIPLE
APPROVED
REJECTED
ROLLED_BACK
```

This is safer than fully autonomous selector self-modification.

---

## 6. Pinned targets are useful, but Nika needs stronger identity

Hypha Navigator uses a persisted pinned target tab and rehydrates that target on each call. This is a good usability pattern because the user can continue browsing elsewhere without stealing the agent's target.

Nika should keep the existing stronger binding model:

```text
chatId
+ tabId
+ documentId
+ navigationEpoch
+ canonicalConversationUrl
```

But the Side Panel should expose the same operator concept:

```text
Pinned target: DEV17
Tab: 42
Status: READY
[Focus]
[Rebind]
[Release]
```

This makes tab ownership understandable and repairable without exposing implementation details.

Source:
- https://github.com/amun-ai/hypha-navigator

---

## 7. Self-documenting capability manifests are worth adopting

Hypha Navigator exposes a self-documenting API surface so an external agent can fetch its current tool reference rather than relying on stale hardcoded tool descriptions.

Brow similarly exposes tool manifests with source badges, argument schemas and visibility state.

Nika should do the same internally.

### Proposed `CapabilityManifest`

```ts
interface CapabilityManifest {
  protocolVersion: number;
  runtimeVersion: string;
  adapterVersion: string;
  siteProfileVersion?: string;
  capabilities: CapabilityDescriptor[];
}
```

Each capability should include:

- name;
- semantic description;
- input schema;
- action class (`READ/WRITE/ADMIN`);
- approval policy;
- retry class;
- postcondition requirement;
- provider (`DOM`, `WebMCP`, future `CDP`, future `LocalBridge`).

This gives one source of truth for:

- Side Panel UI;
- workflow validation;
- future Nika Server;
- debugging exports;
- model/tool integration.

It also avoids duplicating capability descriptions across UI, code and prompts.

---

## 8. Do not copy Hypha's offscreen architecture blindly

Hypha Navigator keeps its persistent Hypha WebSocket in an offscreen document because its design requires a persistent remote RPC service. The service worker remains the dispatcher and persistence owner.

This is a valid pattern for Hypha.

It does not overturn Nika's previous conclusion.

Nika should still try:

```text
service worker -> LocalBridge WebSocket
```

first, and introduce an offscreen supervisor only if lifecycle tests prove it necessary.

The reusable lesson is ownership:

**even when offscreen owns a long-lived connection, durable browser state stays elsewhere.**

Source:
- https://github.com/amun-ai/hypha-navigator

---

## 9. MAIN-world use should stay surgical

Hypha Navigator uses a MAIN-world bridge only for React tree inspection because React fiber properties are not visible from the isolated world.

This directly supports Nika's existing decision:

```text
ISOLATED world by default
MAIN world only for a narrowly justified page-owned API
```

Do not put the entire ChatGPT adapter into MAIN world.

If future ChatGPT behavior requires Lexical/React internals, implement a small typed `PageBridge` for only that operation.

---

## 10. Whole-site knowledge needs a trust model

If Nika gains importable SiteSkills, recorded workflows and self-healing proposals, it needs trust provenance.

Proposed provenance:

```ts
type KnowledgeOrigin =
  | 'builtin'
  | 'user-authored'
  | 'recorded'
  | 'agent-proposed'
  | 'imported-file'
  | 'imported-url'
  | 'server-managed';
```

Every SiteSkill/Profile patch should record:

- origin;
- createdAt;
- author/source;
- version/hash;
- approval state;
- last validation time;
- compatible site/app version if known.

Imported knowledge should never silently inherit `auto` execution permission.

---

## 11. Comparison

| Project / approach | Strongest reusable idea | Adopt code/dependency now? |
|---|---|---|
| Brow | Side-panel control plane, whole-form semantics, approval separation, skill proposals | No full dependency; selective code/reference study |
| Hypha Navigator | Pinned target, site skills, self-documenting remote surface, narrow MAIN-world bridge | No full dependency; selective patterns |
| OpenDevBrowser | target FIFO, snapshot/ref/action, capability diagnostics | Reference only for current extension runtime |
| agent-browser | fresh refs and mandatory re-snapshot after mutations | Reference/test oracle |
| Agent Skills spec | portable procedural knowledge format with progressive disclosure | Strong candidate for Nika SiteSkill interchange |

---

## 12. Updated Nika module map

```text
OperatorControlPlane
  SidePanel
  ApprovalCenter
  QueueDashboard
  TargetInspector
  KnowledgeReview

ExecutionPlane
  Scheduler
  Dispatcher
  ChatActorCoordinator
  SiteCapabilityProvider
  ChatGPTAdapter
  GenericWebAdapter

KnowledgePlane
  SiteProfileRegistry
  SiteSkillRegistry
  WorkflowDemonstrations
  ProfilePatchProposals

DurabilityPlane
  Dexie Jobs
  Effects
  Leases
  Runs
  runtimeEvents
```

This separation is preferable to building one giant agent runtime inside the Side Panel.

---

## 13. Recommended next implementation/research spikes

### Spike A — SiteSkill schema

Create a minimal `SiteSkill` model with:

- domain/path matchers;
- provenance;
- approval state;
- optional imported Agent Skills metadata;
- Markdown body.

Do not execute bundled scripts.

### Spike B — ApprovalPolicy

Add policy metadata to action definitions and expose it in the Side Panel.

Test:

- READ auto;
- configured ChatGPT SEND auto;
- unknown-site form submit requires approval;
- reload with non-empty composer requires approval.

### Spike C — FormSnapshot fixture

Build a controlled HTML fixture with:

- visible fields;
- offscreen field;
- hidden field;
- required validation;
- combobox;
- disabled submit;
- successful submit.

Compare Nika's output with Brow's conceptual contract and Playwright semantics.

### Spike D — Knowledge proposal workflow

Simulate a stale ChatGPT locator and create a candidate replacement.

The candidate must go through:

```text
PROPOSED -> VALIDATED -> APPROVED
```

before becoming canonical.

---

## Final recommendation

This cycle does not change the dependency baseline.

The strongest new decisions are:

1. formalize **SiteSkill** separately from SiteProfile;
2. use **Agent Skills-compatible Markdown** as a future portable interchange format;
3. introduce **ActionPolicy / ApprovalMode** as a runtime contract;
4. model generic forms as **FormSnapshot**, not independent controls;
5. make self-healing changes **proposals requiring approval**, not silent mutations;
6. expose one **CapabilityManifest** to UI, workflows and future external control planes;
7. keep Side Panel as the operator plane, not the durable execution engine.

The practical result is that Nika can become progressively smarter about each site without turning learned knowledge into uncontrolled execution authority.