import type { MarketStateTransitionLabel } from './market-state-transition';

export type MarketArchetypeLabel =
  | 'trend_follow_through'
  | 'mean_reversion_trap'
  | 'stressed_microstructure'
  | 'expiry_pressure'
  | 'balanced_rotation';

export interface MarketArchetypeInput {
  flowImbalanceProxy: number;
  flowIntensity: number;
  bookUpdateStress: number;
  btcMoveTransmission: number;
  signalDecayPressure: number;
  marketStateTransition: MarketStateTransitionLabel;
  realizedVolatility: number;
  timeToExpirySeconds: number | null;
}

export interface MarketArchetypeOutput {
  marketArchetype: MarketArchetypeLabel;
  marketArchetypeConfidence: number;
}

export class MarketArchetypeClassifier {
  classify(input: MarketArchetypeInput): MarketArchetypeOutput {
    const baseConfidence = clamp01(
      0.35 +
        Math.abs(input.flowImbalanceProxy) * 0.2 +
        input.flowIntensity * 0.15 +
        input.bookUpdateStress * 0.15 +
        input.signalDecayPressure * 0.15,
    );

    if (
      (input.timeToExpirySeconds != null && input.timeToExpirySeconds <= 50) ||
      input.signalDecayPressure >= 0.78
    ) {
      return {
        marketArchetype: 'expiry_pressure',
        marketArchetypeConfidence: baseConfidence,
      };
    }

    if (input.bookUpdateStress >= 0.72 || input.realizedVolatility >= 0.0024) {
      return {
        marketArchetype: 'stressed_microstructure',
        marketArchetypeConfidence: baseConfidence,
      };
    }

    if (
      input.marketStateTransition === 'trend_acceleration' &&
      direction(input.flowImbalanceProxy) === direction(input.btcMoveTransmission) &&
      input.flowIntensity >= 0.3
    ) {
      return {
        marketArchetype: 'trend_follow_through',
        marketArchetypeConfidence: baseConfidence,
      };
    }

    if (
      input.marketStateTransition === 'mean_reversion' ||
      input.marketStateTransition === 'trend_exhaustion'
    ) {
      return {
        marketArchetype: 'mean_reversion_trap',
        marketArchetypeConfidence: baseConfidence,
      };
    }

    return {
      marketArchetype: 'balanced_rotation',
      marketArchetypeConfidence: baseConfidence,
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
