# Permission broker, runtime content registration, DOM observation, and untrusted HTML boundaries

Date: 2026-08-24
Repository: `Oleksii-debug/Nika-agent`

## Executive decision

The next reusable boundary for Nika-agent is not another browser automation framework. It is a least-privilege site-access layer that controls which origins Nika can automate, when a content script exists there, and what data from the page is allowed into extension UI.

The current prototype is correctly narrow: `wxt.config.ts` grants `https://chatgpt.com/*` host access rather than `<all_urls>`. Generic web automation must preserve that security property instead of broadening install-time permissions.

Recommended architecture:

`SiteSkill/Profile -> PermissionBroker -> runtime host grant -> ContentRegistration -> SiteCapabilityProvider -> DOM observation/action`

with a separate trust boundary:

`page DOM/text/HTML = untrusted input -> structured extraction or sanitization -> extension UI`.

This document compares ready open-source/platform components and records the development decisions.

---

## 1. Current code-level baseline

`wxt.config.ts` currently requests:

- `alarms`
- `storage`
- `tabs`
- `scripting`
- `clipboardWrite`
- host access only to `https://chatgpt.com/*`

That is substantially safer than starting with `<all_urls>`.

For the first ChatGPT-only release, keep the exact ChatGPT host permission. For later generic site support, do not simply replace it with `<all_urls>` in `host_permissions` or broad static `content_scripts.matches`.

---

## 2. Chrome optional-host permissions are the correct generic-site model

Chrome supports `optional_host_permissions` plus runtime `chrome.permissions.request()`.

Chrome's own guidance emphasizes three benefits:

1. extensions run with fewer permissions;
2. users can be told why a specific feature needs access;
3. adding optional permissions on an update does not disable the extension in the same way that adding required permissions can.

Chrome 133+ also exposes `chrome.permissions.addHostAccessRequest()`, which can surface a host-access request associated with a specific top-level tab/document. Accepted access is persistent for that site's top origin.

Sources:

- https://developer.chrome.com/docs/extensions/reference/api/permissions
- https://github.com/chromium/chromium/blob/main/extensions/docs/permissions.md

### Decision

Introduce a first-class `PermissionBroker`.

Conceptual API:

```ts
interface PermissionBroker {
  getAccess(origin: string): Promise<'granted' | 'withheld' | 'not-declared'>;
  requestAccess(origin: string, context: UserGestureContext): Promise<boolean>;
  revokeAccess(origin: string): Promise<boolean>;
  reconcileRegistrations(): Promise<void>;
}
```

A workflow being imported or a SiteSkill existing MUST NOT imply site access.

Knowledge and permission remain separate:

`SiteSkill available != host permission granted`.

---

## 3. Do not make `<all_urls>` an install-time permission

For future generic automation, if arbitrary HTTPS sites need to be supported, a broad pattern can be declared under `optional_host_permissions` and individual origins requested only when the user deliberately enables a site.

Prefer a UX such as:

`Enable Nika on this site`

rather than:

`Nika can read and change all your data on all websites` at install time.

This is also structurally better for Chrome Web Store review because broad required host permissions and broad static content-script matches expand the review/security surface.

Important distinction:

- manifest declaration = maximum capability that can be requested;
- runtime grant = what the user has actually permitted;
- SiteProfile/ActionPolicy = what Nika is logically allowed to do after that.

All three gates must pass.

---

## 4. WXT currently does not fully solve optional runtime content registration

WXT supports content-script registration modes:

- `manifest`
- `runtime`

However, current WXT `runtime` registration moves matches into `host_permissions`, not `optional_host_permissions`.

