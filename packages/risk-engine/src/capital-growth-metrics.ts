import type { HealthLabel, TradeQualityScore } from '@polymarket-btc-5m-agentic-bot/domain';
import type { CapitalLeakReportGroup } from './capital-leak-report';
import type { RegimeProfitabilityAssessment } from './regime-profitability-ranker';
import {
  CompoundingEfficiencyScore,
  type CompoundingEfficiencyAssessment,
} from './compounding-efficiency-score';

export interface CapitalGrowthMetricsInput {
  strategyVariantId: string | null;
  tradeQualityScores: TradeQualityScore[];
  regimeAssessments: RegimeProfitabilityAssessment[];
  capitalLeakReportGroup: CapitalLeakReportGroup | null;
  calibrationHealth: HealthLabel | null;
  executionHealth: HealthLabel | null;
  currentDrawdownPct: number | null;
  maxDrawdownPct: number | null;
}

export interface CapitalGrowthMetricsResult {
  strategyVariantId: string | null;
  tradeCount: number;
  netReturn: number;
  drawdownAdjustedGrowth: number;
  evRetention: number | null;
  costLeakageRatio: number | null;
  profitFactorAfterCosts: number | null;
  regimeAdjustedExpectancy: number | null;
  stabilityAdjustedCapitalGrowthScore: number;
  netEdgeQuality: number | null;
  maxDrawdownPct: number | null;
  executionEvRetention: number | null;
  regimeStabilityScore: number | null;
  compoundingEfficiency: CompoundingEfficiencyAssessment;
  reasons: string[];
  evidence: Record<string, unknown>;
}

export class CapitalGrowthMetricsCalculator {
  private readonly compoundingEfficiencyScore = new CompoundingEfficiencyScore();

