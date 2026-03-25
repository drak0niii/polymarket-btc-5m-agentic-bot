import type { BaselineComparisonReport } from './baseline-comparison';
import type { HistoricalExecutableCase } from './p23-validation';
import type { ToxicityState } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { buildRetentionReport, type RetentionReport, type RetentionReportToxicityBucket } from './retention-report';

export interface BenchmarkComparisonSummary {
  benchmarkCount: number;
  outperformedCount: number;
  underperformedCount: number;
  outperformedBenchmarkIds: string[];
  underperformedBenchmarkIds: string[];
}

export interface RegimePerformanceEntry {
  regime: string;
  sampleCount: number;
  expectedEv: number;
  realizedEv: number;
  retentionRatio: number | null;
  averageCalibrationGap: number;
  absoluteCalibrationGap: number;
  averageToxicityScore: number;
  dominantToxicityState: ToxicityState | 'mixed';
  toxicityConditionedResults: RetentionReportToxicityBucket[];
}

export interface RegimePerformanceReport {
  generatedAt: string;
  perRegime: RegimePerformanceEntry[];
  toxicityConditionedResults: RetentionReportToxicityBucket[];
  benchmarkComparisonSummary: BenchmarkComparisonSummary;
  strongestRegimes: string[];
  weakestRegimes: string[];
}

export function buildRegimePerformanceReport(input: {
  executableCases: HistoricalExecutableCase[];
  baselineComparison: BaselineComparisonReport;
  retentionReport?: RetentionReport;
  now?: Date;
}): RegimePerformanceReport {
  const retentionReport =
    input.retentionReport ?? buildRetentionReport({ executableCases: input.executableCases, now: input.now });
  const perRegime: RegimePerformanceEntry[] = retentionReport.perRegime.map((entry) => ({
    regime: entry.regime,
    sampleCount: entry.sampleCount,
    expectedEv: entry.expectedEv,
    realizedEv: entry.realizedEv,
    retentionRatio: entry.retentionRatio,
    averageCalibrationGap: entry.averageCalibrationGap,
    absoluteCalibrationGap: entry.absoluteCalibrationGap,
    averageToxicityScore: entry.averageToxicityScore,
    dominantToxicityState: entry.dominantToxicityState,
    toxicityConditionedResults: entry.toxicityBuckets,
  }));
  const strongestRegimes = [...perRegime]
    .sort(compareRegimesStrongestFirst)
    .slice(0, 3)
    .map((entry) => entry.regime);
  const weakestRegimes = [...perRegime]
    .sort(compareRegimesWeakestFirst)
    .slice(0, 3)
    .map((entry) => entry.regime);

  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    perRegime,
    toxicityConditionedResults: retentionReport.toxicityConditioned,
    benchmarkComparisonSummary: {
      benchmarkCount: input.baselineComparison.benchmarks.length,
      outperformedCount: input.baselineComparison.outperformedBenchmarkIds.length,
      underperformedCount: input.baselineComparison.underperformedBenchmarkIds.length,
      outperformedBenchmarkIds: [...input.baselineComparison.outperformedBenchmarkIds],
      underperformedBenchmarkIds: [...input.baselineComparison.underperformedBenchmarkIds],
    },
    strongestRegimes,
    weakestRegimes,
  };
}

function compareRegimesStrongestFirst(
  left: RegimePerformanceEntry,
  right: RegimePerformanceEntry,
): number {
  return regimeScore(right) - regimeScore(left);
}

function compareRegimesWeakestFirst(
  left: RegimePerformanceEntry,
  right: RegimePerformanceEntry,
): number {
  return regimeScore(left) - regimeScore(right);
}

function regimeScore(entry: RegimePerformanceEntry): number {
  return (
    entry.realizedEv * 0.45 +
    (entry.retentionRatio ?? -1) * 0.35 -
    Math.abs(entry.averageCalibrationGap) * 0.15 -
    entry.averageToxicityScore * 0.05
  );
}
