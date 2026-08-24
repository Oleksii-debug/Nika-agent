# Web Locks, recurrence parsing, and accessibility tooling for Nika-agent

Date: 2026-08-24
Repository: `Oleksii-debug/Nika-agent`

## Executive decision

This cycle focuses on three reusable pieces that can reduce custom code without changing the core architecture:

1. **Web Locks API** as a short-lived coordination guard inside the extension runtime;
2. **cron-parser** as an optional advanced recurrence parser, while keeping Nika schedules stored as structured data;
3. **axe-core / @axe-core/playwright** as an accessibility test gate for the extension UI, with `tabbable` / `focus-trap` reserved for specific UI cases rather than baseline dependencies.

None of these replaces the durable correctness mechanisms already selected for Nika-agent.

The resulting model is:

`Dexie lease + fencing token = correctness across crash/restart`

`Web Locks = cheap live re-entrancy guard while contexts are alive`

`chrome.alarms = wake-up mechanism`

`structured schedule model + optional cron-parser = recurrence calculation`

`native semantic HTML + Playwright + axe = accessibility acceptance`

---

## 1. Web Locks API: useful, but not a durable lease

The Web Locks API (`navigator.locks`) is a browser-native coordination primitive. It lets same-origin tabs and workers request named exclusive or shared locks. The lock is held only while the callback is running and is automatically released when the callback ends.

MDN reports the API as widely available since March 2022 and explicitly notes that it is available in Web Workers.

Sources:

- https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API
- https://developer.mozilla.org/en-US/docs/Web/API/Navigator/locks
- https://github.com/w3c/web-locks/blob/main/EXPLAINER.md

### Where it can help Nika

The current Nika scheduler/runtime can be entered from several live events:

- `chrome.alarms.onAlarm`;
- manual `Run now`;
- startup reconciliation;
- storage/config changes;
- future recovery wake events.

Even with one extension service worker, asynchronous handlers can overlap logically. A cheap live guard can prevent two dispatcher-drain cycles from racing while the worker is alive:

```ts
await navigator.locks.request('nika:dispatcher', async () => {
  await drainDueJobs();
});
```

A similar live mutex can be used around a narrow maintenance/reconciliation section.

### What Web Locks must NOT become

Web Locks are not durable state.

If the extension service worker, page, or browser process dies, the lock is gone. There is no fencing token preserved across restart and no durable record proving which run still has authority.

Therefore Web Locks cannot replace:

- the Dexie per-chat mutation lease;
- lease expiry;
- ownerRunId;
- durable fencing token;
- effect journal;
- AMBIGUOUS side-effect handling.

The correct relationship is:

```text
Web Lock
  = best-effort live collision suppression

Dexie lease + fencing
  = durable mutation authority
```

### Content-script caution

Web Locks are origin-scoped. Nika should not rely on a lock acquired from a ChatGPT content-script execution context as the authoritative extension-wide lock. Coordination belongs in the extension runtime/background side, while content scripts remain browser/site executors.

### Dependency decision

**Do not install a Web Locks library.** Chrome already has the native API.

A polyfill such as `navigator.locks` exists and is MIT-licensed, but Nika is currently Chrome-first and does not need the compatibility cost.

Reference only:

- https://github.com/aermin/web-locks

### Recommendation

**ADOPT NATIVE API AS AN OPTIONAL FAST-PATH GUARD**, after feature detection.

Do not block the runtime architecture on it and do not store correctness assumptions in it.

---

## 2. Scheduling: separate recurrence calculation from wake-up

The earlier decision remains correct:

`chrome.alarms` must not be the schedule database.

Nika needs a durable schedule record in Dexie, then computes `nextDueAt`, and uses a small number of Chrome alarms only to wake the runtime.

A schedule record should remain structurally readable and editable by the accessible UI, for example:

```ts
type ScheduleRule =
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'daily'; localTime: string; timeZone: string }
  | { kind: 'weekly'; weekdays: number[]; localTime: string; timeZone: string }
  | { kind: 'once'; at: string }
  | { kind: 'cron'; expression: string; timeZone: string };
```

The user-facing editor should prefer the first four structured forms. Cron should be an advanced option, not the primary UI.

---

## 3. cron-parser: strong candidate for advanced recurrence

`cron-parser` is currently a strong reusable candidate:

- current npm version observed in this research: `5.10.0`;
- MIT license;
- built-in TypeScript declarations;
- timezone support;
- DST handling;
- iterator/next-occurrence support;
- browser field present in package metadata;
- one production dependency (`luxon`);
- very high ecosystem adoption.

Sources:

- https://www.npmjs.com/package/cron-parser
- https://github.com/harrisiirak/cron-parser

### Why it is useful

Nika should not implement its own cron grammar, DST calculations, last-day syntax, weekday parsing, and iteration edge cases.

A future advanced schedule such as:

```text
0 9 * * 1-5
```

can be parsed into the next due timestamp by `cron-parser`, while Nika still owns:

- missed-run policy;
- `RUN_ONCE_NOW` / `SKIP` / limited catch-up;
- job creation;
- pacing;
- rate-limit/cooldown policy;
- durable schedule history.

### Important provenance lesson

The project recently had a release where an npm tarball was built from stale `dist` and was deprecated in favor of the next version. This is not a reason to reject the library, but it is another reason to pin tested versions and run Nika's own recurrence fixtures during dependency upgrades.

Reference:

- https://github.com/harrisiirak/cron-parser/releases

### Decision

**STRONG CANDIDATE, NOT REQUIRED FOR THE FIRST MVP.**

Add it when the schedule UI gains an advanced cron mode. Do not add it merely to implement `every 60 minutes`.

---

## 4. RRULE libraries: useful later, not first choice now

RFC 5545 recurrence rules are better than cron for calendar-style schedules such as:

- every second Monday;
- last Friday of every month;
- a recurrence with COUNT/UNTIL;
- calendar interoperability.

There are mature and newer RRULE implementations. The long-established `rrule.js` family uses a permissive BSD-style license. A newer TypeScript-first implementation, `@martinhipp/rrule`, is MIT and supports RFC 5545 plus timezone handling, but currently has very low npm adoption.

Sources:

- https://github.com/jkbrzt/rrule
- https://www.npmjs.com/package/@martinhipp/rrule

### Decision

**DO NOT ADD AN RRULE LIBRARY YET.**

Nika's current workload is interval/hourly/manual scheduling, not calendar interoperability. If the product later needs complex calendar recurrence or Google Calendar-style semantics, evaluate RRULE again.

---

## 5. Accessibility: axe-core is a high-value test dependency

`axe-core` is a mature open-source accessibility engine maintained by Deque.

Current research observed:

- `axe-core` version `4.13.0`;
- MPL-2.0 license;
- zero runtime dependencies in the core npm package;
- WCAG 2.0/2.1/2.2 rule coverage;
- Chrome and Firefox tested regularly;
- designed for automated UI testing.

Source:

- https://www.npmjs.com/package/axe-core

For Nika-agent, the more direct integration is `@axe-core/playwright`, also currently `4.13.0`, which injects axe into Playwright pages and frames.

Source:

- https://www.npmjs.com/package/@axe-core/playwright

### Why this matters for Nika

Nika is NVDA-first. Automated accessibility checks cannot prove NVDA usability, but they can catch a large class of regressions before human testing:

- missing labels;
- invalid ARIA;
- name/role/value failures;
- contrast issues;
- focusable elements hidden incorrectly;
- malformed headings/landmarks;
- form-control accessibility defects.

### Recommended test gate

For the Side Panel and full extension page:

```text
Playwright loads extension UI
↓
keyboard smoke path
↓
@axe-core/playwright scan
↓
fail CI on serious/critical violations
↓
separate manual NVDA gate remains mandatory
```

Do not treat `axe = green` as `NVDA_VERIFIED=true`.

### Decision

**ADOPT `@axe-core/playwright` AS A DEV DEPENDENCY WHEN PLAYWRIGHT E2E IS WIRED.**

This is higher-value than adding another browser automation framework.

---

## 6. `tabbable` and `focus-trap`: targeted UI helpers, not baseline infrastructure

`tabbable` is a small MIT library that computes tabbable/focusable DOM nodes and handles browser edge cases around `contenteditable`, `details`, visibility, `inert`, and tabindex.

Current research observed:

- `tabbable` version `6.5.0`;
- MIT;
- zero dependencies;
- very high adoption.

Source:

- https://www.npmjs.com/package/tabbable

`focus-trap` builds on it to implement accessible modal/dialog focus containment and focus restoration.

Current research observed:

- `focus-trap` version `8.2.2`;
- MIT;
- one dependency (`tabbable`).

Source:

- https://www.npmjs.com/package/focus-trap