An open WXT feature request (#2239) proposes a future `registration: 'optional'` exactly for the model Nika needs: place origins in `optional_host_permissions`, then dynamically register scripts only after user grant.

WXT's current documented API still exposes only `"runtime" | "manifest"`.

Sources:

- https://wxt.dev/api/reference/wxt/interfaces/basecontentscriptentrypointoptions
- https://github.com/wxt-dev/wxt/issues/2239
- https://github.com/wxt-dev/wxt/issues/2040

### Decision

Do not wait for WXT 1.1.

For generic sites, implement a small Nika-owned `ContentRegistrationManager` using:

- `chrome.permissions.contains()`
- `chrome.permissions.request()` / `addHostAccessRequest()` where appropriate
- `chrome.scripting.registerContentScripts()`
- `chrome.scripting.getRegisteredContentScripts()`
- `chrome.scripting.unregisterContentScripts()`

WXT stays the build framework, but Nika owns the runtime permission/registration reconciliation.

The manager must be idempotent and re-runnable after service-worker restart.

---

## 5. Registration state must be reconciled, not trusted from memory

Dynamic content-script registrations persist independently of a single service-worker lifetime. Therefore startup logic should not assume an in-memory registration list.

Recommended reconciliation:

1. read SiteProfiles enabled by the user;
2. check actual granted host permissions;
3. call `getRegisteredContentScripts()`;
4. register missing allowed scripts;
5. unregister scripts for revoked/disabled origins;
6. write a lightweight audit event.

Do not couple registration ownership to a running workflow.

A workflow must never silently request permissions. Permission acquisition should originate from explicit operator interaction.

---

## 6. Permission capability matrix

Recommended distinction:

### Baseline required

Keep only APIs needed for the core product.

### Optional site access

Use runtime host permission per origin/site.

### Privileged capabilities

Do not make these appear merely because a SiteSkill asks for them.

`chrome.debugger`, for example, is not an ordinary optional feature to be dynamically granted later in the same way as host access. Its adoption should remain a separate product/security decision and likely a separate build/profile if ever required.

### Action policy is still narrower than browser permission

Even if Chrome says Nika has access to `example.com`, Nika may still restrict execution:

- READ allowed;
- WRITE requires approval;
- ADMIN blocked.

Browser permission is necessary, never sufficient.

---

## 7. DOM waiting: keep native MutationObserver as the core, but borrow a small wrapper pattern

A current lightweight open-source candidate is `@untemps/dom-observer` / `untemps/dom-observer`.

The project is TypeScript, zero-dependency, recently maintained in 2026, and is explicitly designed around MutationObserver for:

- one-shot wait-for-element;
- continuous observation;
- debounce;
- AbortSignal;
- element/attribute change tracking.

Source discovery:

- https://github.com/topics/mutation-observer
- https://www.npmjs.com/~untemps

### Decision

Do not make it a baseline dependency yet.

Its abstraction is useful as a design reference for our `DomStateObserver`, especially:

```ts
waitFor(predicate, { timeout, signal })
observe(predicate, { debounceMs, signal })
```

But ChatGPT completion logic remains more complex than `waitForElement`:

`generating -> mutations -> stop control disappears -> quiet window -> stable response fingerprint`.

Therefore Nika still needs its own state semantics on top of native MutationObserver.

A spike can compare whether `@untemps/dom-observer` reduces boilerplate without obscuring lifecycle cancellation.

---

## 8. Every DOM wait needs AbortSignal and document identity

This should now be a hard runtime rule.

Any wait/observer must bind to:

- `tabId`
- `frameId/documentId` where applicable
- `navigationEpoch`
- `AbortSignal`
- absolute timeout/deadline.

When navigation changes the target document:

`abort observer -> invalidate refs -> reconcile fresh target`.

Do not leave MutationObservers alive across semantic target transitions.

This prevents stale callbacks from an old ChatGPT conversation from advancing a workflow in a new conversation that reused the same tab.

---

## 9. Extension UI must treat page HTML as hostile

As Nika evolves toward recorder diagnostics, SiteSkills, snapshots, or copied response previews, there will be pressure to render page-derived markup inside Side Panel.

That creates an extension-privilege XSS boundary.

Default rule:

**Never insert page HTML with `innerHTML` merely because it came from a page Nika is allowed to automate.**

Prefer:

- `textContent`;
- structured semantic models;
- pre-created DOM components;
- explicit safe attribute rendering.

If actual HTML rendering becomes a product requirement, use a maintained sanitizer such as DOMPurify and pin/update it aggressively.

DOMPurify is a mature DOM-based sanitizer with Apache-2.0/MPL-2.0 licensing and active 3.4.x maintenance. Its 2026 security work is a reminder that sanitizer version freshness is security-critical, not a one-time dependency decision.

Sources:

- https://github.com/cure53/DOMPurify
- https://github.com/cure53/DOMPurify/wiki/Security-Goals-%26-Threat-Model
- https://github.com/cure53/DOMPurify/security

### Decision

Do not add DOMPurify until Nika actually renders untrusted HTML.

For current chat text and diagnostics, render plaintext/structured data only.

If added later:

- avoid `IN_PLACE` mode;
- avoid custom dangerous allowlists;
- do not allow iframe/srcdoc by default;
- consider Trusted Types output where useful;
- security updates become release blockers.

---

## 10. Do not execute downloaded workflow logic

Manifest V3 Chrome Web Store policy requires extension logic to be self-contained. Remote resources may provide data, but they must not smuggle executable extension logic.

Chrome explicitly flags patterns such as:

- remote `<script>` resources;
- `eval()` on fetched strings;
- interpreters that execute complex remote commands as hidden code.

Documented exceptions exist for APIs whose purpose explicitly supports such execution, such as `debugger` and `userScripts`, but that does not justify a generic remote-code architecture.

Source:

- https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements

### Nika consequence

Imported workflows and SiteSkills are **data**, validated through schemas and compiled into a fixed, packaged `CapabilityManifest`.

They cannot define arbitrary JavaScript.

Allowed:

```json
{
  "type": "SEND_MESSAGE",
  "target": "DEV17",
  "prompt": "Continue"
}
```

Not allowed:

```json
{
  "javascript": "fetch(...); document.querySelector(...).click()"
}
```

This reinforces the earlier `WorkflowCompiler` boundary.

---

## 11. Sandboxed extension pages are not a shortcut around the trust model

Chrome permits more relaxed CSP in declared sandbox pages because those pages do not receive normal extension API privileges.

That can be useful later for strictly isolated preview/rendering tools, but Nika should not use sandboxed pages as a mechanism to run arbitrary downloaded automation logic.

A sandbox may render or transform untrusted content, while control remains outside through a narrow `postMessage` protocol.

Source:

- https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy

### Decision

No sandbox page is needed for baseline Nika.

Potential later use:

`untrusted workflow preview / HTML diagnostic renderer`.

Never:

`main workflow execution runtime`.

---

## 12. Proposed new modules

### PermissionBroker

Owns user-granted host capability.

### ContentRegistrationManager

Maps granted origins/SiteProfiles to actual dynamically registered scripts.

### SiteAccessRecord

Suggested durable fields:

```ts
interface SiteAccessRecord {
  origin: string;
  siteProfileId?: string;
  enabled: boolean;
  lastPermissionCheckAt: string;
  lastRegistrationCheckAt?: string;
}
```

Do not duplicate Chrome's permission truth as a boolean and trust it forever. Always reconcile with `chrome.permissions.contains()`.

### DomStateObserver

Native MutationObserver-based state machine with AbortSignal, timeout, navigation epoch, quiet-window detection, and semantic predicates.

### UntrustedContentRenderer

Initially plaintext-only. HTML sanitizer remains an optional future adapter.

---

## 13. Development order

1. Keep ChatGPT permission fixed for V1.
2. Add `PermissionBroker` interface and tests without broadening manifest access.
3. Build `ContentRegistrationManager` fixture using one optional test origin.
4. Test grant -> register -> revoke -> unregister -> restart reconciliation.
5. Add `SiteAccessRecord` only as metadata, never as permission authority.
6. Refactor current wait loops behind `DomStateObserver` with AbortSignal.
7. Add navigation-cancellation tests.
8. Keep Side Panel rendering page-derived values as plaintext.
9. Add an explicit lint/review rule against untrusted `innerHTML`.
10. Only when HTML preview is required, spike current DOMPurify and pin a patched release.
11. Add workflow/compiler tests proving imported SiteSkill/workflow data cannot execute arbitrary JavaScript.

---

## 14. Reuse decisions

### Adopt platform APIs now

- `chrome.permissions`
- `chrome.scripting.registerContentScripts()`
- native `MutationObserver`
- `AbortController/AbortSignal`

### Keep WXT

Yes. WXT remains the correct extension framework, but Nika owns optional-host registration until WXT provides a first-class optional registration mode.

### Spike, do not adopt yet

- `@untemps/dom-observer`

Reason: useful cancellation/debounce API, but Nika's semantic completion rules remain custom.

### Adopt only if HTML rendering becomes necessary

- DOMPurify

### Explicitly avoid

- install-time `<all_urls>` for generic web support;
- automatic permission prompts from background workflows;
- remote JavaScript in SiteSkills/workflows;
- arbitrary `eval`/Function-based automation;
- treating sandbox pages as trusted workflow engines;
- stale persisted booleans as proof that Chrome still grants a site permission.

---

## Final architecture decision

The generic-web path should be capability-scoped, not globally privileged:

`user enables site`

-> `PermissionBroker verifies/grants origin`

-> `ContentRegistrationManager installs the exact content surface`

-> `SiteProfile health-check`

-> `CapabilityManifest + ActionPolicy`

-> `DomStateObserver / semantic resolver`

-> `verified action`.

This preserves Nika's strongest property as it expands beyond ChatGPT: adding knowledge about more websites does not silently increase the extension's authority over those websites.