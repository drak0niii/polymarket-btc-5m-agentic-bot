import type { ResolvedTradeRecord } from '@polymarket-btc-5m-agentic-bot/domain';

export interface LiveTrustScoreComponentBreakdown {
  liveTradeCount: number;
  sampleSufficiency: number;
  netExpectancyAfterCosts: number;
  drawdownStability: number;
  executionVariance: number;
  reconciliationCleanliness: number;
  benchmarkOutperformance: number;
}

export interface LiveTrustScoreInput {
  strategyVariantId: string | null;
  regime: string | null;
  resolvedTrades: ResolvedTradeRecord[];
}

export interface LiveTrustScoreDecision {
  strategyVariantId: string | null;
  regime: string | null;
  trustScore: number;
  sampleCount: number;
  componentBreakdown: LiveTrustScoreComponentBreakdown;
  reasonCodes: string[];
  evidence: Record<string, unknown>;
  capturedAt: string;
}

export class LiveTrustScore {
  evaluate(input: LiveTrustScoreInput): LiveTrustScoreDecision {
    const filteredTrades = input.resolvedTrades.filter((trade) => {
      if (
        input.strategyVariantId != null &&
        trade.strategyVariantId !== input.strategyVariantId
      ) {
        return false;
      }
      if (input.regime != null && trade.regime !== input.regime) {
        return false;
      }
      return true;
    });

    const realizedEdges = filteredTrades.map((trade) => readRealizedNetEdgeBps(trade));
    const expectedEdges = filteredTrades.map((trade) => readExpectedNetEdgeBps(trade));
    const deltas = filteredTrades
      .map((trade) => {
        const expected = readExpectedNetEdgeBps(trade);
        const realized = readRealizedNetEdgeBps(trade);
        if (expected == null || realized == null) {
          return null;
        }
        return realized - expected;
      })
      .filter((value): value is number => value != null);
    const sampleCount = filteredTrades.length;
    const averageRealizedEdge = average(realizedEdges);
    const sampleSufficiency = sampleScore(sampleCount);
    const netExpectancyAfterCosts = expectancyScore(averageRealizedEdge);
    const drawdownStability = drawdownScore(realizedEdges);
    const executionVariance = varianceScore(deltas);
    const reconciliationCleanliness = reconciliationScore(filteredTrades);
    const benchmarkOutperformance = benchmarkScore(filteredTrades);
    const componentBreakdown: LiveTrustScoreComponentBreakdown = {
      liveTradeCount: sampleCount,
      sampleSufficiency,
      netExpectancyAfterCosts,
      drawdownStability,
      executionVariance,
      reconciliationCleanliness,
      benchmarkOutperformance,
    };

    const weightedScore =
      sampleSufficiency * 0.2 +
      netExpectancyAfterCosts * 0.24 +
      drawdownStability * 0.16 +
      executionVariance * 0.14 +
      reconciliationCleanliness * 0.12 +
      benchmarkOutperformance * 0.14;
    const trustScore = clamp(weightedScore, 0, 1);

    const reasonCodes: string[] = [];
    if (sampleCount < 4) {
      reasonCodes.push('live_trade_sample_thin');
    }
    if ((averageRealizedEdge ?? 0) <= 0) {
      reasonCodes.push('net_expectancy_after_costs_non_positive');
    }
    if (drawdownStability < 0.55) {
      reasonCodes.push('drawdown_stability_weak');
    }
    if (executionVariance < 0.55) {
      reasonCodes.push('execution_variance_elevated');
    }
    if (reconciliationCleanliness < 0.7) {
      reasonCodes.push('reconciliation_cleanliness_weak');
    }
    if (benchmarkOutperformance < 0.5) {
      reasonCodes.push('benchmark_outperformance_unproven');
    }
    if (trustScore < 0.25) {
      reasonCodes.push('trust_score_shadow_only');
    } else if (trustScore < 0.45) {
      reasonCodes.push('trust_score_heavily_capped');
    } else if (trustScore < 0.65) {
      reasonCodes.push('trust_score_partially_capped');
    }

    return {
      strategyVariantId: input.strategyVariantId,
      regime: input.regime,
      trustScore,
      sampleCount,
      componentBreakdown,
      reasonCodes,
      evidence: {
        averageRealizedNetEdgeBps: averageRealizedEdge,
        averageExpectedNetEdgeBps: average(expectedEdges),
        averageRealizedVsExpectedDeltaBps: average(deltas),
        resolvedTradeIds: filteredTrades.map((trade) => trade.tradeId).slice(-50),
        benchmarkStates: summarizeBenchmarkStates(filteredTrades),
      },
      capturedAt: new Date().toISOString(),
    };
  }
}