### Nika decision

The best accessibility strategy remains **native semantic HTML with minimal custom focus mechanics**.

Therefore:

- do not add `focus-trap` merely because it exists;
- avoid modal-heavy UX where a normal page/section works;
- if a real modal/dialog is introduced, prefer `focus-trap` instead of writing custom Tab/Escape/focus-return logic;
- `tabbable` can be useful in keyboard/focus tests or a custom roving-focus widget, but should not become a generic DOM-selection dependency for ChatGPT automation.

The ChatGPT `SemanticSnapshotBuilder` remains based on ARIA/accessibility semantics and site adapters, not focusability alone.

---

## 7. Updated dependency matrix

### Adopt now / next test wave

- `@webext-core/messaging` v4 — typed extension messaging;
- Dexie — durable IndexedDB state;
- XState — persisted workflow semantics;
- `p-queue` — live dispatcher/backpressure;
- `dom-accessibility-api` — semantic DOM naming;
- `@axe-core/playwright` — accessibility E2E gate once Playwright tests are active.

### Native browser features to reuse directly

- `chrome.alarms` — wake-up only;
- `MutationObserver` — site-state observation;
- **Web Locks API** — optional live dispatcher/maintenance mutex;
- `chrome.storage.session` — ephemeral browser-session cache.

### Add only when the feature exists

- `cron-parser` — advanced cron recurrence mode;
- `focus-trap` — only if real modal/dialog UI requires it;
- `tabbable` — only for concrete focus-management/testing needs.

### Do not add now

- RRULE engine;
- Web Locks polyfill;
- another generic workflow engine;
- another generic browser-control framework;
- custom cron parser;
- custom modal focus trap.

---

## 8. Revised coordination model

For a due-job dispatch cycle:

```text
chrome alarm/manual event
↓
optional navigator.locks('nika:dispatcher')
↓
Dexie transaction: find/claim due jobs
↓
p-queue pacing/concurrency
↓
per-chat durable lease + fencing token
↓
Effect Journal PREPARE
↓
ChatGPTAdapter action + postcondition
↓
COMMITTED / AMBIGUOUS / FAILED
```

This layering matters:

- Web Lock prevents wasteful live re-entry;
- Dexie claim prevents restart/concurrency corruption;
- p-queue prevents bursts;
- lease/fencing protects one chat;
- Effect Journal protects external side-effect recovery.

No one layer substitutes for the others.

---

## 9. Revised accessibility acceptance model

Nika UI acceptance should have four separate layers:

1. **semantic component tests** — names, roles, labels, IDs, keyboard commands;
2. **Playwright keyboard E2E** — no mouse required for core journeys;
3. **axe scan** — automated WCAG defect detection;
4. **real NVDA verification** — still the only source of `NVDA_VERIFIED=true`.

Recommended first user journey for this gate:

```text
Open Nika-agent
→ navigate Projects/Chats/Workflows/Schedules with keyboard
→ create/edit one schedule
→ Run now
→ inspect Runs/Logs
→ return focus correctly
```

The same journey should run through Playwright + axe before manual NVDA testing.

---

## 10. Next implementation/research slices

1. Add a small feature-detected `withRuntimeLock(name, fn)` wrapper around native Web Locks and test overlapping dispatcher calls.
2. Keep durable Dexie lease/fencing as the authority; add a crash test proving the Web Lock is not required for correctness.
3. Implement structured `ScheduleRule` first; add fixture tests for DST/timezone behavior.
4. Spike `cron-parser` only when advanced cron schedules are exposed.
5. Wire Playwright extension E2E.
6. Add `@axe-core/playwright` and fail tests on serious/critical accessibility violations.
7. Add keyboard-only E2E before introducing any focus-management library.
8. If a modal is genuinely needed, compare native `<dialog>` behavior with `focus-trap` rather than writing a custom trap.

## Final recommendation

The main value of this cycle is restraint: Nika can reuse more browser-native and mature small libraries without bloating its runtime.

The best additions are **native Web Locks as an ephemeral coordination optimization** and **axe/Playwright as an accessibility quality gate**. `cron-parser` is mature enough to adopt later for advanced schedules, but should not distort the accessible schedule UI into a cron editor.

The core correctness architecture remains unchanged: **durable state in Dexie, workflows in XState, paced execution through p-queue, semantic ChatGPT control with explicit postconditions, and human NVDA verification as a separate release gate.**