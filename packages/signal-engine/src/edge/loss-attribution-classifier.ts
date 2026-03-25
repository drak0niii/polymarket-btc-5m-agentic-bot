import type { AlphaAttributionOutput } from './alpha-attribution';

export type LossAttributionCategory =
  | 'alpha_wrong'
  | 'slippage_excess'
  | 'fill_quality_failure'
  | 'latency_decay'
  | 'toxicity_damage'
  | 'over_sizing'
  | 'regime_drift'
  | 'mixed';

export type LossAssessment = 'healthy' | 'watch' | 'degraded' | 'failed';

export interface LossAttributionClassifierInput {
  alphaAttribution: Pick<
    AlphaAttributionOutput,
    | 'rawForecastEdge'
    | 'confidenceAdjustedEdge'
    | 'paperEdge'
    | 'expectedExecutionCost'
    | 'expectedNetEdge'
    | 'realizedExecutionCost'
    | 'realizedNetEdge'
    | 'retentionRatio'
  >;
  signalAgeMs?: number | null;
  fillRate?: number | null;
  expectedFillRate?: number | null;
  toxicityState?: string | null;
  regimeHealth?: string | null;
  sizeToDepthRatio?: number | null;
  liquidityReductionRatio?: number | null;
  entryTimingLabel?: string | null;
  retainedEdgeReasonCodes?: string[];
}

export interface LossAttributionOutput {
  lossCategory: LossAttributionCategory;
  lossReasonCodes: string[];
  forecastQualityAssessment: LossAssessment;
  executionQualityAssessment: LossAssessment;
  primaryLeakageDriver: LossAttributionCategory;
  secondaryLeakageDrivers: LossAttributionCategory[];
  retainedEdgeGap: number | null;
  evidence: {
    expectedNetEdge: number;
    realizedNetEdge: number | null;
    retentionRatio: number | null;
    fillRate: number | null;
    expectedFillRate: number | null;
    signalAgeMs: number | null;
    toxicityState: string | null;
    regimeHealth: string | null;
    sizeToDepthRatio: number | null;
    liquidityReductionRatio: number | null;
    entryTimingLabel: string | null;
    realizedSlippageCost: number | null;
    expectedSlippageCost: number;
    realizedAdverseSelectionCost: number | null;
    expectedAdverseSelectionCost: number;
  };
}

type CategoryScore = {
  category: Exclude<LossAttributionCategory, 'mixed'>;
  score: number;
};

const MAX_SIGNAL_AGE_MS = 30_000;

