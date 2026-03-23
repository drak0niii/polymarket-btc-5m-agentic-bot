import type { SignalFeatures } from '../feature-builder';
import type { RegimeClassification } from '../regime-classifier';

export interface PriorModelOutput {
  probabilityUp: number;
  capturedAt: string;
}

export class PriorModel {
  evaluate(
    features: SignalFeatures,
    regime?: RegimeClassification,
  ): PriorModelOutput {
    const momentumComponent = features.rollingReturnPct * 18;
    const imbalanceComponent = features.topLevelImbalance * 0.12;
    const volatilityPenalty = features.realizedVolatility * 6;
    const regimeAdjustment =
      regime?.label === 'momentum_continuation'
        ? 0.02
        : regime?.label === 'spike_and_revert'
          ? -0.01
          : regime?.label === 'low_volatility_drift'
            ? 0.005
            : -0.03;
    const bias = 0.5;

    const score =
      bias + momentumComponent + imbalanceComponent - volatilityPenalty + regimeAdjustment;

    const probabilityUp = Math.max(0.01, Math.min(0.99, score));

    return {
      probabilityUp,
      capturedAt: new Date().toISOString(),
    };
  }
}
