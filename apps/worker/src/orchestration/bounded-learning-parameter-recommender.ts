import type {
  LearningCycleSummary,
  LearningEvidenceReference,
  LearningEvent,
  LearningMetricSnapshot,
  LearningParameterChange,
  LearningReviewOutputs,
} from '@polymarket-btc-5m-agentic-bot/domain';
import type { LearningCycleSample } from './learning-cycle-runner';

const DEFAULT_ENTRY_THRESHOLD_BPS = 12;
const DEFAULT_REGIME_CONFIDENCE_THRESHOLD = 0.58;
const DEFAULT_SIZE_MULTIPLIER_BAND_MAX = 1;

const ENTRY_THRESHOLD_PARAMETER = 'entry_threshold_bps';
const REGIME_CONFIDENCE_PARAMETER = 'regime_confidence_threshold';
const SIZE_MULTIPLIER_PARAMETER = 'size_multiplier_band_max';

const ALLOWED_SURFACES = [
  ENTRY_THRESHOLD_PARAMETER,
  REGIME_CONFIDENCE_PARAMETER,
  SIZE_MULTIPLIER_PARAMETER,
] as const;

type AllowedSurface = (typeof ALLOWED_SURFACES)[number];

export interface BoundedLearningParameterRecommenderInput {
  cycleId: string;
  completedAt: Date;
  analyzedWindow: {
    from: Date;
    to: Date;
  };
  priorReviewOutputs: LearningCycleSummary['reviewOutputs'] | null | undefined;
  samples: LearningCycleSample[];
  sampleSourceSummary: {
    sourceOfTruth: 'resolved_trade_ledger' | 'execution_diagnostic_fallback';
    resolvedTradeCount: number;
    executionDiagnosticCount: number;
  };
  resolvedTradeLedgerPath: string;
}

export interface BoundedLearningParameterRecommenderOutput {
  reviewOutput: Record<string, unknown>;
  warnings: string[];
  event: LearningEvent;
}

export class BoundedLearningParameterRecommender {
  recommend(
    input: BoundedLearningParameterRecommenderInput,
  ): BoundedLearningParameterRecommenderOutput {
    const samples = normalizeSamples(input.samples);
    const metrics = summarizeSamples(samples);
    const evidenceRefs = this.buildEvidenceRefs(input, metrics);
    const warnings: string[] = [];

    if (input.sampleSourceSummary.sourceOfTruth !== 'resolved_trade_ledger') {
      warnings.push('bounded_parameter_recommendations_require_resolved_trade_ledger');
    }

    if (metrics.sampleCount < 3) {
      warnings.push('bounded_parameter_recommendations_insufficient_sample');
    }

    const recommendationsAllowed =
      warnings.length === 0 && input.sampleSourceSummary.resolvedTradeCount >= 3;
    const previousRecommendations = readPriorRecommendations(input.priorReviewOutputs);
    const changeSet = recommendationsAllowed
      ? this.buildChangeSet({
          completedAt: input.completedAt,
          evidenceRefs,
          metrics,
          previousRecommendations,
        })
      : [];

    const reviewOutput = buildReviewOutput({
      cycleId: input.cycleId,
      metrics,
      warnings,
      evidenceRefs,
      changeSet,
      sampleSourceSummary: input.sampleSourceSummary,
    });

    return {
      reviewOutput,
      warnings,
      event: {
        id: `${input.cycleId}:bounded-parameter-recommendations`,
        type: 'learning_parameter_recommendations_generated',
        severity:
          changeSet.length > 0
            ? 'warning'
            : warnings.length > 0
              ? 'warning'
              : 'info',
        createdAt: input.completedAt.toISOString(),
        cycleId: input.cycleId,
        strategyVariantId: null,
        contextKey: null,
        summary:
          changeSet.length > 0
            ? `Generated ${changeSet.length} bounded parameter recommendations.`
            : 'No bounded parameter recommendations generated.',
        details: reviewOutput,
      },
    };
  }

