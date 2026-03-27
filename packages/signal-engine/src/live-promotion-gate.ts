import type { HealthLabel, ResolvedTradeRecord } from '@polymarket-btc-5m-agentic-bot/domain';

export interface LiveTrustScoreSummaryInput {
  trustScore: number;
  sampleCount: number;
  componentBreakdown: {
    liveTradeCount: number;
    sampleSufficiency: number;
    netExpectancyAfterCosts: number;
    drawdownStability: number;
    executionVariance: number;
    reconciliationCleanliness: number;
    benchmarkOutperformance: number;
  };
  reasonCodes: string[];
}

export interface LivePromotionEvidencePacket {
  strategyVariantId: string;
  evidenceWindowStart: string;
  evidenceWindowEnd: string;
  liveTrustScoreSummary: LiveTrustScoreSummaryInput;
  tradeCount: number;
  realizedNetEdgeSummary: {
    averageNetEdgeBps: number | null;
    totalNetEdgeBps: number;
    positiveTradeShare: number;
  };
  benchmarkComparisonSummary: {
    outperformingCount: number;
    underperformingCount: number;
    neutralCount: number;
    missingCount: number;
    outperformanceShare: number;
  };
  drawdownSummary: {
    maxDrawdownBps: number;
    acceptable: boolean;
  };
  executionVarianceSummary: {
    averageGapBps: number | null;
    stdDevGapBps: number | null;
    acceptable: boolean;
  };
  reconciliationCleanlinessSummary: {
    cleanTradeCount: number;
    anomalyCount: number;
    cleanlinessRatio: number;
    acceptable: boolean;
  };
  regimeInstabilitySummary: {
    regimeCount: number;
    unhealthyRegimeCount: number;
    instabilityScore: number;
  };
  adverseSelectionSummary: {
    spikeCount: number;
    spikeShare: number;
  };
  capturedAt: string;
}

export interface LivePromotionGateComponentResult {
  passed: boolean;
  observedValue: number;
  threshold: number;
}

export interface LivePromotionGateDecision {
  passed: boolean;
  reasonCodes: string[];
  components: {
    minimumLiveTradeCount: LivePromotionGateComponentResult;
    positiveNetEdgeAfterRealizedCosts: LivePromotionGateComponentResult;
    benchmarkOutperformance: LivePromotionGateComponentResult;
    acceptableDrawdown: LivePromotionGateComponentResult;
    acceptableExecutionVariance: LivePromotionGateComponentResult;
    noReconciliationAnomalies: LivePromotionGateComponentResult;
  };
  evidencePacket: LivePromotionEvidencePacket;
  capturedAt: string;
}

export function buildLivePromotionEvidencePacket(input: {
  strategyVariantId: string;
  evidenceWindowStart: string;
  evidenceWindowEnd: string;
  resolvedTrades: ResolvedTradeRecord[];
  liveTrustScoreSummary: LiveTrustScoreSummaryInput;
  regimeSnapshots?: Array<{
    regime: string;
    health: HealthLabel;
    realizedVsExpected?: number | null;
  }>;
  now?: Date;
}): LivePromotionEvidencePacket {
  const now = input.now ?? new Date();
  const realizedNetEdges = input.resolvedTrades
    .map((trade) => readRealizedNetEdgeBps(trade))
    .filter((value): value is number => value != null);
  const expectedGaps = input.resolvedTrades
    .map((trade) => {
      const realized = readRealizedNetEdgeBps(trade);
      const expected = readExpectedNetEdgeBps(trade);
      if (realized == null || expected == null) {
        return null;
      }
      return realized - expected;
    })
    .filter((value): value is number => value != null);
  const positiveTradeShare =
    realizedNetEdges.length === 0
      ? 0
      : realizedNetEdges.filter((value) => value > 0).length / realizedNetEdges.length;
  const drawdown = computeMaxDrawdown(realizedNetEdges);
  const stdDevGap = standardDeviation(expectedGaps);
  const benchmarkCounts = summarizeBenchmarkStates(input.resolvedTrades);
  const cleanTradeCount = input.resolvedTrades.filter(isReconciliationClean).length;
  const anomalyCount = Math.max(0, input.resolvedTrades.length - cleanTradeCount);
  const regimeSnapshots = input.regimeSnapshots ?? [];
  const unhealthyRegimeCount = regimeSnapshots.filter(
    (snapshot) => snapshot.health === 'degraded' || snapshot.health === 'quarantine_candidate',
  ).length;
  const instabilityScore =
    regimeSnapshots.length === 0 ? 0 : unhealthyRegimeCount / regimeSnapshots.length;
  const adverseSelectionSpikeCount = input.resolvedTrades.filter((trade) => {
    if ((trade.toxicityScoreAtDecision ?? 0) >= 0.75) {
      return true;
    }
    return (
      trade.executionAttributionCategory === 'adverse_selection_spike' ||
      trade.lossAttributionCategory === 'toxicity_damage'
    );
  }).length;

  return {
    strategyVariantId: input.strategyVariantId,
    evidenceWindowStart: input.evidenceWindowStart,
    evidenceWindowEnd: input.evidenceWindowEnd,
    liveTrustScoreSummary: input.liveTrustScoreSummary,
    tradeCount: input.resolvedTrades.length,
    realizedNetEdgeSummary: {
      averageNetEdgeBps: average(realizedNetEdges),
      totalNetEdgeBps: realizedNetEdges.reduce((sum, value) => sum + value, 0),
      positiveTradeShare,
    },
    benchmarkComparisonSummary: {
      ...benchmarkCounts,
      outperformanceShare:
        input.resolvedTrades.length === 0
          ? 0
          : benchmarkCounts.outperformingCount / input.resolvedTrades.length,
    },
    drawdownSummary: {
      maxDrawdownBps: drawdown,
      acceptable: drawdown <= 120,
    },
    executionVarianceSummary: {
      averageGapBps: average(expectedGaps),
      stdDevGapBps: stdDevGap,
      acceptable: (stdDevGap ?? Number.POSITIVE_INFINITY) <= 50,
    },
    reconciliationCleanlinessSummary: {
      cleanTradeCount,
      anomalyCount,
      cleanlinessRatio:
        input.resolvedTrades.length === 0 ? 0 : cleanTradeCount / input.resolvedTrades.length,
      acceptable: anomalyCount === 0,
    },
    regimeInstabilitySummary: {
      regimeCount: regimeSnapshots.length,
      unhealthyRegimeCount,
      instabilityScore,
    },
    adverseSelectionSummary: {
      spikeCount: adverseSelectionSpikeCount,
      spikeShare:
        input.resolvedTrades.length === 0
          ? 0
          : adverseSelectionSpikeCount / input.resolvedTrades.length,
    },
    capturedAt: now.toISOString(),
  };
}

