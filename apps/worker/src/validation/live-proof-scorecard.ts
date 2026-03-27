import type { DatasetQualityReport } from './dataset-quality';
import type { BaselineComparisonReport } from './baseline-comparison';
import type { DailyDecisionQualityReport } from './daily-decision-quality-report';
import type { RetentionReport } from './retention-report';
import type { RegimePerformanceReport } from './regime-performance-report';

export type LiveProofEvidenceClass =
  | 'empirical_promotable'
  | 'empirical_blocked'
  | 'synthetic_smoke_only';

export type LiveProofRecommendation =
  | 'eligible_as_empirical_proof'
  | 'collect_more_empirical_evidence'
  | 'repair_strategy_before_promotion'
  | 'synthetic_smoke_only_not_promotable';

export interface LiveProofScorecard {
  generatedAt: string;
  evidenceClass: LiveProofEvidenceClass;
  promotableEvidence: boolean;
  proofScore: number;
  recommendation: LiveProofRecommendation;
  summary: string;
  blockers: string[];
  strengths: string[];
  benchmarkComparisonSummary: {
    outperformedCount: number;
    underperformedCount: number;
    outperformedBenchmarkIds: string[];
    underperformedBenchmarkIds: string[];
  };
  regimeSummary: {
    regimeCount: number;
    positiveRetentionRegimeCount: number;
    negativeRetentionRegimeCount: number;
    strongestRegimes: string[];
    weakestRegimes: string[];
  };
  toxicitySummary: {
    elevatedOrWorseShare: number;
    blockedShare: number;
  };
  dailyDecisionQualitySummary: {
    dayCount: number;
    positiveNetDayShare: number;
    averageNetPnlAfterFees: number;
    averageRealizedVsExpectedGapBps: number | null;
  } | null;
}

