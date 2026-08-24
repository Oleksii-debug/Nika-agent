import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  errorResult,
  parseActionResult,
  parseBrowserCommand,
  successResult,
} from './protocol';

describe('browser protocol v1', () => {
  it('accepts a valid send command', () => {
    const parsed = parseBrowserCommand({
      protocolVersion: PROTOCOL_VERSION,
      commandId: 'cmd-1',
      type: 'send',
      prompt: 'Continue development',
    });

    expect(parsed).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      commandId: 'cmd-1',
      type: 'send',
      prompt: 'Continue development',
    });
  });

  it('rejects unknown and newer protocol commands', () => {
    expect(parseBrowserCommand({ type: 'send', prompt: 'x' })).toBeNull();
    expect(
      parseBrowserCommand({
        protocolVersion: PROTOCOL_VERSION + 1,
        commandId: 'cmd-2',
        type: 'status',
      }),
    ).toBeNull();
  });

  it('rejects malformed action results', () => {
    expect(parseActionResult({ ok: true })).toBeNull();
    expect(
      parseActionResult({
        protocolVersion: PROTOCOL_VERSION,
        commandId: 'cmd-3',
        ok: false,
        code: 'UNRECOGNIZED_CODE',
        error: 'bad',
      }),
    ).toBeNull();
  });

  it('builds schema-valid success and failure results', () => {
    const success = successResult('cmd-4', { state: 'idle' });
    const failure = errorResult('cmd-5', 'TARGET_UNAVAILABLE', 'missing');

    expect(parseActionResult(success)).toEqual(success);
    expect(parseActionResult(failure)).toEqual(failure);
  });
});
