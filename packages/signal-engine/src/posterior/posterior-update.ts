import type { SignalFeatures } from '../feature-builder';
import type { RegimeClassification } from '../regime-classifier';

export interface PosteriorUpdateInput {
  priorProbability: number;
  features: SignalFeatures;
  regime?: RegimeClassification;
}

export interface PosteriorUpdateOutput {
  posteriorProbability: number;
  capturedAt: string;
}

export class PosteriorUpdate {
  apply(input: PosteriorUpdateInput): PosteriorUpdateOutput {
    const imbalanceAdjustment = input.features.topLevelImbalance * 0.08;
    const spreadPenalty = input.features.spread * 0.35;
    const regimeAdjustment =
      input.regime?.label === 'momentum_continuation'
        ? input.features.micropriceBias * 0.06
        : input.regime?.label === 'spike_and_revert'
          ? -input.features.lastReturnPct * 0.08
          : input.regime?.label === 'low_volatility_drift'
            ? input.features.midpointDriftPct * 0.05
            : -0.02;
    const expiryPenalty =
      input.features.timeToExpirySeconds !== null &&
      input.features.timeToExpirySeconds < 30
        ? 0.03
        : 0;

    const posteriorProbability = Math.max(
      0.01,
      Math.min(
        0.99,
        input.priorProbability +
          imbalanceAdjustment +
          regimeAdjustment -
          spreadPenalty -
          expiryPenalty,
      ),
    );

    return {
      posteriorProbability,
      capturedAt: new Date().toISOString(),
    };
  }
}
