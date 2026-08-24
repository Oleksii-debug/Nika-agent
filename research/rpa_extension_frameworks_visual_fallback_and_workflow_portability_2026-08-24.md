# RPA extension frameworks, visual fallback, and workflow portability

Date: 2026-08-24
Repository: `Oleksii-debug/Nika-agent`

## Executive decision

This research cycle compared mature browser-RPA extensions and current extension build frameworks against Nika-agent's reliability requirements.

The result is conservative:

1. **Keep WXT as the extension framework.** CRXJS is active and technically strong, and Plasmo remains a capable alternative, but neither offers enough runtime benefit to justify migration from WXT.
2. **Use Automa and UI.Vision as architectural/reference sources, not embedded code.** Both have licensing constraints for source reuse (Automa AGPL/commercial; UI.Vision AGPL/commercial) and both are primarily macro/RPA systems rather than ambiguity-safe durable workflow runtimes.
3. **Adopt the useful RPA patterns selectively:** portable workflow JSON, recorder/import/export, block catalogs, schedule authoring, execution history, user-visible variables, and optional visual fallback.
4. **Do not inherit macro semantics for critical actions.** A block completing after a click is insufficient for Nika. Mutating actions continue to require fresh observation and postcondition evidence.
5. **Computer vision/OCR should be a late fallback and diagnostic capability, not the normal selector strategy.** Semantic DOM/accessibility resolution remains primary.

---

## 1. Automa: the closest mature browser-extension RPA reference

Automa is a browser extension for building automation workflows by connecting blocks. It supports repetitive web tasks, forms, screenshots, scraping, workflow scheduling, a workflow marketplace, and generation of standalone Chrome extensions from workflows.

As of August 2026 it remains actively released; v1.29.12 was published on 2026-08-11. Earlier 2026 releases completed the move to Chrome Manifest V3 and specifically fixed MV3 event communication and several workflow-block failures.

Repository: https://github.com/AutomaApp/automa
Releases: https://github.com/AutomaApp/automa/releases

### Relevant architectural evidence

The current repository is not a toy macro extension. Its source tree separates at least:

- `background`;
- `content`;
- `db`;
- `execute`;
- `offscreen`;
- editor/components/common infrastructure.

Its package manifest is also revealing. Automa already uses or has used many of the same classes of components being selected independently for Nika:

- `dexie`;
- `cron-parser`;
- `cronstrue`;
- `rxjs`;
- Vue Flow / DAG tooling;
- CSS selector generators;
- browser extension polyfills.

This is independent evidence that the overall browser-side stack selected for Nika — IndexedDB/Dexie plus explicit scheduling and a workflow model — is reasonable for a large browser automation product.

### What to reuse conceptually

Useful Automa ideas:

- block catalog with typed inputs;
- workflow JSON as a portable artifact;
- variables and expression interpolation;
- trigger parameters;
- schedule authoring;
- workflow import/export and packaging;
- execution logs/history;
- visual workflow authoring for sighted operators;
- optional generic blocks for HTTP, JS, forms, data processing and navigation.

### What not to copy as Nika's execution contract

Automa is fundamentally a macro/RPA workflow engine. Nika's ChatGPT workflow has stronger requirements:

- durable effect journal;
- ambiguous side-effect classification;
- per-chat single-writer semantics;
- fencing tokens;
- navigation/document identity;
- semantic locator strictness;
- postcondition evidence;
- service-worker crash reconciliation.

Therefore Nika may eventually import or translate Automa-like blocks, but a generic `click` block must be compiled into the Nika action contract rather than executed with macro-style success semantics.

### Licensing

Automa source is dual-licensed under AGPL and an Automa commercial license. This is a strong reason to avoid direct source copying into Nika unless licensing is deliberately addressed.

Decision: **reference and interoperability target, not source dependency.**

---

## 2. UI.Vision RPA: visual/OCR fallback reference

UI.Vision RPA is another mature browser RPA system. It combines browser macros with Selenium-IDE compatibility and computer-vision/OCR capabilities.

Repository: https://github.com/A9T9/RPA
License: https://github.com/A9T9/RPA/blob/master/LICENSE.txt

The current license is dual AGPLv3/commercial. Modified or embedded source used inside a non-AGPL product requires careful licensing treatment.

### Why it matters for Nika

UI.Vision demonstrates that browser automation can use several independent targeting channels:

1. DOM/browser selectors;
2. Selenium-style commands;
3. OCR/text recognition;
4. computer-vision/image targets.

