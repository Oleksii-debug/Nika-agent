import { describe, expect, it } from 'vitest';
import {
  buildTextWriteEvidence,
  normalizeEditorText,
  verifyStableTextWrite,
} from '../src/text-input';

describe('text write evidence', () => {
  it('normalizes line endings without flattening paragraph boundaries', () => {
    expect(normalizeEditorText('  first\r\n\r\nsecond\u00a0line  ')).toBe('first\n\nsecond line');
  });

  it('confirms exact normalized readback', async () => {
    const evidence = await buildTextWriteEvidence(
      'hello\nworld',
      ' hello\r\nworld ',
      'lexical',
      'DOM_CONTENT_REPLACEMENT',
    );
    expect(evidence.outcome).toBe('VERIFIED');
    expect(evidence.observedHash).toBe(evidence.intendedHash);
  });

  it('classifies an empty readback as no effect', async () => {
    const evidence = await buildTextWriteEvidence('hello', '', 'native_textarea', 'NATIVE_VALUE_SETTER');
    expect(evidence.outcome).toBe('NO_EFFECT');
  });

  it('classifies a framework rollback between write and submit', async () => {
    const evidence = await verifyStableTextWrite(
      'do not duplicate this send',
      'do not duplicate this send',
      '',
      'lexical',
      'DOM_CONTENT_REPLACEMENT',
    );
    expect(evidence.outcome).toBe('EDITOR_REVERTED');
    expect(evidence.detail).toMatch(/changed before submit/i);
  });

  it('fails closed when observed content is the wrong value', async () => {
    const evidence = await verifyStableTextWrite(
      'intended prompt',
      'intended prompt',
      'different prompt',
      'generic_contenteditable',
      'DOM_CONTENT_REPLACEMENT',
    );
    expect(evidence.outcome).toBe('EDITOR_REVERTED');
  });
});
