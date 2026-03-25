import type { SignalFeatures } from '../feature-builder';

export interface AdverseSelectionRiskInput {
  flowToxicityScore: number;
  bookInstabilityScore: number;
  micropriceBias: number;
  lastReturnPct: number;
  rollingReturnPct: number;
  signalDecayPressure: number;
  marketStateTransition: SignalFeatures['marketStateTransition'];
  timeToExpirySeconds: number | null;
}

export interface AdverseSelectionRiskOutput {
  adverseSelectionRisk: number;
  reasons: string[];
  capturedAt: string;
}

export class AdverseSelectionRisk {
  evaluate(input: AdverseSelectionRiskInput): AdverseSelectionRiskOutput {
    const momentumDivergence =
      Math.sign(input.lastReturnPct || 0) !== Math.sign(input.rollingReturnPct || 0) &&
      Math.abs(input.lastReturnPct) >= 0.0015 &&
      Math.abs(input.rollingReturnPct) >= 0.0015;
    const transitionPressure =
      input.marketStateTransition === 'stress_transition'
        ? 0.18
        : input.marketStateTransition === 'mean_reversion'
          ? 0.12
          : input.marketStateTransition === 'trend_exhaustion'
            ? 0.08
            : 0.03;
    const expiryPressure =
      input.timeToExpirySeconds != null
        ? clamp01((75 - Math.max(0, input.timeToExpirySeconds)) / 75) * 0.08
        : 0;
    const adverseSelectionRisk = clamp01(
      input.flowToxicityScore * 0.36 +
        input.bookInstabilityScore * 0.34 +
        clamp01(Math.abs(input.micropriceBias) * 8) * 0.1 +
        clamp01(input.signalDecayPressure) * 0.1 +
        transitionPressure +
        expiryPressure +
        (momentumDivergence ? 0.07 : 0),
    );
    const reasons: string[] = [];

    if (input.flowToxicityScore >= 0.6) {
      reasons.push('toxic_flow_pressure');
    }
    if (input.bookInstabilityScore >= 0.65) {
      reasons.push('book_instability_pressure');
    }
    if (Math.abs(input.micropriceBias) >= 0.05) {
      reasons.push('microprice_bias_exposes_adverse_selection');
    }
    if (momentumDivergence) {
      reasons.push('momentum_divergence');
    }
    if (
      input.marketStateTransition === 'stress_transition' ||
      input.marketStateTransition === 'mean_reversion'
    ) {
      reasons.push('state_transition_fragile');
    }

    return {
      adverseSelectionRisk,
      reasons,
      capturedAt: new Date().toISOString(),
    };
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}