For Nika this suggests a clear fallback hierarchy rather than a single locator engine.

Recommended future target strategy:

`SiteProfile semantic locator`

→ `cached semantic recipe`

→ `fingerprint healing`

→ `generic accessibility/DOM resolver`

→ `optional visual/OCR resolver`

→ `human approval or fail closed`.

### Critical restriction

Visual matching must not silently become the normal path for `SEND_MESSAGE` or other critical writes.

Image matching is vulnerable to:

- zoom/DPI changes;
- localization;
- responsive layout;
- theme changes;
- animations;
- duplicate visual controls;
- overlays.

Thus a visual match should normally return a **candidate target**. Before a mutating action, Nika should attempt to corroborate it with DOM/accessibility identity when possible and still require the same postcondition afterwards.

Decision: **visual/OCR is a future fallback/diagnostic provider, not baseline runtime.**

---

## 3. WXT vs CRXJS vs Plasmo

A framework migration was reconsidered because the extension runtime is becoming more complex.

### WXT

WXT remains actively maintained, MIT licensed and browser/framework agnostic. Its current feature set includes MV2/MV3, file-based extension entrypoints, HMR, TypeScript, multi-browser builds, modules, automated publishing and bundle analysis.

Repository: https://github.com/wxt-dev/wxt

The latest observed release is `wxt v0.21.2` from 2026-07-28.

For Nika, the key advantage is not just build tooling. Existing work already uses WXT's content/background entrypoint model, and prior research has identified useful WXT-specific lifecycle and test surfaces.

### CRXJS

CRXJS is an active MIT-licensed Vite plugin focused on zero-config MV3 extension builds, native HMR and the wider Vite plugin ecosystem.

Repository: https://github.com/crxjs/chrome-extension-tools

The project is active in 2026 and recently shipped `vite-plugin-v2.7.0`, including MAIN-world content-script HMR. It also tests compatibility across current Vite versions.

CRXJS is technically credible. If Nika were starting from zero and required a very Vite-native minimal build layer, it would be a serious candidate.

However, it is primarily a build plugin. Nika would not gain meaningful execution durability, workflow semantics, messaging, scheduling or DOM reliability by moving to it.

Decision: **do not migrate. Keep as fallback/build-tool reference.**

### Plasmo

Plasmo remains a large MIT-licensed extension framework with React/TypeScript, messaging, storage, multi-browser support, content-script UI and publishing tooling. The latest observed release is `v0.90.5` from 2026-05-17.

Repository: https://github.com/PlasmoHQ/plasmo

Its own README still describes the framework as alpha software. It also has stronger framework opinions and a larger abstraction surface than Nika needs.

Decision: **no migration.**

### Framework conclusion

For Nika the important rule is now:

> Extension framework choice must not leak into durable runtime semantics.

`Scheduler`, `JobRepository`, `EffectJournal`, `ChatActorCoordinator`, `SiteCapabilityProvider`, `ActionResult`, and `LocatorRecipe` should remain plain TypeScript/application modules wherever possible.

That keeps a future framework migration possible without rewriting the execution engine.

---

## 4. Workflow portability is worth implementing

The mature RPA projects repeatedly converge on import/export as a first-class feature.

Nika should therefore define a stable portable workflow format early rather than persisting editor-specific objects directly.

Recommended separation:

`WorkflowDocumentV1`

- metadata;
- schema version;
- declared capabilities;
- variables/inputs;
- steps;
- retry/action policy references;
- expected outputs;
- provenance/import source.

Editor state should be separate:

`WorkflowEditorLayoutV1`

- visual positions;
- collapsed groups;
- viewport;
- annotations.

This matters for accessibility as well: the canonical workflow must be an ordered semantic structure. A visual graph is merely one view of it.

Possible future import adapters:

- Chrome Recorder UserFlow;
- Selenium IDE-compatible command sets;
- Automa-like block JSON where legally/technically appropriate;
- Nika recorder output;
- manually authored Nika workflows.

All imported actions must be normalized to Nika capabilities and policies before execution.

Example:

`external click(selector)`

must not become an unrestricted click.

It becomes something like:

`GENERIC_CLICK(TargetRecipe, EffectClass.WRITE, ApprovalPolicy, Postcondition)`.

Unknown or unsafe imported commands must be rejected or require explicit user mapping.

---

## 5. Separate authoring semantics from execution semantics

RPA products often combine the user-facing block and the runtime command too tightly.

Nika should not.

A friendly block could say:

`Надіслати повідомлення в DEV17`.

