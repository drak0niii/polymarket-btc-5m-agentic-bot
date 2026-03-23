import type { SignalFeatures } from './feature-builder';
import type { RegimeClassification } from './regime-classifier';

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

    const confidence = clamp01(
      posteriorConfidence *
        input.regime.confidence *
        input.regime.executionConfidenceMultiplier *
        directionalAgreement,
    );

    const calibratedEdge =
      rawEdge *
      input.regime.edgeMultiplier *
      (0.55 + confidence * 0.45) *
      this.sampleSufficiencyMultiplier(input.features.sampleCount);

    return {
      edge: calibratedEdge,
      rawEdge,
      confidence,
      allowed: input.regime.tradingAllowed,
      reasonCode: input.regime.tradingAllowed ? 'passed' : input.regime.rejectionReasonCode,
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
