import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/db', () => ({
  acquireAgentLease: vi.fn(),
  getRecoverableRuns: vi.fn(),
  getRun: vi.fn(),
  putRun: vi.fn(),
  releaseAgentLease: vi.fn(),
  startLeaseHeartbeat: vi.fn(),
  updateRun: vi.fn(),
}));

vi.mock('../src/storage', () => ({
  appendLog: vi.fn(),
  getAgents: vi.fn(),
  getWorkflows: vi.fn(),
}));

vi.mock('../src/runtime', () => ({
  captureAgentResponse: vi.fn(),
  sendToAgent: vi.fn(),
  waitForAgentIdle: vi.fn(),
}));

import { interpolate } from '../src/workflow';

describe('workflow interpolation', () => {
  it('replaces known context keys', () => {
    const context = new Map([
      ['developer.output', 'implementation'],
      ['audit', 'approved'],
    ]);

    expect(interpolate('Result: {{developer.output}} / {{audit}}', context)).toBe(
      'Result: implementation / approved',
    );
  });

  it('preserves unresolved placeholders instead of silently deleting them', () => {
    const context = new Map<string, string>();

    expect(interpolate('Audit {{missing.key}}', context)).toBe('Audit {{missing.key}}');
  });
});
