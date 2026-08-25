# Managed editors, text injection, and commit semantics

Date: 2026-08-25
Repository: `Oleksii-debug/Nika-agent`

## Executive decision

The next browser-automation reliability gap is text entry itself.

Nika's current ChatGPT content script treats text entry as a generic DOM operation: for native inputs it sets `.value` through the prototype setter and dispatches `input/change`; for contenteditable it assigns `textContent` and dispatches a synthetic `InputEvent`.

That is not a safe generic model for modern web applications. Lexical, ProseMirror/TipTap, Draft.js, Quill, Slate and React-controlled fields frequently maintain their own state and selection models. The DOM is often only rendered output. Direct DOM mutation can be reverted, partially accepted, lose newlines, fail to update framework state, or create multiple undo entries.

The recommended architecture is therefore:

`TargetRecipe -> EditorDetector -> TextInputAdapter -> WriteStrategy -> ReadBack -> CommitSignal -> EffectProof`

Text entry must become a first-class capability with editor-specific strategies and post-write verification. It must not remain an implementation detail inside `sendPrompt()`.

---

## 1. Current Nika code-level gap

`entrypoints/chatgpt.content.ts::setComposerText()` currently does two things:

1. native input/textarea: call native `value` setter, then dispatch `input` and `change`;
2. contenteditable: `editor.textContent = prompt`, then dispatch a synthetic `InputEvent(inputType='insertText')`.

The second path is particularly risky for managed rich editors. Even the first path is not universal for React/Vue/Svelte controlled fields because the page framework may require its own event sequence, focus/blur transition, or real keyboard-style input.

This means today's SEND safety work can still fail before the click: Nika can believe it placed prompt P into the composer even when the site's internal editor state contains something else.

New invariant:

> A WRITE that depends on entered text cannot advance to submit until Nika reads the editable surface back and proves that the normalized editor value equals the intended value.

---

## 2. Strongest reusable reference: OpenCues Chrome adapter

Repository: https://github.com/opencues/opencues
License: Apache-2.0.

OpenCues contains a Chrome integration with explicit handling for managed contenteditable editor families. Its documented matrix includes:

- Lexical;
- ProseMirror / TipTap;
- Draft.js;
- Quill;
- generic contenteditable;
- site-specific compatibility carve-outs.

The important reusable pattern is not a single magic event. It is an **editor-family strategy ladder**.

Examples documented by the project:

- Lexical: use the Lexical editor API when reachable; otherwise use an editor-compatible select-all + paste path;
- Draft.js: select-all through its keyboard pipeline, then paste text so the framework performs one replace-selection transaction;
- ProseMirror / ChatGPT / Claude-like surfaces: use a replace-selection operation that the editor consumes as one transaction rather than manually rewriting child DOM;
- Quill: prefer its editor API / Delta model when available;
- generic contenteditable: browser editing commands/events can be sufficient.

OpenCues also records a critical undo invariant: whole-text replacement should emit one history-producing operation. A two-step `delete -> insert` sequence can create two undo entries or cause framework reconcilers to restore part of the DOM.

### Reuse decision

**Adopt the architecture now.**

**Selective source reuse is legally possible** because the repository is Apache-2.0, provided license/NOTICE/attribution obligations are preserved.

Do not copy the whole integration. Extract or reimplement only the small editor-detection and replacement-strategy concepts needed by Nika, with independent tests.

Source references:

- https://github.com/opencues/opencues/blob/master/integrations/chrome/CLAUDE.md
- https://github.com/opencues/opencues/blob/master/integrations/chrome/src/opencues-bootstrap.ts
- https://github.com/opencues/opencues/blob/master/LICENSE

---

## 3. Why there is no universal `setText()`

Recent browser-agent failures confirm the problem is not theoretical.

A 2026 Hermes Agent issue documents failures on modern React applications:

- Lexical contenteditable accepted some CDP insertion but newline handling and editor state could desynchronize;
- a React-controlled textarea ignored direct native value setter + synthetic input/change in that application;
- char-by-char key dispatch worked but was slow;
- custom sliders required a different interaction model.

Browser-use has separately had bugs involving lost first characters in Draft.js-like X/Twitter editors and missing paragraph breaks in Lexical contenteditables.

Therefore Nika should explicitly model editor compatibility rather than hide these differences behind one DOM helper.

References:

- https://github.com/NousResearch/hermes-agent/issues/80602
- https://github.com/browser-use/browser-use/issues/3889
- https://github.com/browser-use/browser-use/issues/2966

---

## 4. Proposed `EditorKind`

Start with a small detector:

```ts
export type EditorKind =
  | 'native_input'
  | 'native_textarea'
  | 'generic_contenteditable'
  | 'lexical'
  | 'prosemirror'
  | 'tiptap'
  | 'draftjs'
  | 'quill'
  | 'slate'
  | 'unknown_managed';
```

Typical detection hints:

