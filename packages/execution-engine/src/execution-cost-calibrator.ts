import type {
  ExecutionLearningContext,
  ExecutionPolicyVersion,
  NetEdgeVenueUncertaintyLabel,
} from '@polymarket-btc-5m-agentic-bot/domain';

export interface ExecutionCostObservation {
  expectedFee: number | null;
  realizedFee: number | null;
  expectedSlippage: number | null;
  realizedSlippage: number | null;
  edgeAtSignal: number | null;
  edgeAtFill: number | null;
  fillRate: number | null;
  staleOrder: boolean;
  capturedAt: string;
}

export interface ExecutionCostCalibrationInput {
  activePolicyVersion: ExecutionPolicyVersion | null;
  executionContext: ExecutionLearningContext | null;
  recentObservations: ExecutionCostObservation[];
  cancelFailureRate?: number | null;
  venueUncertaintyLabel?: NetEdgeVenueUncertaintyLabel | null;
}

export interface ExecutionCostCalibration {
  feeCost: number;
  slippageCost: number;
  adverseSelectionCost: number;
  expectedFillDelayMs: number | null;
  cancelReplaceOverheadCost: number;
  missedOpportunityCost: number;
  expectedFillProbability: number;
  confidence: number;
  reasons: string[];
  evidence: Record<string, unknown>;
}

export class ExecutionCostCalibrator {
  calibrate(input: ExecutionCostCalibrationInput): ExecutionCostCalibration {
    const recentFeeCost = average(
      input.recentObservations.map(
        (observation) => observation.realizedFee ?? observation.expectedFee,
      ),
    );
    const recentSlippage = average(
      input.recentObservations.map(
        (observation) => observation.realizedSlippage ?? observation.expectedSlippage,
      ),
    );
    const recentAdverseSelection = average(
      input.recentObservations.map((observation) =>
        observation.edgeAtSignal != null && observation.edgeAtFill != null
          ? Math.max(0, observation.edgeAtSignal - observation.edgeAtFill)
          : null,
      ),
    );
    const observedFillProbability = average(
      input.recentObservations.map((observation) => observation.fillRate),
    );
    const policyFillDelayMs = input.activePolicyVersion?.expectedFillDelayMs ?? null;
    const contextFillDelayMs = input.executionContext?.averageFillDelayMs ?? null;
    const cancelFailureRate = clamp(input.cancelFailureRate ?? 0, 0, 1);
    const fillProbability = clamp(
      Math.max(
        observedFillProbability ?? 0,
        maxNullable(
          input.executionContext?.makerFillRate ?? null,
          input.executionContext?.takerFillRate ?? null,
        ) ?? 0,
        0.1,
      ),
      0.1,
      1,
    );
    const feeCost = maxNullable(
      recentFeeCost,
      input.activePolicyVersion != null ? input.activePolicyVersion.expectedSlippage * 0.2 : null,
      input.executionContext != null ? input.executionContext.averageSlippage * 0.2 : null,
      0.0005,
    ) ?? 0.0005;
    const slippageCost = maxNullable(
      recentSlippage,
      input.activePolicyVersion?.expectedSlippage ?? null,
      input.executionContext?.averageSlippage ?? null,
      0.001,
    ) ?? 0.001;
    const adverseSelectionCost = maxNullable(
      recentAdverseSelection,
      adverseSelectionCostFromScore(input.activePolicyVersion?.adverseSelectionScore ?? null),
      adverseSelectionCostFromScore(input.executionContext?.adverseSelectionScore ?? null),
      0.0008,
    ) ?? 0.0008;
    const expectedFillDelayMs = maxNullable(policyFillDelayMs, contextFillDelayMs);
    const cancelReplaceOverheadCost = Math.max(
      0,
      cancelFailureRate * 0.0015 +
        ((input.executionContext?.cancelSuccessRate ?? 1) < 0.7 ? 0.0008 : 0) +
        (input.venueUncertaintyLabel === 'degraded'
          ? 0.0005
          : input.venueUncertaintyLabel === 'unsafe'
            ? 0.0015
            : 0),
    );
    const missedOpportunityCost = Math.max(
      0,
      (1 - fillProbability) * 0.003 +
        ((expectedFillDelayMs ?? 0) > 30_000 ? 0.001 : 0),
    );
    const confidence = clamp(
      (input.recentObservations.length + (input.executionContext?.sampleCount ?? 0)) / 20,
      0.2,
      0.95,
    );

    const reasons: string[] = [];
    if ((recentSlippage ?? 0) > ((input.activePolicyVersion?.expectedSlippage ?? 0) * 1.25)) {
      reasons.push('realized_slippage_above_policy');
    }
    if ((recentAdverseSelection ?? 0) > 0.0025) {
      reasons.push('realized_adverse_selection_elevated');
    }
    if (fillProbability < 0.75) {
      reasons.push('fill_probability_below_target');
    }
    if (cancelFailureRate > 0.2) {
      reasons.push('cancel_failures_raise_cost_assumptions');
    }
    if (input.venueUncertaintyLabel === 'degraded' || input.venueUncertaintyLabel === 'unsafe') {
      reasons.push(`venue_${input.venueUncertaintyLabel}_raises_cost_assumptions`);
    }

    return {
      feeCost,
      slippageCost,
      adverseSelectionCost,
      expectedFillDelayMs,
      cancelReplaceOverheadCost,
      missedOpportunityCost,
      expectedFillProbability: fillProbability,
      confidence,
      reasons,
      evidence: {
        recentObservationCount: input.recentObservations.length,
        executionContext: input.executionContext,
        activePolicyVersion: input.activePolicyVersion,
        cancelFailureRate,
        venueUncertaintyLabel: input.venueUncertaintyLabel ?? null,
      },
    };
  }
}

function average(values: Array<number | null | undefined>): number | null {
  const filtered = values.filter((value): value is number => Number.isFinite(value ?? Number.NaN));
  if (filtered.length === 0) {
    return null;
  }
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function maxNullable(...values: Array<number | null | undefined>): number | null {
  const filtered = values.filter((value): value is number => Number.isFinite(value ?? Number.NaN));
  if (filtered.length === 0) {
    return null;
  }
  return Math.max(...filtered);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function adverseSelectionCostFromScore(score: number | null): number | null {
  if (score == null || !Number.isFinite(score)) {
    return null;
  }

  return 0.0008 + clamp(score, 0, 1) * 0.008;
}