  private buildEvidenceRefs(
    input: BoundedLearningParameterRecommenderInput,
    metrics: LearningMetricSnapshot,
  ): LearningEvidenceReference[] {
    return [
      {
        source:
          input.sampleSourceSummary.sourceOfTruth === 'resolved_trade_ledger'
            ? 'resolved_trade_ledger'
            : 'unknown',
        sourceId: input.cycleId,
        artifactPath: input.resolvedTradeLedgerPath,
        window: {
          from: input.analyzedWindow.from.toISOString(),
          to: input.analyzedWindow.to.toISOString(),
          sampleCount: input.sampleSourceSummary.resolvedTradeCount,
        },
        metricSnapshot: metrics,
        notes: [
          'draft_only',
          'bounded_adaptation_only',
          'no_automatic_live_parameter_mutation',
        ],
      },
    ];
  }

  private buildChangeSet(input: {
    completedAt: Date;
    evidenceRefs: LearningEvidenceReference[];
    metrics: ReturnType<typeof summarizeSamples>;
    previousRecommendations: Partial<Record<AllowedSurface, number>>;
  }): LearningParameterChange[] {
    const changes: LearningParameterChange[] = [];

    const entryTrigger =
      input.metrics.realizedVsExpectedRatio != null &&
      input.metrics.realizedVsExpectedRatio < 0.85;
    const severeEntryTrigger =
      input.metrics.realizedVsExpectedRatio != null &&
      input.metrics.realizedVsExpectedRatio < 0.65;
    const negativeOutcomeTrigger = (input.metrics.averageRealizedNetEdgeBps ?? 0) < 0;
    const lossRateTrigger = (input.metrics.lossRate ?? 0) >= 0.55;
    if (entryTrigger || negativeOutcomeTrigger || lossRateTrigger) {
      const previousValue =
        input.previousRecommendations[ENTRY_THRESHOLD_PARAMETER] ??
        DEFAULT_ENTRY_THRESHOLD_BPS;
      const delta = severeEntryTrigger || negativeOutcomeTrigger ? 4 : 2;
      changes.push({
        parameter: ENTRY_THRESHOLD_PARAMETER,
        previousValue,
        nextValue: clampNumber(previousValue + delta, previousValue, 30),
        rationale: [
          'realized_edge_underperformed_cycle_expectation',
          ...(negativeOutcomeTrigger ? ['average_realized_net_edge_negative'] : []),
          ...(lossRateTrigger ? ['loss_rate_elevated'] : []),
        ],
        boundedBy: [
          'allowed_surface:entry_threshold',
          'cycle_step_limit:4_bps',
          'draft_only',
        ],
        evidenceRefs: input.evidenceRefs,
        rollbackCriteria: [
          {
            trigger: 'realized_vs_expected_ratio_recovered',
            comparator: 'gte',
            threshold: 1,
            rationale: 'Only relax after realized edge recovers to expectation.',
          },
        ],
        changedAt: input.completedAt.toISOString(),
      });
    }

    const regimeTrigger =
      (input.metrics.lossRate ?? 0) >= 0.6 ||
      (input.metrics.realizedVsExpectedRatio != null &&
        input.metrics.realizedVsExpectedRatio < 0.8);
    if (regimeTrigger) {
      const previousValue =
        input.previousRecommendations[REGIME_CONFIDENCE_PARAMETER] ??
        DEFAULT_REGIME_CONFIDENCE_THRESHOLD;
      const delta = (input.metrics.lossRate ?? 0) >= 0.7 ? 0.04 : 0.02;
      changes.push({
        parameter: REGIME_CONFIDENCE_PARAMETER,
        previousValue,
        nextValue: clampNumber(roundTo(previousValue + delta, 2), previousValue, 0.72),
        rationale: [
          'regime_selectivity_should_increase_under_underperformance',
          ...(input.metrics.lossRate != null && input.metrics.lossRate >= 0.6
            ? ['loss_rate_elevated']
            : []),
        ],
        boundedBy: [
          'allowed_surface:regime_confidence_threshold',
          'cycle_step_limit:0.04',
          'draft_only',
        ],
        evidenceRefs: input.evidenceRefs,
        rollbackCriteria: [
          {
            trigger: 'loss_rate_normalized',
            comparator: 'lte',
            threshold: 0.45,
            rationale: 'Only relax after the cycle loss rate normalizes.',
          },
        ],
        changedAt: input.completedAt.toISOString(),
      });
    }

    const executionStressTrigger =
      (input.metrics.lowFillRateRatio ?? 0) >= 0.35 ||
      (input.metrics.averageRealizedSlippageBps ?? 0) >= 8 ||
      negativeOutcomeTrigger;
    if (executionStressTrigger) {
      const previousValue =
        input.previousRecommendations[SIZE_MULTIPLIER_PARAMETER] ??
        DEFAULT_SIZE_MULTIPLIER_BAND_MAX;
      const delta =
        (input.metrics.lowFillRateRatio ?? 0) >= 0.5 ||
        (input.metrics.averageRealizedSlippageBps ?? 0) >= 12 ||
        negativeOutcomeTrigger
          ? 0.2
          : 0.1;
      changes.push({
        parameter: SIZE_MULTIPLIER_PARAMETER,
        previousValue,
        nextValue: clampNumber(roundTo(previousValue - delta, 2), 0.4, previousValue),
        rationale: [
          'execution_quality_requires_more_conservative_sizing',
          ...(negativeOutcomeTrigger ? ['average_realized_net_edge_negative'] : []),
          ...((input.metrics.lowFillRateRatio ?? 0) >= 0.35
            ? ['fill_rate_degraded']
            : []),
          ...((input.metrics.averageRealizedSlippageBps ?? 0) >= 8
            ? ['realized_slippage_elevated']
            : []),
        ],
        boundedBy: [
          'allowed_surface:size_multiplier_band',
          'evidence_cap_preserved',
          'cycle_step_limit:0.2',
          'draft_only',
        ],
        evidenceRefs: input.evidenceRefs,
        rollbackCriteria: [
          {
            trigger: 'execution_quality_recovered',
            comparator: 'lte',
            threshold: 0.25,
            rationale: 'Only relax after low-fill stress and slippage pressure recover.',
          },
        ],
        changedAt: input.completedAt.toISOString(),
      });
    }

    return changes.sort((left, right) => left.parameter.localeCompare(right.parameter));
  }
}