- `[data-lexical-editor="true"]` -> Lexical;
- `.ProseMirror` -> ProseMirror / often TipTap;
- `.public-DraftEditor-content`, `[data-block="true"]` -> Draft.js;
- `.ql-editor` / `.ql-container` -> Quill;
- `[data-slate-editor="true"]` -> Slate.

Detection is evidence, not permission. SiteProfile may override the detected family when a site has a known specialized editor behavior.

---

## 5. Proposed `TextWriteStrategy`

```ts
export type TextWriteStrategy =
  | 'NATIVE_VALUE_SETTER'
  | 'PLAYWRIGHT_LIKE_FILL'
  | 'EDITOR_API'
  | 'REPLACE_SELECTION_PASTE'
  | 'REPLACE_SELECTION_BEFOREINPUT'
  | 'KEYBOARD_SEQUENCE'
  | 'CDP_INSERT_TEXT'
  | 'SITE_SPECIFIC';
```

This is a strategy identity, not an instruction to automatically use privileged CDP.

Recommended escalation:

1. site-profile known strategy;
2. native setter for real input/textarea;
3. editor-family known strategy;
4. generic contenteditable strategy;
5. keyboard-style sequence;
6. privileged transport only if explicitly enabled and tested;
7. fail closed.

Never silently jump from a failed DOM write to raw CDP for a mutating action without policy/permission.

---

## 6. Playwright and Puppeteer are useful references, not production dependencies

Playwright's `locator.fill()` supports `<input>`, `<textarea>` and `[contenteditable]`, focuses the element and triggers input semantics. It also exposes sequential typing for applications that depend on key handlers.

Puppeteer's `Keyboard.type()` generates keydown / keypress-or-input / keyup per character.

These APIs reinforce the need to distinguish:

- bulk fill;
- sequential keyboard input;
- editor-specific replacement.

However neither framework solves every managed-editor case automatically, and pulling Playwright/Puppeteer into an MV3 extension would be far too heavy.

Use them as E2E oracles and fixture drivers, not as Nika's production text engine.

References:

- https://playwright.dev/docs/input
- https://pptr.dev/api/puppeteer.keyboard.type

---

## 7. Synthetic event trust boundary

Events created with `new Event()` / `new InputEvent()` are synthetic. Some sites or anti-automation logic can distinguish such events from browser-generated input.

Browser-use has an explicit issue documenting this `isTrusted` distinction.

This does **not** mean Nika should immediately adopt `chrome.debugger` to obtain lower-level input. It means the text engine needs a recorded `InputTrustLevel` so failures can be classified instead of endlessly changing selectors.

```ts
export type InputTrustLevel =
  | 'DOM_SYNTHETIC'
  | 'FRAMEWORK_API'
  | 'KEYBOARD_TRANSPORT'
  | 'PRIVILEGED_BROWSER_INPUT';
```

Reference:

- https://github.com/browser-use/browser-use/issues/3829

---

## 8. CDP input is an escalation tool, not a universal answer

Chrome DevTools Protocol exposes `Input.dispatchKeyEvent` and experimental `Input.insertText`.

`Input.insertText` is designed for text insertion that is not naturally represented as a key press, such as IME/emoji input. `dispatchKeyEvent` can emulate the keyboard event sequence.

These APIs are useful for a future privileged adapter, but they do not eliminate editor-specific behavior: applications can still maintain internal models and special newline/selection semantics.

Therefore:

`CDP input != guaranteed editor state`.

It still needs read-back and EffectProof.

References:

- https://chromedevtools.github.io/devtools-protocol/tot/Input/
- https://github.com/ChromeDevTools/devtools-protocol

---

## 9. Read-back must precede submit

Add a `TextWriteResult` that separates transport from proof:

```ts
interface TextWriteResult {
  editorKind: EditorKind;
  strategy: TextWriteStrategy;
  trustLevel: InputTrustLevel;
  intendedHash: string;
  observedHash?: string;
  observedText?: string;
  selectionState?: 'known' | 'unknown';
  outcome:
    | 'VERIFIED'
    | 'NO_EFFECT'
    | 'PARTIAL_EFFECT'
    | 'WRONG_VALUE'
    | 'EDITOR_REVERTED'
    | 'AMBIGUOUS';
}
```

For ChatGPT SEND:

`write composer -> wait microtask/quiet tick -> read normalized composer -> compare hash -> only then permit submit`.

If the page reverts direct DOM mutation after a MutationObserver/framework reconciliation tick, outcome is `EDITOR_REVERTED`, not success.

---

## 10. Commit semantics matter separately from text presence

A separate class of application behavior commits a field only after blur, Tab, Enter, change or another editor-specific signal.

Browser-use has a current 2026 feature request caused by UIs where values appear changed but are lost unless the field is explicitly exited/blurred before Save.

Therefore future generic forms need:

