# Safe workflow expressions, branching, and Open Workflow portability

Date: 2026-08-25
Repository: `Oleksii-debug/Nika-agent`

## Executive decision

Nika should not embed arbitrary JavaScript in workflows, SiteSkills, imported recordings, or future server-authored jobs.

The next workflow-language boundary should be:

`WorkflowDocumentV1 -> schema validation -> safe expressions/transforms -> WorkflowCompiler -> ExecutionPlan -> capability runtime`

For boolean guards and policy expressions, the strongest current candidate for a spike is **Common Expression Language (CEL)** via `@marcbachmann/cel-js`.

For JSON shaping/transformation, **JSONata** is a useful optional candidate, but it should be treated as a separate transform capability, not as the default condition language.

**JsonLogic** remains useful as a highly portable serialized rule format, especially for import/export, but its prefix-JSON syntax is less suitable as Nika's primary human-authored expression syntax.

The **Open Workflow Specification** is worth tracking as a portability/reference standard. Nika should not adopt its full runtime model in the Chrome extension today, but its versioned JSON/YAML schema, branching, scheduling, timeout, error-handling, and interoperability model are useful inputs for `WorkflowDocumentV2` and future Nika Server interchange.

No production dependency should be added immediately. First implement the expression boundary and fixture tests, then spike CEL.

---

## 1. Current code-level gap

`src/types.ts` currently defines only linear workflow steps:

- `send`
- `wait_idle`
- `capture`
- `forward`
- `delay`

`src/workflow.ts` executes them in a normal `for` loop with an in-memory context map.

This is enough for the current prototype, but real workflows will soon need at least:

- conditional branch (`if` / guard);
- condition-based wait;
- skip/continue rules;
- policy checks;
- typed data extraction;
- safe transformations;
- optional loops with explicit bounds;
- reusable sub-workflows;
- error routes.

The dangerous shortcut would be to introduce something like:

```json
{
  "type": "if",
  "javascript": "context.response.includes('PASS')"
}
```

or imported workflow steps containing arbitrary JavaScript.

That would undermine several decisions already made for Nika:

- MV3 remote-code restrictions;
- capability-based execution;
- ActionPolicy;
- PageTrustEnvelope;
- deterministic replay;
- workflow portability;
- testability;
- security review.

Therefore Nika needs a deliberately constrained expression language.

---

## 2. Candidate: Common Expression Language (CEL)

CEL was designed specifically as a small embedded expression language for policy and protocol use. The official specification emphasizes that CEL is mutation-free and non-Turing-complete; its bounded expression model is a feature because it avoids the sandboxing burden of JavaScript/Lua-style scripting.

Official specification:
https://github.com/cel-expr/cel-spec

### JavaScript implementation candidate

`@marcbachmann/cel-js`

Repository:
https://github.com/marcbachmann/cel-js

npm:
https://www.npmjs.com/package/@marcbachmann/cel-js

At the time of this research:

- npm version: `8.0.0`;
- MIT license;
- zero runtime dependencies;
- ESM / TypeScript;
- typed environments;
- custom variables/functions;
- most CEL syntax/macros;
- parse-once/evaluate-many support.

Example Nika guard:

```text
outputs.audit.status == "PASS" && chat.state == "idle"
```

Possible Nika policy:

```text
action.effectClass == "WRITE" && target.controlState == "AGENT_LEASED"
```

Possible scheduler/admission guard:

```text
job.priority <= 2 && throttle.state != "OPEN"
```

### Why CEL fits Nika

1. Human-readable compared with prefix JSON rules.
2. No arbitrary statements, mutation, network access, DOM access, or dynamic code loading.
3. Expression can be parsed/validated before a workflow is accepted.
4. The host explicitly controls which variables and functions exist.
5. The same conceptual language can later be evaluated in the extension, LocalBridge, or server implementations.
6. It maps naturally onto guards, approval policy, dispatch policy, and wait predicates.

### Important restrictions

Nika must expose a very small environment.

Good variables:

- `outputs`
- `run`
- `job`
- `chat`
- `site`
- `action`
- `throttle`

Good pure functions might eventually include:

- string normalization;
- bounded length/count helpers;
- timestamp comparison;
- explicit typed predicates.

Do **not** expose host functions that:

- navigate;
- click;
- send messages;
- fetch URLs;
- read arbitrary browser storage;
- call LocalBridge;
- mutate workflow context.

Expressions decide; capabilities act.

### Recommendation

**First candidate for `WorkflowExpressionV1`.**

Spike before adoption because it is a third-party CEL implementation rather than the canonical Go/Java implementation. Conformance and denial-of-service limits should be tested against the subset Nika actually enables.

---

## 3. Candidate: JsonLogic

Repository:
https://github.com/jwadhams/json-logic-js

npm:
https://www.npmjs.com/package/json-logic-js

Current npm line observed during research:

