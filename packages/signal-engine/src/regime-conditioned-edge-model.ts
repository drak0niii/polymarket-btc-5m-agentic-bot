import type { SignalFeatures } from './feature-builder';
import type { RegimeClassification } from './regime-classifier';

export type RegimeFamily = 'stable' | 'transitional' | 'hostile';

export interface RegimeConditionedEdgeInput {
  priorProbability: number;
  posteriorProbability: number;
  marketImpliedProbability: number;
  features: SignalFeatures;
  regime: RegimeClassification;
}

export interface RegimeConditionedEdgeOutput {
  edge: number;
  rawEdge: number;
  confidence: number;
  allowed: boolean;
  reasonCode: string;
  regimeFamily: RegimeFamily;
  regimeRequiredConfidence: number;
  regimeEdgeMultiplier: number;
  regimeTransitionPenalty: number;
  capturedAt: string;
}

export class RegimeConditionedEdgeModel {
  evaluate(input: RegimeConditionedEdgeInput): RegimeConditionedEdgeOutput {
    const rawEdge = input.posteriorProbability - input.marketImpliedProbability;
    const posteriorConfidence = Math.abs(input.posteriorProbability - 0.5) * 2;
    const directionalAgreement =
      Math.sign(input.posteriorProbability - 0.5) ===
      Math.sign(input.features.rollingReturnPct || 0)
        ? 1
        : 0.7;
    const regimeFamily = classifyRegimeFamily(input.regime);
    const regimeTransitionPenalty = clamp(
      1 - input.regime.regimeTransitionRisk * 0.35,
      0.45,
      1,
    );
    const regimeRequiredConfidence =
      regimeFamily === 'hostile' ? 0.82 : regimeFamily === 'transitional' ? 0.68 : 0.58;

    const confidence = clamp01(
      posteriorConfidence *
        input.regime.regimeConfidence *
        input.regime.executionConfidenceMultiplier *
        directionalAgreement *
        regimeTransitionPenalty,
    );

    const calibratedEdge =
      rawEdge *
      input.regime.edgeMultiplier *
      regimeTransitionPenalty *
      (0.55 + confidence * 0.45) *
      this.sampleSufficiencyMultiplier(input.features.sampleCount);

    return {
      edge: calibratedEdge,
      rawEdge,
      confidence,
      allowed: input.regime.tradingAllowed,
      reasonCode: input.regime.tradingAllowed ? 'passed' : input.regime.rejectionReasonCode,
      regimeFamily,
      regimeRequiredConfidence,
      regimeEdgeMultiplier: input.regime.edgeMultiplier,
      regimeTransitionPenalty,
      capturedAt: new Date().toISOString(),
    };
  }

  private sampleSufficiencyMultiplier(sampleCount: number): number {
    if (!Number.isFinite(sampleCount) || sampleCount <= 0) {
      return 0.5;
    }

    return Math.max(0.55, Math.min(1, sampleCount / 24));
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function classifyRegimeFamily(regime: RegimeClassification): RegimeFamily {
  if (
    regime.regimeLabel === 'illiquid_noisy_book' ||
    regime.regimeLabel === 'near_resolution_microstructure_chaos'
  ) {
    return 'hostile';
  }
  if (
    regime.regimeLabel === 'spike_and_revert' ||
    regime.regimeTransitionRisk >= 0.55
  ) {
    return 'transitional';
  }
  return 'stable';
}