```ts
type CommitPolicy =
  | 'INPUT_EVENT_SUFFICIENT'
  | 'CHANGE_REQUIRED'
  | 'BLUR_REQUIRED'
  | 'ENTER_REQUIRED'
  | 'TAB_REQUIRED'
  | 'SITE_SPECIFIC';
```

Do not globally fire blur after every write. The SiteProfile/editor strategy should define the commit policy, and the postcondition should verify the committed value after the transition.

Reference:

- https://github.com/browser-use/browser-use/issues/5054

---

## 11. Undo/history is part of correctness

Nika will sometimes operate in the same live browser in which the user works manually.

A write strategy that creates five history entries for one logical replacement is harmful even when the final text is correct. Pressing Ctrl+Z later can leave the user's editor in an unexpected intermediate state.

Required invariant for whole-buffer replacement:

> Prefer one logical editor transaction / one undo entry.

The OpenCues implementation explicitly tests this across managed editor families. Nika should build the same kind of fixture tests.

---

## 12. Testing-library `user-event`

`@testing-library/user-event` is useful as a **test-only event-sequence oracle**. Its purpose is to model higher-level user interactions rather than calling `fireEvent` directly.

It should not become the production browser-input engine; jsdom/testing abstractions cannot prove compatibility with real Lexical/ProseMirror applications.

Use it in unit tests for expected focus/input/change/blur ordering, then validate strategies in real Chromium fixtures.

Reference:

- https://github.com/testing-library/user-event

---

## 13. Required fixture matrix

Before calling GenericWebAdapter reliable, create real-browser fixture pages for:

1. plain input;
2. plain textarea;
3. generic contenteditable;
4. React-controlled input;
5. Lexical;
6. ProseMirror;
7. TipTap;
8. Draft.js;
9. Quill;
10. Slate;
11. multiline input with `\n` and blank paragraphs;
12. unicode / emoji / IME-like text;
13. field requiring blur to commit;
14. field requiring Enter to commit;
15. framework rerender immediately after write;
16. editor that reverts direct DOM mutation;
17. user Ctrl+Z after replacement;
18. user takes control between write and submit.

For every fixture assert:

- final visible text;
- framework/editor model where inspectable;
- newline preservation;
- one logical undo operation where feasible;
- commit/postcondition;
- no stale callback mutates after navigation/control handoff.

---

## 14. New Nika module boundary

Recommended modules:

- `EditorDetector`
- `TextInputAdapter`
- `TextWriteStrategyRegistry`
- `NativeInputStrategy`
- `ManagedContentEditableStrategy`
- `EditorReadback`
- `CommitPolicyEvaluator`
- `TextWriteEvidence`

ChatGPTAdapter should call this boundary rather than directly mutating `textContent`.

SiteProfile can provide:

```ts
editor: {
  kind: 'prosemirror',
  writeStrategy: 'REPLACE_SELECTION_BEFOREINPUT',
  commitPolicy: 'INPUT_EVENT_SUFFICIENT',
  normalize: 'plain_text'
}
```

The exact ChatGPT engine must be detected/tested at runtime rather than permanently assumed from one external project's current observation.

---

## 15. Dependency decision

### Adopt / reuse now

- OpenCues editor-strategy architecture and selected Apache-2.0 implementation ideas;
- native DOM/editor APIs;
- existing SiteProfile architecture;
- real-browser Playwright fixtures.

### Test-only

- `@testing-library/user-event` if its event-sequence coverage saves test code;
- Playwright as browser oracle.

### Do not add as extension production dependencies

- Playwright;
- Puppeteer;
- a full browser-agent framework;
- a generic rich-text editor framework merely to control someone else's editor.

### Privileged future spike only

- CDP `Input.dispatchKeyEvent` / `Input.insertText` behind `chrome.debugger` or LocalBridge transport.

---

## 16. Updated implementation priority

1. Extract current `setComposerText()` behind `TextInputAdapter`.
2. Add `EditorKind`, `TextWriteStrategy`, `InputTrustLevel`, `CommitPolicy`.
3. Add read-back hash verification before ChatGPT submit.
4. Add a microtask/quiet-window check to catch editor rollback.
5. Build Lexical + ProseMirror + Draft.js fixtures first.
6. Port/reimplement a minimal editor detection ladder informed by OpenCues.
7. Validate multiline and undo semantics.
8. Add `PARTIAL_EFFECT / WRONG_VALUE / EDITOR_REVERTED` evidence.
9. Make SEND settlement depend on both verified composer write and observed user-message creation.
10. Only after these tests decide whether ChatGPT requires a site-specific managed-editor strategy or the generic strategy is sufficient.
11. Add CDP input spike only if DOM/framework strategies prove insufficient.

---

## Final decision

For modern web automation, "find textbox and set text" is not one primitive.

The reliable model is:

`detect editor -> choose proven write strategy -> perform one logical replacement -> read back -> commit if required -> verify -> submit -> prove external effect`.

This should become a reusable core capability before Nika expands from ChatGPT to arbitrary modern SaaS interfaces.