export class LossAttributionClassifier {
  classify(input: LossAttributionClassifierInput): LossAttributionOutput {
    const expectedNetEdge = input.alphaAttribution.expectedNetEdge;
    const realizedNetEdge = input.alphaAttribution.realizedNetEdge ?? null;
    const retentionRatio = input.alphaAttribution.retentionRatio ?? null;
    const retainedEdgeGap =
      realizedNetEdge != null ? expectedNetEdge - realizedNetEdge : Math.max(0, expectedNetEdge);
    const fillRate = normalizeNullable(input.fillRate);
    const expectedFillRate = normalizeNullable(input.expectedFillRate);
    const signalAgeMs = normalizeNullable(input.signalAgeMs);
    const sizeToDepthRatio = nonNegativeNullable(input.sizeToDepthRatio);
    const liquidityReductionRatio = boundedNullable(input.liquidityReductionRatio);
    const toxicityState = normalizeLabel(input.toxicityState);
    const regimeHealth = normalizeLabel(input.regimeHealth);
    const entryTimingLabel = normalizeLabel(input.entryTimingLabel);
    const realizedSlippageCost =
      input.alphaAttribution.realizedExecutionCost?.slippageCost ?? null;
    const expectedSlippageCost = input.alphaAttribution.expectedExecutionCost.slippageCost;
    const realizedAdverseSelectionCost =
      input.alphaAttribution.realizedExecutionCost?.adverseSelectionCost ?? null;
    const expectedAdverseSelectionCost =
      input.alphaAttribution.expectedExecutionCost.adverseSelectionCost;

    const reasonCodes = new Set<string>();
    const categoryScores: CategoryScore[] = [];

    const alphaWrongScore = (() => {
      let score = 0;
      if (expectedNetEdge <= 0 || input.alphaAttribution.confidenceAdjustedEdge <= 0) {
        score += 0.85;
        reasonCodes.add('forecast_edge_non_positive');
      }
      if (realizedNetEdge != null && realizedNetEdge < 0) {
        score += 0.45;
        reasonCodes.add('realized_edge_negative');
      }
      if ((retentionRatio ?? 1) < 0.4) {
        score += 0.25;
        reasonCodes.add('retention_ratio_collapsed');
      }
      return clamp01(score);
    })();
    categoryScores.push({ category: 'alpha_wrong', score: alphaWrongScore });

    const slippageExcessScore = (() => {
      let score = 0;
      if (
        realizedSlippageCost != null &&
        realizedSlippageCost > expectedSlippageCost + Math.max(0.0015, expectedSlippageCost * 0.5)
      ) {
        score += 0.85;
        reasonCodes.add('realized_slippage_exceeds_expectation');
      }
      if (
        retainedEdgeGap != null &&
        realizedSlippageCost != null &&
        retainedEdgeGap > 0 &&
        realizedSlippageCost >= retainedEdgeGap * 0.35
      ) {
        score += 0.25;
        reasonCodes.add('slippage_absorbs_retained_edge');
      }
      return clamp01(score);
    })();
    categoryScores.push({ category: 'slippage_excess', score: slippageExcessScore });

    const fillQualityFailureScore = (() => {
      let score = 0;
      if (fillRate != null && fillRate < 0.85) {
        score += 0.75;
        reasonCodes.add('fill_rate_below_threshold');
      }
      if (
        fillRate != null &&
        expectedFillRate != null &&
        fillRate + 0.15 < expectedFillRate
      ) {
        score += 0.25;
        reasonCodes.add('realized_fill_rate_below_expected');
      }
      if (realizedNetEdge == null && (fillRate ?? 0) < 1) {
        score += 0.2;
        reasonCodes.add('realized_net_edge_missing_due_to_fill_quality');
      }
      return clamp01(score);
    })();
    categoryScores.push({ category: 'fill_quality_failure', score: fillQualityFailureScore });

    const latencyDecayScore = (() => {
      let score = 0;
      if (signalAgeMs != null && signalAgeMs >= MAX_SIGNAL_AGE_MS * 0.6) {
        score += 0.7;
        reasonCodes.add('signal_age_high');
      }
      if (entryTimingLabel === 'late' || entryTimingLabel === 'stale') {
        score += 0.35;
        reasonCodes.add(`entry_timing_${entryTimingLabel}`);
      }
      if ((input.retainedEdgeReasonCodes ?? []).includes('retained_edge_materially_degraded')) {
        score += 0.2;
        reasonCodes.add('retained_edge_degraded_before_submit');
      }
      return clamp01(score);
    })();
    categoryScores.push({ category: 'latency_decay', score: latencyDecayScore });

    const toxicityDamageScore = (() => {
      let score = 0;
      if (toxicityState === 'high' || toxicityState === 'blocked') {
        score += 0.65;
        reasonCodes.add(`toxicity_state_${toxicityState}`);
      }
      if (
        realizedAdverseSelectionCost != null &&
        realizedAdverseSelectionCost >
          expectedAdverseSelectionCost + Math.max(0.001, expectedAdverseSelectionCost * 0.5)
      ) {
        score += 0.35;
        reasonCodes.add('realized_adverse_selection_exceeds_expectation');
      }
      return clamp01(score);
    })();
    categoryScores.push({ category: 'toxicity_damage', score: toxicityDamageScore });

    const overSizingScore = (() => {
      let score = 0;
      if (sizeToDepthRatio != null && sizeToDepthRatio > 0.75) {
        score += 0.6;
        reasonCodes.add('size_to_depth_ratio_elevated');
      }
      if (liquidityReductionRatio != null && liquidityReductionRatio >= 0.25) {
        score += 0.4;
        reasonCodes.add('liquidity_policy_cut_size');
      }
      return clamp01(score);
    })();
    categoryScores.push({ category: 'over_sizing', score: overSizingScore });

    const regimeDriftScore = (() => {
      let score = 0;
      if (regimeHealth === 'degraded' || regimeHealth === 'quarantine_candidate') {
        score += 0.75;
        reasonCodes.add(`regime_health_${regimeHealth}`);
      } else if (regimeHealth === 'watch') {
        score += 0.4;
        reasonCodes.add('regime_health_watch');
      }
      if ((retentionRatio ?? 1) < 0.65 && regimeHealth !== 'healthy') {
        score += 0.2;
        reasonCodes.add('retention_decay_in_regime_drift');
      }
      return clamp01(score);
    })();
    categoryScores.push({ category: 'regime_drift', score: regimeDriftScore });

    const ranked = [...categoryScores].sort((left, right) => right.score - left.score);
    const primary = ranked[0];
    const secondary = ranked
      .slice(1)
      .filter((candidate) => candidate.score >= 0.4)
      .map((candidate) => candidate.category);
    const activeStrongDrivers = ranked.filter((candidate) => candidate.score >= 0.55);

    const lossCategory: LossAttributionCategory =
      primary.score < 0.4 ||
      activeStrongDrivers.length >= 2 ||
      (ranked[1] != null && Math.abs(primary.score - ranked[1].score) <= 0.12)
        ? 'mixed'
        : primary.category;

    if (retainedEdgeGap != null && retainedEdgeGap <= 0) {
      reasonCodes.add('no_material_retained_edge_loss');
    }

    return {
      lossCategory,
      lossReasonCodes: Array.from(reasonCodes).sort(),
      forecastQualityAssessment: this.assessForecastQuality({
        alphaWrongScore,
        regimeDriftScore,
        expectedNetEdge,
        realizedNetEdge,
      }),
      executionQualityAssessment: this.assessExecutionQuality({
        slippageExcessScore,
        fillQualityFailureScore,
        latencyDecayScore,
        toxicityDamageScore,
        overSizingScore,
      }),
      primaryLeakageDriver: primary.score >= 0.4 ? primary.category : 'mixed',
      secondaryLeakageDrivers: lossCategory === 'mixed' ? secondary : secondary.slice(0, 2),
      retainedEdgeGap,
      evidence: {
        expectedNetEdge,
        realizedNetEdge,
        retentionRatio,
        fillRate,
        expectedFillRate,
        signalAgeMs,
        toxicityState,
        regimeHealth,
        sizeToDepthRatio,
        liquidityReductionRatio,
        entryTimingLabel,
        realizedSlippageCost,
        expectedSlippageCost,
        realizedAdverseSelectionCost,
        expectedAdverseSelectionCost,
      },
    };
  }

