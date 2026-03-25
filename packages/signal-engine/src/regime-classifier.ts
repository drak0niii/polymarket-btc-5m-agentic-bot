import type { SignalFeatures } from './feature-builder';

export type RegimeLabel =
  | 'low_volatility_drift'
  | 'spike_and_revert'
  | 'momentum_continuation'
  | 'illiquid_noisy_book'
  | 'near_resolution_microstructure_chaos';

export interface RegimeClassification {
  label: RegimeLabel;
  confidence: number;
  reasonCodes: string[];
  toxicityBias: number;
  bookInstabilityBias: number;
  tradingAllowed: boolean;
  rejectionReasonCode: string;
  edgeMultiplier: number;
  executionConfidenceMultiplier: number;
  fillProbabilityMultiplier: number;
  slippageMultiplier: number;
  partialFillPenaltyMultiplier: number;
  missedFillPenaltyMultiplier: number;
  cancellationPenaltyMultiplier: number;
  adverseSelectionMultiplier: number;
  capturedAt: string;
}

export class RegimeClassifier {
  classify(features: SignalFeatures): RegimeClassification {
    const now = new Date().toISOString();
    const toxicityBias = clamp01(
      features.bookUpdateStress * 0.45 +
        features.signalDecayPressure * 0.3 +
        features.orderbookNoiseScore * 0.25,
    );
    const bookInstabilityBias = clamp01(
      features.bookUpdateStress * 0.55 +
        features.orderbookNoiseScore * 0.2 +
        clamp01(features.spread / 0.05) * 0.15 +
        clamp01((18 - Math.max(0, features.topLevelDepth)) / 18) * 0.1,
    );

    if (
      (features.timeToExpirySeconds !== null &&
        features.timeToExpirySeconds <= 45) ||
      (features.marketArchetype === 'expiry_pressure' &&
        features.signalDecayPressure >= 0.8)
    ) {
      return {
        label: 'near_resolution_microstructure_chaos',
        confidence: 0.95,
        reasonCodes: [
          'phase2_expiry_pressure',
          'phase2_signal_decay_pressure',
          'phase3_regime_toxicity_extreme',
        ],
        toxicityBias,
        bookInstabilityBias,
        tradingAllowed: false,
        rejectionReasonCode: 'near_resolution_microstructure_chaos',
        edgeMultiplier: 0.3,
        executionConfidenceMultiplier: 0.35,
        fillProbabilityMultiplier: 0.5,
        slippageMultiplier: 1.9,
        partialFillPenaltyMultiplier: 1.7,
        missedFillPenaltyMultiplier: 1.8,
        cancellationPenaltyMultiplier: 1.9,
        adverseSelectionMultiplier: 2.1,
        capturedAt: now,
      };
    }

    if (
      features.spread > 0.03 ||
      features.orderbookNoiseScore > 0.65 ||
      features.topLevelDepth < 16 ||
      features.bookUpdateStress > 0.72 ||
      features.marketArchetype === 'stressed_microstructure'
    ) {
      return {
        label: 'illiquid_noisy_book',
        confidence: 0.88,
        reasonCodes: [
          'phase2_book_update_stress',
          'phase2_stressed_microstructure',
          'phase3_book_instability_elevated',
        ],
        toxicityBias,
        bookInstabilityBias,
        tradingAllowed: false,
        rejectionReasonCode: 'illiquid_noisy_book',
        edgeMultiplier: 0.45,
        executionConfidenceMultiplier: 0.4,
        fillProbabilityMultiplier: 0.6,
        slippageMultiplier: 1.7,
        partialFillPenaltyMultiplier: 1.4,
        missedFillPenaltyMultiplier: 1.6,
        cancellationPenaltyMultiplier: 1.8,
        adverseSelectionMultiplier: 1.7,
        capturedAt: now,
      };
    }

    if (
      features.marketStateTransition === 'mean_reversion' ||
      features.marketArchetype === 'mean_reversion_trap' ||
      (Math.abs(features.lastReturnPct) > 0.003 &&
        Math.sign(features.lastReturnPct || 0) !==
          Math.sign(features.rollingReturnPct || 0))
    ) {
      return {
        label: 'spike_and_revert',
        confidence: clamp01(0.7 + features.marketArchetypeConfidence * 0.15),
        reasonCodes: [
          'phase2_mean_reversion_context',
          ...(toxicityBias >= 0.5 ? ['phase3_flow_toxicity_watch'] : []),
        ],
        toxicityBias,
        bookInstabilityBias,
        tradingAllowed: true,
        rejectionReasonCode: 'passed',
        edgeMultiplier: 0.88,
        executionConfidenceMultiplier: 0.74,
        fillProbabilityMultiplier: 0.82,
        slippageMultiplier: 1.15,
        partialFillPenaltyMultiplier: 1.15,
        missedFillPenaltyMultiplier: 1.1,
        cancellationPenaltyMultiplier: 1.15,
        adverseSelectionMultiplier: 1.3,
        capturedAt: now,
      };
    }

    if (
      (features.marketStateTransition === 'trend_acceleration' ||
        features.marketArchetype === 'trend_follow_through') &&
      Math.abs(features.rollingReturnPct) > 0.002 &&
      Math.sign(features.lastReturnPct || 0) ===
        Math.sign(features.rollingReturnPct || 0) &&
      features.realizedVolatility > 0.001 &&
      features.signalDecayPressure < 0.65 &&
      features.btcMoveTransmission > -0.15
    ) {
      return {
        label: 'momentum_continuation',
        confidence: clamp01(
          0.72 +
            features.marketStateTransitionStrength * 0.1 +
            features.marketArchetypeConfidence * 0.08,
        ),
        reasonCodes: [
          'phase2_trend_follow_through',
          'phase2_btc_linkage_supportive',
          ...(toxicityBias >= 0.45 ? ['phase3_toxicity_headwind_present'] : []),
        ],
        toxicityBias,
        bookInstabilityBias,
        tradingAllowed: true,
        rejectionReasonCode: 'passed',
        edgeMultiplier: 1.08,
        executionConfidenceMultiplier: 1,
        fillProbabilityMultiplier: 1,
        slippageMultiplier: 1,
        partialFillPenaltyMultiplier: 1,
        missedFillPenaltyMultiplier: 1,
        cancellationPenaltyMultiplier: 1,
        adverseSelectionMultiplier: 1,
        capturedAt: now,
      };
    }

    return {
      label: 'low_volatility_drift',
      confidence: clamp01(
        0.65 +
          (features.marketArchetype === 'balanced_rotation' ? 0.08 : 0) -
          features.signalDecayPressure * 0.12,
      ),
      reasonCodes: [
        'phase2_balanced_rotation_or_drift',
        ...(bookInstabilityBias >= 0.55 ? ['phase3_book_instability_watch'] : []),
      ],
      toxicityBias,
      bookInstabilityBias,
      tradingAllowed: true,
      rejectionReasonCode: 'passed',
      edgeMultiplier: 0.9,
      executionConfidenceMultiplier: 0.9,
      fillProbabilityMultiplier: 1.05,
      slippageMultiplier: 0.75,
      partialFillPenaltyMultiplier: 0.8,
      missedFillPenaltyMultiplier: 0.85,
      cancellationPenaltyMultiplier: 0.8,
      adverseSelectionMultiplier: 0.8,
      capturedAt: now,
    };
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}