export function buildLiveProofScorecard(input: {
  mode: 'empirical' | 'synthetic_smoke';
  datasetType: 'empirical' | 'synthetic';
  datasetQuality: Pick<DatasetQualityReport, 'verdict' | 'blockingReasons' | 'warnings'>;
  evidence: {
    empiricalEvidenceUsed: boolean;
    syntheticAllowed: boolean;
  };
  governance: {
    confidence: number;
    promotionEligible: boolean;
    failReasons: string[];
  };
  robustness: {
    passed: boolean;
    score: number;
  };
  promotion: {
    promoted: boolean;
    score: number;
    reasons: string[];
  };
  baselineComparison: BaselineComparisonReport;
  retentionReport: RetentionReport;
  regimePerformanceReport: RegimePerformanceReport;
  dailyDecisionQualityReport?: DailyDecisionQualityReport | null;
  now?: Date;
}): LiveProofScorecard {
  const blockers = new Set<string>();
  const strengths = new Set<string>();
  const syntheticOnly =
    input.mode === 'synthetic_smoke' ||
    input.datasetType !== 'empirical' ||
    !input.evidence.empiricalEvidenceUsed;

  if (syntheticOnly) {
    blockers.add('synthetic_only_evidence_not_promotable');
  }
  if (input.datasetQuality.verdict !== 'accepted') {
    blockers.add('dataset_quality_not_accepted');
  } else {
    strengths.add('dataset_quality_accepted');
  }
  if (!input.governance.promotionEligible) {
    blockers.add('governance_not_promotion_eligible');
  } else {
    strengths.add('governance_promotion_eligible');
  }
  if (!input.robustness.passed) {
    blockers.add('robustness_not_passed');
  } else {
    strengths.add('robustness_passed');
  }
  if (!input.promotion.promoted) {
    blockers.add('promotion_score_not_passed');
  } else {
    strengths.add('promotion_score_passed');
  }

  const aggregateRetentionRatio = input.retentionReport.aggregateRetentionRatio;
  if (aggregateRetentionRatio == null || aggregateRetentionRatio < 0.75) {
    blockers.add('aggregate_retention_below_threshold');
  } else {
    strengths.add('aggregate_retention_healthy');
  }

  if (
    input.baselineComparison.underperformedBenchmarkIds.length >
    input.baselineComparison.outperformedBenchmarkIds.length
  ) {
    blockers.add('benchmark_underperformance_dominant');
  } else if (input.baselineComparison.outperformedBenchmarkIds.length > 0) {
    strengths.add('benchmarks_beaten');
  }

  if (input.regimePerformanceReport.weakestRegimes.length > 0) {
    const weakestEntry = input.regimePerformanceReport.perRegime.find(
      (entry) => entry.regime === input.regimePerformanceReport.weakestRegimes[0],
    );
    if (
      weakestEntry &&
      (weakestEntry.realizedEv < 0 || (weakestEntry.retentionRatio ?? -1) < 0.5)
    ) {
      blockers.add('destructive_regime_present');
    }
  }

  const elevatedOrWorseShare = ratio(
    input.retentionReport.toxicityConditioned
      .filter((entry) => entry.toxicityState !== 'normal')
      .reduce((sum, entry) => sum + entry.sampleCount, 0),
    input.retentionReport.toxicityConditioned.reduce((sum, entry) => sum + entry.sampleCount, 0),
  );
  const blockedShare = ratio(
    input.retentionReport.toxicityConditioned
      .filter((entry) => entry.toxicityState === 'blocked')
      .reduce((sum, entry) => sum + entry.sampleCount, 0),
    input.retentionReport.toxicityConditioned.reduce((sum, entry) => sum + entry.sampleCount, 0),
  );
  if (blockedShare > 0.15) {
    blockers.add('blocked_toxicity_share_too_high');
  }

  const dailyDecisionQualitySummary = summarizeDailyDecisionQuality(
    input.dailyDecisionQualityReport ?? null,
  );
  if (dailyDecisionQualitySummary) {
    if (dailyDecisionQualitySummary.positiveNetDayShare < 0.5) {
      blockers.add('daily_net_day_share_too_low');
    } else {
      strengths.add('daily_net_day_share_healthy');
    }
    if (
      dailyDecisionQualitySummary.averageRealizedVsExpectedGapBps != null &&
      dailyDecisionQualitySummary.averageRealizedVsExpectedGapBps < -40
    ) {
      blockers.add('daily_realized_vs_expected_gap_too_negative');
    } else {
      strengths.add('daily_realized_vs_expected_gap_acceptable');
    }
  }

  const proofScore = clamp01(
    input.governance.confidence * 0.25 +
      input.robustness.score * 0.2 +
      input.promotion.score * 0.15 +
      clamp01(aggregateRetentionRatio ?? 0) * 0.2 +
      ratio(
        input.baselineComparison.outperformedBenchmarkIds.length,
        input.baselineComparison.benchmarks.length,
      ) * 0.1 +
      ratio(
        input.regimePerformanceReport.perRegime.filter(
          (entry) => (entry.retentionRatio ?? -1) >= 0.75,
        ).length,
        input.regimePerformanceReport.perRegime.length,
      ) * 0.1 +
      (dailyDecisionQualitySummary?.positiveNetDayShare ?? 0) * 0.05,
  );

  const promotableEvidence =
    !syntheticOnly &&
    input.datasetQuality.verdict === 'accepted' &&
    input.governance.promotionEligible &&
    input.robustness.passed &&
    blockers.size === 0;

  const evidenceClass: LiveProofEvidenceClass = syntheticOnly
    ? 'synthetic_smoke_only'
    : promotableEvidence
      ? 'empirical_promotable'
      : 'empirical_blocked';
  const recommendation: LiveProofRecommendation = syntheticOnly
    ? 'synthetic_smoke_only_not_promotable'
    : promotableEvidence
      ? 'eligible_as_empirical_proof'
      : input.datasetQuality.verdict !== 'accepted'
        ? 'collect_more_empirical_evidence'
        : 'repair_strategy_before_promotion';

  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    evidenceClass,
    promotableEvidence,
    proofScore,
    recommendation,
    summary: summarizeScorecard(evidenceClass, promotableEvidence, proofScore, blockers),
    blockers: Array.from(blockers).sort(),
    strengths: Array.from(strengths).sort(),
    benchmarkComparisonSummary: {
      outperformedCount: input.baselineComparison.outperformedBenchmarkIds.length,
      underperformedCount: input.baselineComparison.underperformedBenchmarkIds.length,
      outperformedBenchmarkIds: [...input.baselineComparison.outperformedBenchmarkIds],
      underperformedBenchmarkIds: [...input.baselineComparison.underperformedBenchmarkIds],
    },
    regimeSummary: {
      regimeCount: input.regimePerformanceReport.perRegime.length,
      positiveRetentionRegimeCount: input.regimePerformanceReport.perRegime.filter(
        (entry) => (entry.retentionRatio ?? -1) >= 0.75,
      ).length,
      negativeRetentionRegimeCount: input.regimePerformanceReport.perRegime.filter(
        (entry) => (entry.retentionRatio ?? 0) < 0,
      ).length,
      strongestRegimes: [...input.regimePerformanceReport.strongestRegimes],
      weakestRegimes: [...input.regimePerformanceReport.weakestRegimes],
    },
    toxicitySummary: {
      elevatedOrWorseShare,
      blockedShare,
    },
    dailyDecisionQualitySummary,
  };
}

function summarizeScorecard(
  evidenceClass: LiveProofEvidenceClass,
  promotableEvidence: boolean,
  proofScore: number,
  blockers: Set<string>,
): string {
  if (evidenceClass === 'synthetic_smoke_only') {
    return `Synthetic smoke evidence only; proof score ${proofScore.toFixed(3)} is not promotable.`;
  }
  if (promotableEvidence) {
    return `Empirical proof is promotable with proof score ${proofScore.toFixed(3)}.`;
  }
  return `Empirical proof remains blocked with proof score ${proofScore.toFixed(3)} because ${Array.from(blockers).slice(0, 3).join(', ')}.`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function ratio(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }
  return numerator / denominator;
}

function summarizeDailyDecisionQuality(
  report: DailyDecisionQualityReport | null,
): LiveProofScorecard['dailyDecisionQualitySummary'] {
  if (!report || report.byDay.length === 0) {
    return null;
  }
  const positiveNetDayShare = ratio(
    report.summary.positiveNetDayCount,
    report.summary.dayCount,
  );
  const averageNetPnlAfterFees =
    report.byDay.reduce((sum, entry) => sum + entry.netPnlAfterFees, 0) /
    report.byDay.length;
  const realizedGapValues = report.byDay
    .map((entry) => entry.realizedVsExpectedGapBps)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const averageRealizedVsExpectedGapBps =
    realizedGapValues.length === 0
      ? null
      : realizedGapValues.reduce((sum, value) => sum + value, 0) /
        realizedGapValues.length;

  return {
    dayCount: report.summary.dayCount,
    positiveNetDayShare,
    averageNetPnlAfterFees,
    averageRealizedVsExpectedGapBps,
  };
}