function buildReviewOutput(input: {
  cycleId: string;
  metrics: ReturnType<typeof summarizeSamples>;
  warnings: string[];
  evidenceRefs: LearningEvidenceReference[];
  changeSet: LearningParameterChange[];
  sampleSourceSummary: BoundedLearningParameterRecommenderInput['sampleSourceSummary'];
}): LearningReviewOutputs {
  return {
    summary:
      input.changeSet.length > 0
        ? `Generated ${input.changeSet.length} bounded draft parameter recommendations.`
        : 'No bounded parameter changes recommended for this cycle.',
    evidenceRefs: input.evidenceRefs,
    metricSnapshot: input.metrics,
    changeSet: input.changeSet,
    warnings: input.warnings,
    payload: {
      cycleId: input.cycleId,
      draftOnly: true,
      proposalCount: input.changeSet.length,
      allowedSurfaces: [...ALLOWED_SURFACES],
      blocked:
        input.sampleSourceSummary.sourceOfTruth !== 'resolved_trade_ledger' ||
        input.metrics.sampleCount < 3,
      sampleSourceSummary: input.sampleSourceSummary,
      deferredSurfaces: ['max_holding_time_ms', 'cancel_repost_delay_ms'],
    },
  };
}

function normalizeSamples(samples: LearningCycleSample[]): LearningCycleSample[] {
  return [...samples].sort((left, right) =>
    [
      left.strategyVariantId,
      left.regime,
      left.observedAt,
      left.side,
      left.executionStyle,
    ]
      .join('|')
      .localeCompare(
        [
          right.strategyVariantId,
          right.regime,
          right.observedAt,
          right.side,
          right.executionStyle,
        ].join('|'),
      ),
  );
}

