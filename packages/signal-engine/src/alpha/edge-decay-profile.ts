import type { MarketStateTransitionLabel } from './market-state-transition';

export interface EdgeDecayProfileInput {
  timeToExpirySeconds: number | null;
  realizedVolatility: number;
  realizedRangePct: number;
  orderbookNoiseScore: number;
  bookUpdateStress: number;
  marketStateTransition: MarketStateTransitionLabel;
  flowIntensity: number;
  sampleCount: number;
}

export interface EdgeDecayProfileOutput {
  signalDecayPressure: number;
}

export class EdgeDecayProfile {
  evaluate(input: EdgeDecayProfileInput): EdgeDecayProfileOutput {
    const expiryPressure =
      input.timeToExpirySeconds == null
        ? 0.15
        : clamp01((180 - input.timeToExpirySeconds) / 180);
    const volatilityPressure = clamp01(
      input.realizedVolatility * 120 + input.realizedRangePct * 24,
    );
    const statePenalty = transitionPenalty(input.marketStateTransition);
    const samplePenalty =
      input.sampleCount >= 16
        ? 0
        : clamp01((16 - input.sampleCount) / 16) * 0.22;
    const signalDecayPressure = clamp01(
      expiryPressure * 0.34 +
        volatilityPressure * 0.22 +
        input.orderbookNoiseScore * 0.14 +
        input.bookUpdateStress * 0.18 +
        input.flowIntensity * 0.08 +
        statePenalty +
        samplePenalty,
    );

    return {
      signalDecayPressure,
    };
  }
}

function transitionPenalty(value: MarketStateTransitionLabel): number {
  switch (value) {
    case 'stress_transition':
      return 0.2;
    case 'trend_exhaustion':
      return 0.14;
    case 'mean_reversion':
      return 0.1;
    case 'trend_acceleration':
      return 0.04;
    case 'range_balance':
    default:
      return 0.02;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}
