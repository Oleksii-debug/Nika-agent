import type { EffectProofObservation } from './types';

export type EvaluateEffectProofInput = {
  baselinePageUrl?: string;
  observedPageUrl?: string;
  baselineUserTurnCount: number;
  observedUserTurnCount: number;
  matches: number;
  observedAt?: string;
};

export function evaluateSendEffectProof(input: EvaluateEffectProofInput): EffectProofObservation {
  const observation: EffectProofObservation = {
    outcome: 'ambiguous',
    baselineUserTurnCount: input.baselineUserTurnCount,
    observedUserTurnCount: input.observedUserTurnCount,
    matches: input.matches,
    observedAt: input.observedAt ?? new Date().toISOString(),
  };
  if (input.baselinePageUrl !== undefined) observation.baselinePageUrl = input.baselinePageUrl;
  if (input.observedPageUrl !== undefined) observation.observedPageUrl = input.observedPageUrl;

  if (input.baselinePageUrl && input.observedPageUrl && input.baselinePageUrl !== input.observedPageUrl) {
    observation.detail = 'Conversation/navigation identity changed between baseline and observation.';
    return observation;
  }

  if (input.observedUserTurnCount < input.baselineUserTurnCount) {
    observation.detail = 'Observed user-turn count regressed below the persisted baseline.';
    return observation;
  }

  if (input.matches > 1) {
    observation.detail = 'Multiple post-baseline user turns match the persisted prompt fingerprint.';
    return observation;
  }

  if (input.matches === 1 && input.observedUserTurnCount > input.baselineUserTurnCount) {
    observation.outcome = 'confirmed';
    observation.detail = 'Exactly one matching user turn exists after the persisted baseline.';
    return observation;
  }

  if (input.matches === 0 && input.observedUserTurnCount === input.baselineUserTurnCount) {
    observation.outcome = 'no_effect';
    observation.detail = 'No post-baseline user turn exists; replay is safe for this observation.';
    return observation;
  }

  observation.detail = 'Post-baseline transcript changed without a unique matching user turn.';
  return observation;
}