  private assessForecastQuality(input: {
    alphaWrongScore: number;
    regimeDriftScore: number;
    expectedNetEdge: number;
    realizedNetEdge: number | null;
  }): LossAssessment {
    if (
      input.alphaWrongScore >= 0.8 ||
      input.expectedNetEdge <= 0 ||
      (input.realizedNetEdge != null && input.realizedNetEdge < 0)
    ) {
      return 'failed';
    }
    if (input.alphaWrongScore >= 0.45 || input.regimeDriftScore >= 0.65) {
      return 'degraded';
    }
    if (input.alphaWrongScore >= 0.2 || input.regimeDriftScore >= 0.35) {
      return 'watch';
    }
    return 'healthy';
  }

  private assessExecutionQuality(input: {
    slippageExcessScore: number;
    fillQualityFailureScore: number;
    latencyDecayScore: number;
    toxicityDamageScore: number;
    overSizingScore: number;
  }): LossAssessment {
    const maxScore = Math.max(
      input.slippageExcessScore,
      input.fillQualityFailureScore,
      input.latencyDecayScore,
      input.toxicityDamageScore,
      input.overSizingScore,
    );
    if (maxScore >= 0.8) {
      return 'failed';
    }
    if (maxScore >= 0.5) {
      return 'degraded';
    }
    if (maxScore >= 0.25) {
      return 'watch';
    }
    return 'healthy';
  }
}

function normalizeNullable(value: number | null | undefined): number | null {
  return Number.isFinite(value ?? Number.NaN) ? (value ?? null) : null;
}

function nonNegativeNullable(value: number | null | undefined): number | null {
  const normalized = normalizeNullable(value);
  return normalized == null ? null : Math.max(0, normalized);
}

function boundedNullable(value: number | null | undefined): number | null {
  const normalized = normalizeNullable(value);
  return normalized == null ? null : clamp01(normalized);
}

function normalizeLabel(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}
