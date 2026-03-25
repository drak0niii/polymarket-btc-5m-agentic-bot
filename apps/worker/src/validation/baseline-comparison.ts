import {
  BtcFollowBaseline,
  MomentumBaseline,
  NoRegimeBaseline,
  ReversionBaseline,
  type BenchmarkOpportunityClass,
  type BenchmarkReplayCase,
  type BenchmarkSummary,
} from '@polymarket-btc-5m-agentic-bot/signal-engine';
import type { HistoricalExecutableCase } from './p23-validation';

export interface StrategyBenchmarkSummary {
  benchmarkId: 'strategy';
  benchmarkName: 'Primary Strategy';
  sampleCount: number;
  tradeCount: number;
  expectedEv: number;
  realizedEv: number;
  realizedVsExpected: number | null;
  opportunityClassDistribution: Record<BenchmarkOpportunityClass, number>;
  regimeBreakdown: BenchmarkSummary['regimeBreakdown'];
}

export interface BaselineComparisonEntry {
  benchmarkId: string;
  benchmarkName: string;
  expectedEvGap: number;
  realizedEvGap: number;
  realizedVsExpectedGap: number | null;
  tradeCountGap: number;
  strategyOutperformed: boolean;
}

export interface BaselineComparisonReport {
  generatedAt: string;
  strategy: StrategyBenchmarkSummary;
  benchmarks: BenchmarkSummary[];
  comparisons: BaselineComparisonEntry[];
  outperformedBenchmarkIds: string[];
  underperformedBenchmarkIds: string[];
}

export function buildBaselineComparison(
  executableCases: HistoricalExecutableCase[],
): BaselineComparisonReport {
  const replayCases = executableCases.map(mapHistoricalCaseToBenchmarkCase);
  const strategy = summarizeStrategy(executableCases);
  const benchmarks = [
    new BtcFollowBaseline().evaluate(replayCases),
    new MomentumBaseline().evaluate(replayCases),
    new ReversionBaseline().evaluate(replayCases),
    new NoRegimeBaseline().evaluate(replayCases),
  ];
  const comparisons = benchmarks.map((benchmark) => ({
    benchmarkId: benchmark.benchmarkId,
    benchmarkName: benchmark.benchmarkName,
    expectedEvGap: strategy.expectedEv - benchmark.expectedEv,
    realizedEvGap: strategy.realizedEv - benchmark.realizedEv,
    realizedVsExpectedGap:
      strategy.realizedVsExpected != null && benchmark.realizedVsExpected != null
        ? strategy.realizedVsExpected - benchmark.realizedVsExpected
        : null,
    tradeCountGap: strategy.tradeCount - benchmark.tradeCount,
    strategyOutperformed:
      strategy.realizedEv > benchmark.realizedEv &&
      strategy.expectedEv >= benchmark.expectedEv,
  }));

  return {
    generatedAt: new Date().toISOString(),
    strategy,
    benchmarks,
    comparisons,
    outperformedBenchmarkIds: comparisons
      .filter((comparison) => comparison.strategyOutperformed)
      .map((comparison) => comparison.benchmarkId),
    underperformedBenchmarkIds: comparisons
      .filter((comparison) => !comparison.strategyOutperformed)
      .map((comparison) => comparison.benchmarkId),
  };
}

function summarizeStrategy(
  executableCases: HistoricalExecutableCase[],
): StrategyBenchmarkSummary {
  const opportunityClassDistribution = createDistribution();
  const regimeBuckets = new Map<string, HistoricalExecutableCase[]>();

  for (const entry of executableCases) {
    opportunityClassDistribution[classifyOpportunity(entry.costAdjustedEv)] += 1;
    const bucket = regimeBuckets.get(entry.regime) ?? [];
    bucket.push(entry);
    regimeBuckets.set(entry.regime, bucket);
  }

  return {
    benchmarkId: 'strategy',
    benchmarkName: 'Primary Strategy',
    sampleCount: executableCases.length,
    tradeCount: executableCases.filter((entry) => entry.costAdjustedEv > 0.0025).length,
    expectedEv: average(executableCases.map((entry) => entry.costAdjustedEv)),
    realizedEv: average(executableCases.map((entry) => entry.realizedReturn)),
    realizedVsExpected: ratio(
      sum(executableCases.map((entry) => entry.realizedReturn)),
      sum(executableCases.map((entry) => entry.costAdjustedEv)),
    ),
    opportunityClassDistribution,
    regimeBreakdown: Array.from(regimeBuckets.entries())
      .map(([regime, records]) => ({
        regime,
        sampleCount: records.length,
        tradeCount: records.filter((entry) => entry.costAdjustedEv > 0.0025).length,
        expectedEv: average(records.map((entry) => entry.costAdjustedEv)),
        realizedEv: average(records.map((entry) => entry.realizedReturn)),
        realizedVsExpected: ratio(
          sum(records.map((entry) => entry.realizedReturn)),
          sum(records.map((entry) => entry.costAdjustedEv)),
        ),
        opportunityClassDistribution: records.reduce((distribution, record) => {
          distribution[classifyOpportunity(record.costAdjustedEv)] += 1;
          return distribution;
        }, createDistribution()),
      }))
      .sort((left, right) => left.regime.localeCompare(right.regime)),
  };
}

function mapHistoricalCaseToBenchmarkCase(
  entry: HistoricalExecutableCase,
): BenchmarkReplayCase {
  return {
    observationId: entry.observationId,
    observedAt: entry.observedAt,
    regime: entry.regime,
    marketImpliedProbabilityUp: entry.marketImpliedProbabilityUp,
    realizedOutcomeUp: entry.realizedOutcomeUp,
    fillRate: entry.fillRate,
    spreadCost: entry.spreadCost,
    slippageCost: entry.slippageCost,
    feeCost: entry.feeCost,
    latencyCost: entry.latencyCost,
    timeoutCancelCost: entry.timeoutCancelCost,
    timeBucket: entry.timeBucket,
    marketStructureBucket: entry.marketStructureBucket,
    featureSnapshot: entry.featureSnapshot,
  };
}

function classifyOpportunity(value: number): BenchmarkOpportunityClass {
  if (value >= 0.012) {
    return 'strong_edge';
  }
  if (value >= 0.006) {
    return 'tradable_edge';
  }
  if (value > 0) {
    return 'marginal_edge';
  }
  return 'weak_edge';
}

function createDistribution(): Record<BenchmarkOpportunityClass, number> {
  return {
    strong_edge: 0,
    tradable_edge: 0,
    marginal_edge: 0,
    weak_edge: 0,
  };
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return sum(values) / values.length;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(denominator) || Math.abs(denominator) <= 1e-9) {
    return null;
  }

  return numerator / denominator;
}
