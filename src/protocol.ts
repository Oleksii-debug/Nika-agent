import * as v from 'valibot';

export const PROTOCOL_VERSION = 1 as const;
export const ADAPTER_VERSION = 'chatgpt-dom-v1' as const;
export const SITE_PROFILE_VERSION = 'chatgpt-2026-08-v1' as const;

const commandBase = {
  protocolVersion: v.literal(PROTOCOL_VERSION),
  commandId: v.pipe(v.string(), v.minLength(1)),
};

export const BrowserCommandV1Schema = v.variant('type', [
  v.object({ ...commandBase, type: v.literal('status') }),
  v.object({
    ...commandBase,
    type: v.literal('send'),
    prompt: v.pipe(v.string(), v.minLength(1)),
  }),
  v.object({ ...commandBase, type: v.literal('captureLatest') }),
  v.object({ ...commandBase, type: v.literal('runtime.health') }),
]);

export const RuntimeHealthV1Schema = v.object({
  protocolVersion: v.literal(PROTOCOL_VERSION),
  adapterVersion: v.string(),
  siteProfileVersion: v.string(),
  documentEpoch: v.string(),
  observedUrl: v.string(),
  capabilities: v.array(v.picklist(['READ', 'WRITE', 'OBSERVE'])),
  state: v.picklist(['idle', 'generating']),
});

export const ActionResultV1Schema = v.union([
  v.object({
    protocolVersion: v.literal(PROTOCOL_VERSION),
    commandId: v.string(),
    ok: v.literal(true),
    state: v.optional(v.picklist(['generating', 'idle'])),
    text: v.optional(v.string()),
    health: v.optional(RuntimeHealthV1Schema),
  }),
  v.object({
    protocolVersion: v.literal(PROTOCOL_VERSION),
    commandId: v.string(),
    ok: v.literal(false),
    code: v.picklist([
      'INVALID_COMMAND',
      'PROTOCOL_VERSION_UNSUPPORTED',
      'ADAPTER_VERSION_MISMATCH',
      'TARGET_UNAVAILABLE',
      'TARGET_AMBIGUOUS',
      'TARGET_NOT_ACTIONABLE',
      'CHAT_GENERATING',
      'EMPTY_RESPONSE',
      'INTERNAL_ERROR',
    ]),
    error: v.string(),
  }),
]);

export type BrowserCommandV1 = v.InferOutput<typeof BrowserCommandV1Schema>;
export type RuntimeHealthV1 = v.InferOutput<typeof RuntimeHealthV1Schema>;
export type ActionResultV1 = v.InferOutput<typeof ActionResultV1Schema>;
export type ActionErrorCode = Extract<ActionResultV1, { ok: false }>['code'];

export function parseBrowserCommand(input: unknown): BrowserCommandV1 | null {
  const parsed = v.safeParse(BrowserCommandV1Schema, input);
  return parsed.success ? parsed.output : null;
}

export function parseActionResult(input: unknown): ActionResultV1 | null {
  const parsed = v.safeParse(ActionResultV1Schema, input);
  return parsed.success ? parsed.output : null;
}

export function successResult(
  commandId: string,
  payload: Omit<Extract<ActionResultV1, { ok: true }>, 'protocolVersion' | 'commandId' | 'ok'> = {},
): ActionResultV1 {
  return {
    protocolVersion: PROTOCOL_VERSION,
    commandId,
    ok: true,
    ...payload,
  };
}

export function errorResult(commandId: string, code: ActionErrorCode, error: string): ActionResultV1 {
  return {
    protocolVersion: PROTOCOL_VERSION,
    commandId,
    ok: false,
    code,
    error,
  };
}