function summarizeSamples(samples: LearningCycleSample[]): LearningMetricSnapshot & {
  sampleCount: number;
  averageExpectedNetEdgeBps: number | null;
  averageRealizedNetEdgeBps: number | null;
  realizedVsExpectedRatio: number | null;
  lossRate: number | null;
  averageFillRate: number | null;
  lowFillRateRatio: number | null;
  averageRealizedSlippageBps: number | null;
} {
  const sampleCount = samples.length;
  const averageExpectedNetEdgeBps = average(
    samples.map((sample) => evToBps(sample.expectedEv)),
  );
  const averageRealizedNetEdgeBps = average(
    samples.map((sample) => evToBps(sample.realizedEv)),
  );
  const realizedVsExpectedRatio =
    averageExpectedNetEdgeBps != null &&
    Math.abs(averageExpectedNetEdgeBps) > 1e-9 &&
    averageRealizedNetEdgeBps != null
      ? averageRealizedNetEdgeBps / averageExpectedNetEdgeBps
      : null;
  const lossRate =
    sampleCount > 0
      ? samples.filter((sample) => sample.realizedOutcome <= 0).length / sampleCount
      : null;
  const averageFillRate = average(samples.map((sample) => sample.fillRate));
  const lowFillRateRatio =
    sampleCount > 0
      ? samples.filter((sample) => (sample.fillRate ?? 1) < 0.75).length / sampleCount
      : null;
  const averageRealizedSlippageBps = average(
    samples.map((sample) => evToBps(sample.realizedSlippage)),
  );

  return {
    sampleCount,
    averageExpectedNetEdgeBps: roundNullable(averageExpectedNetEdgeBps, 2),
    averageRealizedNetEdgeBps: roundNullable(averageRealizedNetEdgeBps, 2),
    realizedVsExpectedRatio: roundNullable(realizedVsExpectedRatio, 4),
    lossRate: roundNullable(lossRate, 4),
    averageFillRate: roundNullable(averageFillRate, 4),
    lowFillRateRatio: roundNullable(lowFillRateRatio, 4),
    averageRealizedSlippageBps: roundNullable(averageRealizedSlippageBps, 2),
  };
}

function readPriorRecommendations(
  reviewOutputs: LearningCycleSummary['reviewOutputs'] | null | undefined,
): Partial<Record<AllowedSurface, number>> {
  if (!reviewOutputs || typeof reviewOutputs !== 'object') {
    return {};
  }

  const boundedRecommendations = (reviewOutputs as Record<string, unknown>)
    .boundedParameterRecommendations;
  if (!boundedRecommendations || typeof boundedRecommendations !== 'object') {
    return {};
  }

  const rawChangeSet = (boundedRecommendations as Record<string, unknown>).changeSet;
  if (!Array.isArray(rawChangeSet)) {
    return {};
  }

  const next: Partial<Record<AllowedSurface, number>> = {};
  for (const entry of rawChangeSet) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const parameter = record.parameter;
    const nextValue = record.nextValue;
    if (
      typeof parameter === 'string' &&
      isAllowedSurface(parameter) &&
      typeof nextValue === 'number' &&
      Number.isFinite(nextValue)
    ) {
      next[parameter] = nextValue;
    }
  }

  return next;
}

function isAllowedSurface(value: string): value is AllowedSurface {
  return (ALLOWED_SURFACES as readonly string[]).includes(value);
}

function evToBps(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value * 10_000 : null;
}

function average(values: Array<number | null | undefined>): number | null {
  const filtered = values.filter((value): value is number => Number.isFinite(value ?? Number.NaN));
  if (filtered.length === 0) {
    return null;
  }
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function roundNullable(value: number | null, decimals: number): number | null {
  return value == null ? null : roundTo(value, decimals);
}

function roundTo(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
