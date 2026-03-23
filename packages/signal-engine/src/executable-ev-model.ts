import type { SignalFeatures } from './feature-builder';
import type { RegimeClassification } from './regime-classifier';

export interface ExecutableEvInput {
  directionalEdge: number;
  rawDirectionalEdge: number;
  marketImpliedProbability: number;
  features: SignalFeatures;
  regime: RegimeClassification;
  feeRate: number;
}

export interface ExecutableEvOutput {
  expectedEv: number;
  fillProbability: number;
  expectedFee: number;
  expectedSlippage: number;
  expectedPartialFillLoss: number;
  expectedMissedFillCost: number;
  expectedCancellationCost: number;
  expectedAdverseSelectionCost: number;
  confidence: number;
  decomposition: Record<string, number>;
  capturedAt: string;
}

export class ExecutableEvModel {
  calculate(input: ExecutableEvInput): ExecutableEvOutput {
    const signalStrength = Math.abs(input.directionalEdge);
    const baseFillProbability = clamp(
      0.38 +
        Math.min(0.25, input.features.topLevelDepth / 80) +
        Math.min(0.18, input.features.combinedDepth / 350) -
        input.features.spread * 3.2,
      0.05,
      0.98,
    );

    const fillProbability = clamp(
      baseFillProbability * input.regime.fillProbabilityMultiplier,
      0.03,
      0.98,
    );

    const expectedFee = Math.max(0, input.feeRate);
    const expectedSlippage =
      Math.max(0, input.features.spread) *
      (0.22 + input.regime.slippageMultiplier * 0.33);
    const expectedPartialFillLoss =
      signalStrength * (1 - fillProbability) * 0.15 * input.regime.partialFillPenaltyMultiplier;
    const expectedMissedFillCost =
      signalStrength * (1 - fillProbability) * 0.18 * input.regime.missedFillPenaltyMultiplier;
    const expectedCancellationCost =
      signalStrength *
      Math.max(0, input.features.orderbookNoiseScore) *
      0.08 *
      input.regime.cancellationPenaltyMultiplier;
    const expectedAdverseSelectionCost =
      Math.max(input.features.realizedVolatility, input.features.realizedRangePct) *
      0.22 *
      input.regime.adverseSelectionMultiplier;

    const expectedEv =
      input.directionalEdge * fillProbability -
      expectedFee -
      expectedSlippage -
      expectedPartialFillLoss -
      expectedMissedFillCost -
      expectedCancellationCost -
      expectedAdverseSelectionCost;

    const confidence = clamp01(
      input.regime.confidence *
        fillProbability *
        (1 - Math.min(0.8, input.features.orderbookNoiseScore)) *
        (0.7 + Math.min(0.3, signalStrength * 4)),
    );

    return {
      expectedEv,
      fillProbability,
      expectedFee,
      expectedSlippage,
      expectedPartialFillLoss,
      expectedMissedFillCost,
      expectedCancellationCost,
      expectedAdverseSelectionCost,
      confidence,
      decomposition: {
        directionalEdge: input.directionalEdge,
        rawDirectionalEdge: input.rawDirectionalEdge,
        marketImpliedProbability: input.marketImpliedProbability,
        fillProbability,
        expectedFee,
        expectedSlippage,
        expectedPartialFillLoss,
        expectedMissedFillCost,
        expectedCancellationCost,
        expectedAdverseSelectionCost,
      },
      capturedAt: new Date().toISOString(),
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
