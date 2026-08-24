import { describe, expect, it } from 'vitest';
import { interpolate } from '../src/workflow';

describe('interpolate', () => {
  it('replaces known workflow outputs', () => {
    const context = new Map([
      ['developer.output', 'implementation result'],
      ['audit', 'audit result'],
    ]);

    expect(interpolate('Dev: {{developer.output}} / Audit: {{audit}}', context)).toBe(
      'Dev: implementation result / Audit: audit result',
    );
  });

  it('preserves unresolved placeholders for diagnostics', () => {
    expect(interpolate('Missing {{unknown.key}}', new Map())).toBe('Missing {{unknown.key}}');
  });
});