export class LivePromotionGate {
  evaluate(input: { evidencePacket: LivePromotionEvidencePacket; now?: Date }): LivePromotionGateDecision {
    const now = input.now ?? new Date();
    const packet = input.evidencePacket;
    const minimumLiveTradeCount = buildComponent(packet.tradeCount, 8, packet.tradeCount >= 8);
    const positiveNetEdgeAfterRealizedCosts = buildComponent(
      packet.realizedNetEdgeSummary.averageNetEdgeBps ?? 0,
      0.0001,
      (packet.realizedNetEdgeSummary.averageNetEdgeBps ?? 0) > 0,
    );
    const benchmarkOutperformance = buildComponent(
      packet.benchmarkComparisonSummary.outperformanceShare,
      0.5,
      packet.benchmarkComparisonSummary.outperformanceShare >= 0.5 &&
        packet.benchmarkComparisonSummary.underperformingCount === 0,
    );
    const acceptableDrawdown = buildComponent(
      packet.drawdownSummary.maxDrawdownBps,
      120,
      packet.drawdownSummary.acceptable,
    );
    const acceptableExecutionVariance = buildComponent(
      packet.executionVarianceSummary.stdDevGapBps ?? Number.POSITIVE_INFINITY,
      50,
      packet.executionVarianceSummary.acceptable,
    );
    const noReconciliationAnomalies = buildComponent(
      packet.reconciliationCleanlinessSummary.anomalyCount,
      0,
      packet.reconciliationCleanlinessSummary.acceptable,
    );

    const reasonCodes: string[] = [];
    if (!minimumLiveTradeCount.passed) {
      reasonCodes.push('minimum_live_trade_count_not_met');
    }
    if (!positiveNetEdgeAfterRealizedCosts.passed) {
      reasonCodes.push('realized_net_edge_non_positive');
    }
    if (!benchmarkOutperformance.passed) {
      reasonCodes.push('benchmark_outperformance_not_met');
    }
    if (!acceptableDrawdown.passed) {
      reasonCodes.push('drawdown_exceeds_promotion_limit');
    }
    if (!acceptableExecutionVariance.passed) {
      reasonCodes.push('execution_variance_above_limit');
    }
    if (!noReconciliationAnomalies.passed) {
      reasonCodes.push('reconciliation_anomalies_present');
    }

    return {
      passed: reasonCodes.length === 0,
      reasonCodes,
      components: {
        minimumLiveTradeCount,
        positiveNetEdgeAfterRealizedCosts,
        benchmarkOutperformance,
        acceptableDrawdown,
        acceptableExecutionVariance,
        noReconciliationAnomalies,
      },
      evidencePacket: packet,
      capturedAt: now.toISOString(),
    };
  }
}

function buildComponent(
  observedValue: number,
  threshold: number,
  passed: boolean,
): LivePromotionGateComponentResult {
  return {
    passed,
    observedValue,
    threshold,
  };
}

function readExpectedNetEdgeBps(record: ResolvedTradeRecord): number | null {
  return finiteOrNull(record.netOutcome.expectedNetEdgeBps) ?? finiteOrNull(record.expectedNetEdgeBps);
}

function readRealizedNetEdgeBps(record: ResolvedTradeRecord): number | null {
  return finiteOrNull(record.netOutcome.realizedNetEdgeBps) ?? finiteOrNull(record.realizedNetEdgeBps);
}

function isReconciliationClean(record: ResolvedTradeRecord): boolean {
  return (
    record.lifecycleState === 'economically_resolved_with_portfolio_truth' &&
    record.venueOrderId != null &&
    record.firstFillTimestamp != null &&
    record.submissionTimestamp != null
  );
}

function summarizeBenchmarkStates(records: ResolvedTradeRecord[]): {
  outperformingCount: number;
  underperformingCount: number;
  neutralCount: number;
  missingCount: number;
} {
  let outperformingCount = 0;
  let underperformingCount = 0;
  let neutralCount = 0;
  let missingCount = 0;
  for (const record of records) {
    const state = record.benchmarkContext?.benchmarkComparisonState ?? null;
    switch (state) {
      case 'outperforming':
      case 'passed':
        outperformingCount += 1;
        break;
      case 'underperforming':
      case 'blocked':
        underperformingCount += 1;
        break;
      case 'neutral':
      case 'mixed':
        neutralCount += 1;
        break;
      default:
        missingCount += 1;
        break;
    }
  }
  return { outperformingCount, underperformingCount, neutralCount, missingCount };
}

function computeMaxDrawdown(values: number[]): number {
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const value of values) {
    cumulative += value;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }
  return maxDrawdown;
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[]): number | null {
  const mean = average(values);
  if (mean == null) {
    return null;
  }
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