- `2.0.5`;
- MIT;
- zero dependencies;
- very widely downloaded;
- designed explicitly so rules can be serialized with data and evaluated in multiple languages.

Equivalent guard:

```json
{
  "and": [
    { "==": [{ "var": "outputs.audit.status" }, "PASS"] },
    { "==": [{ "var": "chat.state" }, "idle"] }
  ]
}
```

### Advantages

- JSON-native;
- trivial to persist inside `WorkflowDocument`;
- easy to validate structurally;
- mature cross-language ecosystem;
- no temptation to embed normal JavaScript source.

### Disadvantages for Nika

- poor readability for NVDA/manual workflow editing once conditions become non-trivial;
- prefix JSON gets verbose quickly;
- custom operations can reintroduce unsafe host behavior if not tightly controlled;
- less natural for an operator-facing expression editor.

### Recommendation

**Keep as import/export/interchange option, not first-choice authoring language.**

A future compiler could accept a small JsonLogic subset and lower it into Nika's internal expression AST.

---

## 4. Candidate: JSONata

Repository:
https://github.com/jsonata-js/jsonata

npm:
https://www.npmjs.com/package/jsonata

Current observed npm version:

- `2.2.2`;
- MIT;
- zero dependencies;
- active 2026 releases;
- browser-capable;
- strong JSON querying and transformation language.

JSONata is much more useful for:

```text
responses.{
  "agent": agentId,
  "length": $length(text),
  "accepted": status = "PASS"
}
```

than for simple branch conditions.

### Strong use cases

- normalize imported workflow data;
- extract a small structure from a captured response object;
- map/filter structured results;
- prepare a payload for a known capability.

### Why it should be separate from guards

Transformation and authorization/branch decisions are different responsibilities.

If every workflow condition can also become a broad transformation program, the execution surface becomes harder to reason about, meter, and explain.

Nika should therefore distinguish:

`ExpressionKind.GUARD`

from

`ExpressionKind.TRANSFORM`.

### Recommendation

**Optional later transform engine; not baseline guard language.**

If adopted, expose no extension functions that create external side effects and add strict input/output size limits and evaluation deadlines.

---

## 5. Candidate: json-rules-engine

Repository:
https://github.com/CacheControl/json-rules-engine

Current package metadata inspected during research shows `7.3.2` in `package.json`, ISC license, and dependencies including EventEmitter, hashing and JSONPath support.

It provides:

- facts;
- conditions;
- operators;
- rule priorities;
- success/failure events;
- an almanac/fact model.

This is useful for business-rules systems, but for Nika it overlaps with layers we already own:

- WorkflowCompiler;
- DispatchPolicy;
- ActionPolicy;
- runtime events;
- durable job/effect state.

Adding a second rule/event execution engine would make it less obvious which subsystem owns transitions.

### Recommendation

**Do not add as baseline.**

Borrow the concepts of named facts and pure conditions where useful, but keep actual runtime authority in Nika's workflow/state-machine layer.

---

## 6. Open Workflow Specification as portability reference

The CNCF Serverless Workflow project was renamed/moved to **Open Workflow Specification** in 2026.

Specification:
https://github.com/open-workflow-specification/specification

The current repository schema identifies DSL version `1.0.3` and uses JSON Schema Draft 2020-12.

The specification includes concepts directly relevant to Nika's future portable workflow format:

- versioned workflow documents;
- conditional branching;
- looping;
- timeouts;
- error handling;
- schedules (`every`, `cron`, `after`, event-based scheduling);
- service calls;
- events;
- secrets;
- reusable/custom functions;
- JSON/YAML representation.

### Important caution

The official TypeScript SDK repository currently documents release lines conforming to older specification versions up to v0.8, while the specification itself is already 1.0.x.

SDK:
https://github.com/open-workflow-specification/sdk-typescript

Therefore Nika should **not** couple the browser extension runtime to the current SDK.

### What to reuse conceptually

Nika's future `WorkflowDocumentV2` should consider compatible ideas:

```text
document.version
inputs
outputs
do/tasks
if/switch
for/foreach
timeout
error route
schedule
```

But browser-specific operations remain Nika capabilities:

```text
SEND_MESSAGE
WAIT_FOR_RESPONSE
CAPTURE_RESPONSE
GENERIC_WEB_ACTION
HUMAN_HANDOFF
```

### Best boundary

`Open Workflow import`

-> validate external document

-> map supported subset

-> `WorkflowCompiler`

-> Nika `ExecutionPlan`

Unsupported service/function constructs fail explicitly.

The imported format never becomes an alternate privileged runtime.

---

## 7. BPMN / bpmn-js

`bpmn-js` is a mature browser toolkit for viewing/editing BPMN 2.0 diagrams.

Repository:
https://github.com/bpmn-io/bpmn-js

It is useful if Nika someday needs enterprise BPMN interchange or a visual modeler, but it does not solve the important browser-execution problems:

- Effect Journal;
- browser receipts;
- stale target rejection;
- lease/fencing;
- MV3 recovery;
- ambiguity-safe SEND.

