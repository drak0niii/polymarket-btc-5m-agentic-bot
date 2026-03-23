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

    if (
      features.timeToExpirySeconds !== null &&
      features.timeToExpirySeconds <= 45
    ) {
      return {
        label: 'near_resolution_microstructure_chaos',
        confidence: 0.95,
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
      features.topLevelDepth < 16
    ) {
      return {
        label: 'illiquid_noisy_book',
        confidence: 0.88,
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
      Math.abs(features.lastReturnPct) > 0.003 &&
      Math.sign(features.lastReturnPct || 0) !==
        Math.sign(features.rollingReturnPct || 0)
    ) {
      return {
        label: 'spike_and_revert',
        confidence: 0.76,
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
      Math.abs(features.rollingReturnPct) > 0.002 &&
      Math.sign(features.lastReturnPct || 0) ===
        Math.sign(features.rollingReturnPct || 0) &&
      features.realizedVolatility > 0.001
    ) {
      return {
        label: 'momentum_continuation',
        confidence: 0.81,
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
      confidence: 0.72,
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