The compiled runtime action should be much richer:

- capability: `SEND_MESSAGE`;
- target identity;
- action policy;
- retry class;
- effect ID;
- expected document/navigation epoch;
- semantic target recipe;
- postcondition;
- timeout and observation policy.

This creates a compiler-style boundary:

`WorkflowDocument`

→ validate

→ resolve SiteProfile/SiteSkill

→ compile to `ExecutionPlan`

→ enqueue durable jobs/effects.

Benefits:

- editor format can evolve independently;
- imported workflows cannot bypass policy;
- validation happens before a 50-chat batch starts;
- the UI can remain simple and NVDA-friendly;
- execution remains deterministic and auditable.

Recommended new component: `WorkflowCompiler`.

---

## 6. Scheduling lesson from RPA products

Automa demonstrates that users expect scheduling to be part of browser automation and itself depends on `cron-parser`/`cronstrue` for cron handling and human-readable descriptions.

This reinforces the prior Nika decision:

- do not write a cron parser;
- keep structured schedule forms as the primary accessible UX;
- allow cron only as an advanced representation;
- separate schedule intent from actual dispatch.

A scheduled workflow becoming due should only create a durable job.

It must **not** directly start browser mutation.

Canonical path remains:

`Schedule → Job READY → paced dispatcher → per-target gate → effect protocol`.

This is the key reliability distinction between Nika and traditional browser macro schedulers.

---

## 7. Proposed provider hierarchy for generic web automation

This cycle suggests extending `SiteCapabilityProvider` into explicit resolver/provider tiers:

### SemanticDomProvider — baseline

Uses:

- roles/accessibility names;
- labels;
- test IDs;
- stable attributes;
- composed tree/frame registry;
- SiteProfile recipes.

### GenericMacroProvider — future

Executes normalized generic workflow commands after they pass the Nika compiler/policy layer.

This can power imported/recorded workflows without weakening ChatGPT-specific semantics.

### VisualProvider — optional future

Uses OCR/image matching only when DOM methods fail or as diagnostics.

Must report confidence and evidence.

### StructuredToolProvider — future

Uses WebMCP or site-provided structured APIs where available.

### PrivilegedBrowserProvider — restricted

CDP/debugger or LocalBridge operations. Explicit permissions and higher approval requirements.

No provider may bypass `ActionPolicy`, target identity or postcondition rules.

---

## 8. Concrete decisions

### Keep

- WXT;
- TypeScript;
- Dexie;
- XState;
- p-queue;
- `@webext-core/messaging`;
- semantic DOM/accessibility-first execution.

### Reuse as patterns

From Automa:

- block/workflow authoring concepts;
- workflow portability;
- trigger parameters;
- schedule UX;
- variables/expression UX;
- export/import/package concepts.

From UI.Vision:

- multi-modal targeting;
- OCR/computer-vision fallback;
- macro compatibility concepts.

From CRXJS/Plasmo:

- only build-tool/reference ideas; no migration.

### Do not adopt

- Automa/UI.Vision source code without an explicit licensing decision;
- macro-style success semantics;
- visual matching as default target selection;
- editor graph as authoritative workflow state;
- direct scheduler-to-browser-action execution.

---

## 9. Next implementation/research spikes

1. Define `WorkflowDocumentV1` independent of the current UI.
2. Add `WorkflowCompiler` that emits validated execution actions.
3. Implement import normalization for a small Chrome Recorder fixture.
4. Build an accessible ordered-list workflow editor view from the same canonical document used by any future graph view.
5. Add `ProviderKind = SEMANTIC_DOM | GENERIC_MACRO | VISUAL | STRUCTURED_TOOL | PRIVILEGED`.
6. Create a visual-fallback fixture where a semantic locator intentionally fails and a mock visual provider proposes a candidate without being allowed to bypass postcondition validation.
7. Evaluate `cron-parser + cronstrue` only when advanced cron UI is implemented; no custom cron parsing.
8. Add provenance to imported workflows so diagnostics can state whether a step came from Nika, Recorder, Automa-compatible import, or another source.

## Final architectural takeaway

Mature RPA extensions prove that browser-side workflow authoring, scheduling, recording and portable automation documents are practical at significant scale. They do **not** invalidate Nika's stricter runtime design.

The useful synthesis is:

`RPA-grade authoring and interoperability`

+

`distributed-systems-grade execution semantics`.

Nika should become easy to teach and import workflows into, while remaining much harder to trick into repeating, mis-targeting or falsely declaring a browser side effect successful.
