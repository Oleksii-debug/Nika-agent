# ChatGPT Adapter Contract

## Status

Architecture contract for the DOM-facing boundary of Nika-agent. This document is intentionally independent of current ChatGPT selectors. Selectors are implementation details; observable behavior is the contract.

## Purpose

Nika-agent automates the signed-in ChatGPT web UI without the OpenAI API. The ChatGPT adapter is the only subsystem allowed to know ChatGPT DOM structure. Scheduler, workflows, storage and UI must depend on typed adapter results, never selectors.

## Design goals

1. Survive ordinary ChatGPT DOM churn by localizing repairs.
2. Avoid duplicate prompts after ambiguous transport or service-worker termination.
3. Distinguish idle, generating, blocked, logged-out and unknown states.
4. Capture the exact latest assistant turn without relying only on the visible Copy button.
5. Keep all reads side-effect free and all writes explicit.
6. Provide deterministic evidence that QA can fixture-test offline.
7. Preserve keyboard/NVDA behavior: automation must not steal focus unless an operation explicitly requires it.

## Adapter API

```ts
export type ChatState =
  | 'idle'
  | 'generating'
  | 'blocked'
  | 'logged_out'
  | 'rate_limited'
  | 'navigation_pending'
  | 'unsupported'
  | 'unknown';

export type StateEvidence = {
  state: ChatState;
  composerPresent: boolean;
  composerEditable: boolean;
  sendControlPresent: boolean;
  stopControlPresent: boolean;
  assistantTurnCount: number;
  latestAssistantTurnId?: string;
  latestUserTurnId?: string;
  mutationAgeMs?: number;
  visibleError?: string;
  confidence: 'high' | 'medium' | 'low';
};

export type SendReceipt = {
  status: 'confirmed' | 'ambiguous' | 'rejected';
  normalizedPromptHash: string;
  userTurnId?: string;
  observedAt: string;
  detail?: string;
};

export type CapturedTurn = {
  turnId: string;
  text: string;
  normalizedTextHash: string;
  observedAt: string;
};

export interface ChatAdapter {
  inspect(): Promise<StateEvidence>;
  waitForIdle(options: WaitForIdleOptions): Promise<StateEvidence>;
  send(prompt: string, intent: SendIntent): Promise<SendReceipt>;
  verifyPromptPresence(intent: SendIntent): Promise<PromptPresenceResult>;
  captureLatestAssistant(options?: CaptureOptions): Promise<CapturedTurn>;
}
```

## Send intent and idempotency

Every send operation must be created before DOM mutation with a durable `intentId` and `promptHash`.

```ts
export type SendIntent = {
  intentId: string;
  runId: string;
  agentId: string;
  promptHash: string;
  createdAt: string;
  expectedPreviousUserTurnId?: string;
  expectedPreviousAssistantTurnId?: string;
};
```

The runtime must persist the intent before calling `adapter.send()`.

If `send()` returns `confirmed`, the runtime records the observed user turn and may advance.

If the service worker dies or transport fails after the DOM write may have happened, the result is `ambiguous`. Nika-agent MUST NOT automatically send the prompt again. It first calls `verifyPromptPresence(intent)` after recovery.

Verification order:

1. Match a user turn created after `intent.createdAt` using exact normalized prompt hash.
2. Prefer stable ChatGPT turn/message identifiers when exposed in DOM attributes.
3. Fall back to normalized text plus temporal and adjacency evidence.
4. If one unique match exists: mark send confirmed.
5. If no match exists and chat is safely idle: a policy-controlled retry may occur.
6. If multiple plausible matches exist: enter `needs_review`; never blind retry.

## State detection

A single selector is insufficient. `inspect()` aggregates evidence.

### High-confidence generating

Any strong streaming evidence plus at least one corroborating signal:

- Stop-generation control is present and enabled;
- latest assistant node is receiving mutations;
- composer/send control is disabled in a generation-specific way;
- streaming/status affordance is exposed through accessible name or page state.

### High-confidence idle

All of the following should hold for at least `settleMs`:

- no stop-generation control;
- no assistant streaming mutations;
- composer is present and editable;
- latest assistant turn identity/text has stabilized;
- page is not navigating;
- no modal/error state blocks submission.

### Unknown

Unknown is a valid safe state. It means the adapter lacks enough evidence. The workflow must wait, retry inspection, or escalate; it must not infer idle merely because the Stop button is absent.

## DOM stabilization

The content adapter maintains a `MutationObserver` over the narrowest stable chat transcript root available.

Track:

- last relevant mutation timestamp;
- assistant turn count;
- latest assistant turn identity;
- latest assistant normalized text hash.

Idle stabilization requires no relevant mutation for configured `settleMs` (default architecture target: 1500-3000 ms, configurable).

Ignore irrelevant mutations such as tooltips, hover affordances, timestamp decorations and unrelated navigation chrome.

## Composer discovery

Discovery must use layered strategies, ordered from semantic to structural:

1. native/ARIA textbox semantics and accessible labels;
2. known contenteditable role/name patterns;
3. bounded structural fallback within the composer region.

Never use screen coordinates.

The adapter must validate that the selected element is editable and belongs to the active conversation before writing.

## Sending text

Preferred algorithm:

1. Inspect and require a send-safe state.
2. Focus composer only for the minimal mutation window.
3. Use browser-compatible DOM input semantics that trigger the framework's controlled-input events.
4. Re-read composer to verify inserted text.
5. Activate the semantic Send control when available; keyboard submission is fallback only when its behavior is proven by fixture/e2e tests.
6. Observe creation of a new user turn.
7. Return `confirmed` only after user-turn evidence exists.

The adapter must not retry a write merely because `chrome.tabs.sendMessage` failed after dispatch.

## Capturing responses

The authoritative capture path is transcript DOM extraction, not clipboard access.

Priority:

1. Identify latest assistant turn.
2. Extract accessible/rendered textual content from that turn.
3. Normalize only transport artifacts (e.g. duplicated hidden accessibility labels), preserving user-visible content and paragraph boundaries.
4. Compute content hash.
5. Optionally compare against the ChatGPT Copy control result in QA/debug mode.

The Copy button may be exposed as an auxiliary adapter capability, but workflows must not depend on clipboard permission to transfer responses between chats.

This means the user's desired "press Copy then send elsewhere" workflow is implemented semantically as `captureLatestAssistant -> route text`, which is more reliable and produces the same usable result.

## Navigation and tabs

The adapter does not own tab scheduling. Runtime provides a tab that should correspond to one configured ChatTarget URL.

Before every mutation, adapter validates:

- URL host is allowed;
- URL is not login/auth challenge;
- conversation appears loaded;
- target is not mid-navigation.

If URL changed unexpectedly, return `navigation_pending` or `unsupported` rather than mutating the page.

## Error taxonomy

Adapter errors are typed:

- `ADAPTER_NOT_INJECTED`
- `CHAT_NOT_LOADED`
- `COMPOSER_NOT_FOUND`
- `COMPOSER_NOT_EDITABLE`
- `SEND_CONTROL_NOT_FOUND`
- `PROMPT_INSERT_FAILED`
- `SEND_AMBIGUOUS`
- `PROMPT_DUPLICATE_AMBIGUOUS`
- `WAIT_IDLE_TIMEOUT`
- `LATEST_ASSISTANT_NOT_FOUND`
- `RESPONSE_EMPTY`
- `LOGIN_REQUIRED`
- `RATE_LIMITED`
- `BLOCKING_MODAL`
- `UNSUPPORTED_DOM`

Errors include evidence snapshots, but never cookies, auth headers or browser-session secrets.

## Recovery policy

Read operations (`inspect`, capture after an already-confirmed run) may retry with bounded exponential backoff and may request content-script reinjection/reload.

Write operations are non-retryable until idempotency reconciliation has proved that the previous write did not occur.

Reloading an actively generating tab is forbidden except explicit user recovery; it may destroy generation state.

## Fixture matrix

Every adapter implementation change must run against stored HTML/DOM fixtures or synthetic component fixtures covering at least:

| Fixture | Expected state/action |
| --- | --- |
| Empty new chat, composer ready | idle; send allowed |
| Existing completed chat | idle; capture latest assistant |
| Assistant streaming with Stop control | generating |
| Streaming mutation but Stop control missing | generating/medium confidence, never idle |
| Stop control present after mutations stop | generating until control clears |
| Composer disabled due generation | generating |
| Composer missing during navigation | navigation_pending/unknown |
| Logged-out landing page | logged_out |
| Rate-limit/error banner | rate_limited or blocked |
| Blocking modal | blocked |
| Unsupported changed DOM | unsupported/unknown |
| Response with code blocks/lists | capture preserves textual structure |
| Response containing hidden labels | no duplicated UI label text |
| Two identical assistant responses | latest turn chosen by identity/order |
| Prompt send confirmed by new user turn | confirmed receipt |
| Transport exception after user turn inserted | verifyPromptPresence confirms, no resend |
| Transport exception before insertion | verification absent; policy may retry once |
| Duplicate matching user turns | needs_review; no automatic resend |
| Background/inactive tab | operations succeed without tab focus |

## E2E acceptance gates

1. User may switch to another app/window while an inactive ChatGPT tab is automated.
2. Extension must not require its popup/side panel to remain focused.
3. No duplicate prompt after simulated service-worker termination immediately after DOM submit.
4. No send while response is still streaming, including fixture where Stop selector is deliberately missing.
5. Response forwarding works without system clipboard.
6. DOM selector break produces `unsupported/unknown`, audit log and safe stop, not random clicks.
7. Keyboard focus returns predictably after manual UI actions; background automation never steals focus to foreground a tab.

## Selector maintenance rule

Selectors and heuristics live in one adapter module and are versioned as a selector profile. A selector-profile change requires:

- fixture updates;
- adapter unit tests;
- at least one live smoke test;
- no changes to scheduler/workflow contracts unless semantics actually change.

## External implementation references

- Chrome Extensions MV3 service worker and messaging documentation: https://developer.chrome.com/docs/extensions/
- WXT framework documentation: https://wxt.dev/
- Playwright extension testing reference: https://playwright.dev/docs/chrome-extensions

No third-party ChatGPT automation repository is adopted wholesale. Reuse is preferred for extension/runtime infrastructure; ChatGPT DOM behavior remains a narrow Nika-owned adapter because it is product-specific and changes independently.