It would also push the UX toward a graphical diagram as a primary artifact, which is a poor fit for Nika's requirement that the canonical workflow remain fully usable as a semantic ordered structure.

### Recommendation

**Do not add.**

If BPMN interoperability becomes commercially necessary later, implement import/export at the `WorkflowDocument` boundary rather than making BPMN the internal runtime representation.

---

## 8. Proposed Nika expression architecture

Introduce an engine-neutral internal contract first:

```ts
interface WorkflowExpressionV1 {
  language: 'cel';
  source: string;
  expectedType: 'boolean' | 'string' | 'number' | 'object';
  environmentVersion: 1;
}
```

Do not put third-party evaluator objects in durable state.

Compile at runtime/control-plane boundaries:

`source`

-> parse

-> validate allowed syntax/features

-> type/environment check

-> compile/cache AST

-> evaluate against immutable context snapshot.

Possible future workflow steps:

```text
IF
SWITCH
ASSERT
WAIT_UNTIL
TRANSFORM
```

Example:

```text
IF outputs.audit.status == "PASS"
  -> SEND_MESSAGE coordinator
ELSE
  -> SEND_MESSAGE developer
```

The branch decision itself must be written to the durable run history:

```text
EXPRESSION_EVALUATED
expressionHash
inputSnapshotHash
result=true
```

This makes restart/replay deterministic. The workflow must not silently re-evaluate a guard against changed external data after a crash unless the step's semantics explicitly request a fresh evaluation.

---

## 9. Security and determinism rules

### 9.1 No arbitrary JavaScript

Never support workflow fields such as:

```text
javascript
script
eval
remoteModule
```

for production workflow execution.

### 9.2 Immutable evaluation snapshot

A guard receives a frozen logical context snapshot.

It does not directly query current DOM or browser state.

If fresh browser state is required, the workflow first executes an explicit READ capability and stores its result.

Then CEL evaluates that recorded result.

This preserves provenance:

`READ -> durable output -> GUARD -> branch`.

### 9.3 Deterministic function registry

No random/time/network functions unless their value is passed into the context as a recorded fact.

Bad:

```text
now() > deadline
```

if `now()` reads the wall clock independently during replay.

Better:

```text
run.observedNow > deadline
```

where `observedNow` is persisted as step input.

### 9.4 Resource limits

Even a non-general-purpose expression language needs bounds:

- maximum expression length;
- maximum AST depth;
- maximum input object size;
- maximum collection size exposed to macros;
- evaluation deadline/budget;
- bounded custom functions.

### 9.5 No action capability inside expressions

Expression evaluation may return a decision or value only.

It cannot SEND, CLICK, NAVIGATE, reload, call WebMCP, invoke CDP, or reach LocalBridge.

---

## 10. Recommended comparison

| Option | Best role | Browser fit | Human readability | Portability | Recommendation |
|---|---|---:|---:|---:|---|
| `@marcbachmann/cel-js` | guards/policies | High | High | High conceptual CEL ecosystem | **Spike first** |
| JsonLogic | serialized rules | High | Low-medium | Very high | Import/interchange |
| JSONata | JSON transforms | High | Medium | Good | Optional transform engine |
| json-rules-engine | full business-rule engine | Medium | Medium | Medium | Do not add baseline |
| Open Workflow Spec | workflow interchange | Not extension runtime | High | Very high | Track/adapt subset |
| BPMN/bpmn-js | enterprise visual interchange | Heavy | Visual-first | High enterprise | Not now |

---

## 11. Implementation sequence

1. Define `WorkflowExpressionV1` independent of any library.
2. Define immutable `ExpressionContextV1`.
3. Add `IF` and `ASSERT` only; do not add loops yet.
4. Add expression parse/validation tests.
5. Spike `@marcbachmann/cel-js` in dev/tests.
6. Add resource-limit and malicious-expression fixtures.
7. Persist `EXPRESSION_EVALUATED` evidence in run history.
8. Make crash/replay reuse the recorded branch result when appropriate.
9. Add `WAIT_UNTIL` only after durable wait infrastructure exists.
10. Add a separate `TransformExpressionV1` only when a real transformation use case appears.
11. Prototype Open Workflow import for a tiny safe subset after `WorkflowCompiler` is stable.
12. Reject unsupported external workflow functions instead of silently translating them.

---

## 12. Final recommendation

The browser automation layer is now constrained enough that the workflow language should follow the same philosophy.

Nika should not evolve from a safe capability runtime into a hidden scripting platform.

The clean model is:

`declarative workflow`

+ `safe pure expressions`

+ `explicit capabilities`

+ `durable observations/effects`

+ `compiler-enforced policy`.

For the immediate next spike, **CEL is the strongest choice for guards and policies**. JSONata should remain a separate optional data-transform mechanism. Open Workflow Specification should influence portability and document design, but not replace Nika's browser-specific durable execution semantics.