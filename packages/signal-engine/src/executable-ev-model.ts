import type { SignalFeatures } from './feature-builder';
import type { RegimeClassification } from './regime-classifier';

export interface ExecutableEvInput {
  directionalEdge: number;
  rawDirectionalEdge: number;
  marketImpliedProbability: number;
  features: SignalFeatures;
  regime: RegimeClassification;
  feeRate: number;
  executionAssumptions?: {
    fillProbability?: number | null;
    expectedSlippage?: number | null;
    expectedFillDelayMs?: number | null;
    partialFillRate?: number | null;
    cancelSuccessRate?: number | null;
    adverseSelectionCost?: number | null;
    confidenceMultiplier?: number | null;
  } | null;
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
    const executionAssumptions = input.executionAssumptions ?? null;
    const baseFillProbability = clamp(
      0.38 +
        Math.min(0.25, input.features.topLevelDepth / 80) +
        Math.min(0.18, input.features.combinedDepth / 350) -
        input.features.spread * 3.2,
      0.05,
      0.98,
    );

    const fillProbability = clamp(
      Math.max(
        baseFillProbability * input.regime.fillProbabilityMultiplier,
        executionAssumptions?.fillProbability ?? 0,
      ),
      0.03,
      0.98,
    );

    const expectedFee = Math.max(0, input.feeRate);
    const expectedSlippage = Math.max(
      Math.max(0, input.features.spread) *
        (0.22 + input.regime.slippageMultiplier * 0.33),
      executionAssumptions?.expectedSlippage ?? 0,
    );
    const expectedPartialFillLoss =
      signalStrength *
      Math.max(
        (1 - fillProbability) * 0.15 * input.regime.partialFillPenaltyMultiplier,
        (executionAssumptions?.partialFillRate ?? 0) * 0.18,
      );
    const expectedMissedFillCost =
      signalStrength * (1 - fillProbability) * 0.18 * input.regime.missedFillPenaltyMultiplier;
    const expectedCancellationCost =
      Math.max(
        signalStrength *
          Math.max(0, input.features.orderbookNoiseScore) *
          0.08 *
          input.regime.cancellationPenaltyMultiplier,
        Math.max(0, 1 - (executionAssumptions?.cancelSuccessRate ?? 1)) * 0.0025,
      );
    const expectedAdverseSelectionCost = Math.max(
      Math.max(input.features.realizedVolatility, input.features.realizedRangePct) *
        0.22 *
        input.regime.adverseSelectionMultiplier,
      executionAssumptions?.adverseSelectionCost ?? 0,
    );
    const fillDelayPenalty =
      (executionAssumptions?.expectedFillDelayMs ?? 0) > 0
        ? clamp(
            ((executionAssumptions?.expectedFillDelayMs ?? 0) - 10_000) / 100_000,
            0,
            0.12,
          )
        : 0;

    const expectedEv =
      input.directionalEdge * fillProbability -
      expectedFee -
      expectedSlippage -
      expectedPartialFillLoss -
      expectedMissedFillCost -
      expectedCancellationCost -
      expectedAdverseSelectionCost -
      fillDelayPenalty;

    const confidence = clamp01(
      input.regime.confidence *
        fillProbability *
        (1 - Math.min(0.8, input.features.orderbookNoiseScore)) *
        (0.7 + Math.min(0.3, signalStrength * 4)) *
        (executionAssumptions?.confidenceMultiplier ?? 1) *
        (1 - fillDelayPenalty),
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
        fillDelayPenalty,
        executionAssumptionsFillProbability:
          executionAssumptions?.fillProbability ?? 0,
        executionAssumptionsExpectedSlippage:
          executionAssumptions?.expectedSlippage ?? 0,
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