function readExpectedNetEdgeBps(record: ResolvedTradeRecord): number | null {
  return finiteOrNull(record.netOutcome.expectedNetEdgeBps) ?? finiteOrNull(record.expectedNetEdgeBps);
}

function readRealizedNetEdgeBps(record: ResolvedTradeRecord): number | null {
  return finiteOrNull(record.netOutcome.realizedNetEdgeBps) ?? finiteOrNull(record.realizedNetEdgeBps);
}

function sampleScore(sampleCount: number): number {
  if (sampleCount <= 0) {
    return 0;
  }
  if (sampleCount < 3) {
    return 0.15;
  }
  if (sampleCount < 6) {
    return 0.35;
  }
  if (sampleCount < 10) {
    return 0.55;
  }
  if (sampleCount < 20) {
    return 0.75;
  }
  return 1;
}

function expectancyScore(averageRealizedEdgeBps: number | null): number {
  if (averageRealizedEdgeBps == null) {
    return 0;
  }
  if (averageRealizedEdgeBps <= -25) {
    return 0;
  }
  if (averageRealizedEdgeBps <= 0) {
    return 0.2;
  }
  if (averageRealizedEdgeBps <= 20) {
    return 0.45;
  }
  if (averageRealizedEdgeBps <= 60) {
    return 0.7;
  }
  if (averageRealizedEdgeBps <= 120) {
    return 0.88;
  }
  return 1;
}

function drawdownScore(values: Array<number | null>): number {
  const usable = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (usable.length === 0) {
    return 0;
  }
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const value of usable) {
    cumulative += value;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.min(maxDrawdown, cumulative - peak);
  }
  const magnitude = Math.abs(maxDrawdown);
  if (magnitude <= 20) {
    return 1;
  }
  if (magnitude <= 60) {
    return 0.8;
  }
  if (magnitude <= 120) {
    return 0.55;
  }
  if (magnitude <= 200) {
    return 0.3;
  }
  return 0.1;
}

function varianceScore(values: number[]): number {
  if (values.length === 0) {
    return 0.35;
  }
  const mean = average(values) ?? 0;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);
  if (stdDev <= 10) {
    return 1;
  }
  if (stdDev <= 25) {
    return 0.82;
  }
  if (stdDev <= 50) {
    return 0.62;
  }
  if (stdDev <= 90) {
    return 0.38;
  }
  return 0.18;
}

function reconciliationScore(records: ResolvedTradeRecord[]): number {
  if (records.length === 0) {
    return 0;
  }
  const total = records.reduce((sum, record) => {
    let score = 0.4;
    if (record.lifecycleState === 'economically_resolved_with_portfolio_truth') {
      score += 0.3;
    } else if (record.lifecycleState === 'economically_resolved') {
      score += 0.15;
    }
    if (record.averageFillPrice != null) {
      score += 0.1;
    }
    if (record.submissionTimestamp != null && record.firstFillTimestamp != null) {
      score += 0.1;
    }
    if (record.venueOrderId != null) {
      score += 0.05;
    }
    if (record.attribution.reasonCodes.length > 0) {
      score += 0.05;
    }
    return sum + clamp(score, 0, 1);
  }, 0);
  return total / records.length;
}

function benchmarkScore(records: ResolvedTradeRecord[]): number {
  const scores = records.reduce<number[]>((items, record) => {
    const state =
      record.attribution.benchmarkContext?.benchmarkComparisonState ??
      record.benchmarkContext?.benchmarkComparisonState ??
      null;
    if (state === 'outperforming') {
      items.push(1);
    } else if (state === 'neutral') {
      items.push(0.55);
    } else if (state === 'underperforming') {
      items.push(0.15);
    } else if (state === 'context_missing') {
      items.push(0.3);
    }
    return items;
  }, []);
  if (scores.length === 0) {
    return 0.35;
  }
  return average(scores) ?? 0.35;
}

function summarizeBenchmarkStates(
  records: ResolvedTradeRecord[],
): Record<string, number> {
  return records.reduce<Record<string, number>>((summary, record) => {
    const state =
      record.attribution.benchmarkContext?.benchmarkComparisonState ??
      record.benchmarkContext?.benchmarkComparisonState ??
      'unknown';
    summary[state] = (summary[state] ?? 0) + 1;
    return summary;
  }, {});
}

function average(values: Array<number | null | undefined>): number | null {
  const usable = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (usable.length === 0) {
    return null;
  }
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