  evaluate(input: CapitalGrowthMetricsInput): CapitalGrowthMetricsResult {
    const realizedValues = input.tradeQualityScores
      .map((score) => readMetric(score, 'realizedEv'))
      .filter((value): value is number => value != null);
    const expectedValues = input.tradeQualityScores
      .map((score) => readMetric(score, 'expectedEv'))
      .filter((value): value is number => value != null);
    const grossProfit = realizedValues
      .filter((value) => value > 0)
      .reduce((sum, value) => sum + value, 0);
    const grossLoss = Math.abs(
      realizedValues
        .filter((value) => value < 0)
        .reduce((sum, value) => sum + value, 0),
    );
    const netReturn = realizedValues.reduce((sum, value) => sum + value, 0);
    const expectedTotal = expectedValues.reduce((sum, value) => sum + value, 0);
    const evRetention =
      Math.abs(expectedTotal) > 1e-9 ? netReturn / expectedTotal : null;
    const maxDrawdownPct = maxNullable(input.maxDrawdownPct, input.currentDrawdownPct);
    const drawdownPenalty = clamp((maxDrawdownPct ?? 0) / 0.15, 0, 0.9);
    const drawdownAdjustedGrowth = netReturn * (1 - drawdownPenalty);
    const costLeakageRatio =
      input.capitalLeakReportGroup != null
        ? clamp(
            input.capitalLeakReportGroup.totalLeak /
              Math.max(1e-9, Math.abs(netReturn) + input.capitalLeakReportGroup.totalLeak),
            0,
            1,
          )
        : null;
    const profitFactorAfterCosts =
      grossProfit > 0 || grossLoss > 0 ? grossProfit / Math.max(grossLoss, 1e-9) : null;
    const regimeAdjustedExpectancy =
      input.regimeAssessments.length > 0
        ? weightedAverage(
            input.regimeAssessments.map((assessment) => ({
              value: assessment.metrics.netEv * regimeWeight(assessment.rank),
              weight: Math.max(1, assessment.metrics.sampleCount),
            })),
          )
        : null;
    const regimeStabilityScore =
      input.regimeAssessments.length > 0
        ? weightedAverage(
            input.regimeAssessments.map((assessment) => ({
              value:
                assessment.rank === 'strong_regime'
                  ? 1
                  : assessment.rank === 'tradable_regime'
                    ? 0.75
                    : assessment.rank === 'marginal_regime'
                      ? 0.4
                      : 0.1,
              weight: Math.max(1, assessment.metrics.sampleCount),
            })),
          )
        : null;
    const netEdgeQuality =
      input.regimeAssessments.length > 0
        ? weightedAverage(
            input.regimeAssessments.map((assessment) => ({
              value: assessment.metrics.netEv,
              weight: Math.max(1, assessment.metrics.sampleCount),
            })),
          )
        : null;
    const compoundingEfficiency = this.compoundingEfficiencyScore.evaluate({
      netReturn,
      drawdownAdjustedGrowth,
      evRetention,
      costLeakageRatio,
      profitFactorAfterCosts,
      regimeAdjustedExpectancy,
      calibrationHealth: input.calibrationHealth,
      executionHealth: input.executionHealth,
    });
    const reasons: string[] = [];

    if (netReturn > 0) {
      reasons.push('net_return_positive');
    } else {
      reasons.push('net_return_non_positive');
    }
    if ((costLeakageRatio ?? 0) > 0.35) {
      reasons.push('cost_leakage_ratio_elevated');
    }
    if ((evRetention ?? 0) < 0.9) {
      reasons.push('ev_retention_below_target');
    }
    if ((regimeAdjustedExpectancy ?? 0) <= 0) {
      reasons.push('regime_adjusted_expectancy_non_positive');
    }
    if ((maxDrawdownPct ?? 0) >= 0.08) {
      reasons.push('drawdown_elevated');
    }

    return {
      strategyVariantId: input.strategyVariantId,
      tradeCount: input.tradeQualityScores.length,
      netReturn,
      drawdownAdjustedGrowth,
      evRetention,
      costLeakageRatio,
      profitFactorAfterCosts,
      regimeAdjustedExpectancy,
      stabilityAdjustedCapitalGrowthScore: compoundingEfficiency.score,
      netEdgeQuality,
      maxDrawdownPct,
      executionEvRetention: evRetention,
      regimeStabilityScore,
      compoundingEfficiency,
      reasons,
      evidence: {
        grossProfit,
        grossLoss,
        expectedTotal,
        currentDrawdownPct: input.currentDrawdownPct,
        maxDrawdownPct: input.maxDrawdownPct,
        capitalLeakReportGroup: input.capitalLeakReportGroup,
        regimeAssessments: input.regimeAssessments,
        calibrationHealth: input.calibrationHealth,
        executionHealth: input.executionHealth,
      },
    };
  }
}

function readMetric(score: TradeQualityScore, key: 'expectedEv' | 'realizedEv'): number | null {
  const evidence = score.breakdown.realizedOutcomeQuality.evidence;
  const value = evidence[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function regimeWeight(rank: RegimeProfitabilityAssessment['rank']): number {
  if (rank === 'strong_regime') {
    return 1;
  }
  if (rank === 'tradable_regime') {
    return 0.8;
  }
  if (rank === 'marginal_regime') {
    return 0.4;
  }
  return 0.1;
}

function weightedAverage(
  items: Array<{ value: number | null; weight: number }>,
): number | null {
  const usable = items.filter(
    (item): item is { value: number; weight: number } =>
      item.value != null &&
      Number.isFinite(item.value) &&
      Number.isFinite(item.weight) &&
      item.weight > 0,
  );
  if (usable.length === 0) {
    return null;
  }
  const totalWeight = usable.reduce((sum, item) => sum + item.weight, 0);
  return usable.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight;
}

function maxNullable(...values: Array<number | null | undefined>): number | null {
  const usable = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (usable.length === 0) {
    return null;
  }
  return Math.max(...usable);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
