export type MarketStateTransitionLabel =
  | 'trend_acceleration'
  | 'trend_exhaustion'
  | 'mean_reversion'
  | 'range_balance'
  | 'stress_transition';

export interface MarketStateTransitionInput {
  lastReturnPct: number;
  rollingReturnPct: number;
  realizedVolatility: number;
  flowImbalanceProxy: number;
  bookUpdateStress: number;
  btcMoveTransmission: number;
}

export interface MarketStateTransitionOutput {
  marketStateTransition: MarketStateTransitionLabel;
  marketStateTransitionStrength: number;
}

export class MarketStateTransitionModel {
  classify(input: MarketStateTransitionInput): MarketStateTransitionOutput {
    const sameDirection =
      direction(input.lastReturnPct) !== 0 &&
      direction(input.lastReturnPct) === direction(input.rollingReturnPct);
    const transitionStrength = clamp01(
      Math.abs(input.lastReturnPct) * 48 +
        Math.abs(input.rollingReturnPct) * 22 +
        Math.abs(input.flowImbalanceProxy) * 0.25 +
        input.bookUpdateStress * 0.2,
    );

    if (input.bookUpdateStress >= 0.72 && input.realizedVolatility >= 0.0012) {
      return {
        marketStateTransition: 'stress_transition',
        marketStateTransitionStrength: transitionStrength,
      };
    }

    if (
      sameDirection &&
      Math.abs(input.lastReturnPct) >= Math.abs(input.rollingReturnPct) * 0.45 &&
      Math.abs(input.flowImbalanceProxy) >= 0.15 &&
      input.btcMoveTransmission > 0
    ) {
      return {
        marketStateTransition: 'trend_acceleration',
        marketStateTransitionStrength: transitionStrength,
      };
    }

    if (
      direction(input.lastReturnPct) !== 0 &&
      direction(input.rollingReturnPct) !== 0 &&
      direction(input.lastReturnPct) !== direction(input.rollingReturnPct)
    ) {
      return {
        marketStateTransition: 'mean_reversion',
        marketStateTransitionStrength: transitionStrength,
      };
    }

    if (
      sameDirection &&
      Math.abs(input.lastReturnPct) <= Math.abs(input.rollingReturnPct) * 0.2 &&
      Math.abs(input.flowImbalanceProxy) < 0.18
    ) {
      return {
        marketStateTransition: 'trend_exhaustion',
        marketStateTransitionStrength: transitionStrength,
      };
    }

    return {
      marketStateTransition: 'range_balance',
      marketStateTransitionStrength: transitionStrength,
    };
  }
}

function direction(value: number): number {
  if (!Number.isFinite(value) || value === 0) {
    return 0;
  }

  return value > 0 ? 1 : -1;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}
