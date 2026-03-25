import type { BaselineComparisonReport } from './baseline-comparison';
import { buildBaselineComparison } from './baseline-comparison';
import type { HistoricalExecutableCase } from './p23-validation';

export type RollingBenchmarkWindowKey = '1d' | '3d' | '7d' | '30d';
export type RollingBenchmarkComparisonState =
  | 'outperforming'
  | 'mixed'
  | 'underperforming'
  | 'insufficient_data';
export type RollingBenchmarkDominantState =
  | RollingBenchmarkComparisonState
  | 'balanced';

export interface RollingBenchmarkComparisonEntry {
  benchmarkId: string;
  benchmarkName: string;
  outperformed: boolean;
  realizedEvGap: number;
  retainedEdgeGap: number | null;
}

export interface RollingBenchmarkWindowScore {
  windowKey: RollingBenchmarkWindowKey;
  requestedDays: number;
  effectiveDays: number;
  exactWindowAvailable: boolean;
  sampleCount: number;
  tradeCount: number;
  benchmarkComparisonState: RollingBenchmarkComparisonState;
  outperformedBenchmarkIds: string[];
  underperformedBenchmarkIds: string[];
  strategyExpectedEv: number;
  strategyRealizedEv: number;
  strategyRetainedEdge: number | null;
  benchmarkComparisons: RollingBenchmarkComparisonEntry[];
}

export interface RollingBenchmarkOutperformanceStability {
  stableOutperformance: boolean;
  score: number;
  dominantState: RollingBenchmarkDominantState;
  outperformingWindowCount: number;
  underperformingWindowCount: number;
  mixedWindowCount: number;
  insufficientWindowCount: number;
}

export interface RollingBenchmarkScorecard {
  generatedAt: string;
  anchoredAt: string | null;
  observationRange: {
    from: string;
    to: string;
  } | null;
  windows: RollingBenchmarkWindowScore[];
  stabilityOfOutperformance: RollingBenchmarkOutperformanceStability;
}

export interface RollingBenchmarkScorecardInput {
  executableCases: HistoricalExecutableCase[];
  now?: Date;
  comparisonBuilder?: (
    executableCases: HistoricalExecutableCase[],
  ) => BaselineComparisonReport;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DEFINITIONS: Array<{
  windowKey: RollingBenchmarkWindowKey;
  requestedDays: number;
}> = [
  { windowKey: '1d', requestedDays: 1 },
  { windowKey: '3d', requestedDays: 3 },
  { windowKey: '7d', requestedDays: 7 },
  { windowKey: '30d', requestedDays: 30 },
];

export function buildRollingBenchmarkScorecard(
  input: RollingBenchmarkScorecardInput,
): RollingBenchmarkScorecard {
  if (input.executableCases.length === 0) {
    return {
      generatedAt: (input.now ?? new Date()).toISOString(),
      anchoredAt: null,
      observationRange: null,
      windows: WINDOW_DEFINITIONS.map(({ windowKey, requestedDays }) => ({
        windowKey,
        requestedDays,
        effectiveDays: 0,
        exactWindowAvailable: false,
        sampleCount: 0,
        tradeCount: 0,
        benchmarkComparisonState: 'insufficient_data',
        outperformedBenchmarkIds: [],
        underperformedBenchmarkIds: [],
        strategyExpectedEv: 0,
        strategyRealizedEv: 0,
        strategyRetainedEdge: null,
        benchmarkComparisons: [],
      })),
      stabilityOfOutperformance: {
        stableOutperformance: false,
        score: 0,
        dominantState: 'insufficient_data',
        outperformingWindowCount: 0,
        underperformingWindowCount: 0,
        mixedWindowCount: 0,
        insufficientWindowCount: WINDOW_DEFINITIONS.length,
      },
    };
  }

  const comparisonBuilder = input.comparisonBuilder ?? buildBaselineComparison;
  const sortedCases = [...input.executableCases].sort(
    (left, right) =>
      new Date(left.observedAt).getTime() - new Date(right.observedAt).getTime(),
  );
  const earliestObservedAt = new Date(sortedCases[0].observedAt);
  const latestObservedAt = new Date(sortedCases[sortedCases.length - 1].observedAt);
  const availableDays = Math.max(
    1 / 24,
    (latestObservedAt.getTime() - earliestObservedAt.getTime()) / DAY_MS,
  );

  const windows = WINDOW_DEFINITIONS.map(({ windowKey, requestedDays }) => {
    const cutoff = new Date(latestObservedAt.getTime() - requestedDays * DAY_MS);
    const windowCases = sortedCases.filter(
      (entry) => new Date(entry.observedAt).getTime() >= cutoff.getTime(),
    );
    const exactWindowAvailable = earliestObservedAt.getTime() <= cutoff.getTime();
    const effectiveDays = Number(
      Math.min(requestedDays, availableDays).toFixed(3),
    );

    if (windowCases.length === 0) {
      return {
        windowKey,
        requestedDays,
        effectiveDays,
        exactWindowAvailable,
        sampleCount: 0,
        tradeCount: 0,
        benchmarkComparisonState: 'insufficient_data' as const,
        outperformedBenchmarkIds: [],
        underperformedBenchmarkIds: [],
        strategyExpectedEv: 0,
        strategyRealizedEv: 0,
        strategyRetainedEdge: null,
        benchmarkComparisons: [],
      };
    }

    const comparison = comparisonBuilder(windowCases);
    return {
      windowKey,
      requestedDays,
      effectiveDays,
      exactWindowAvailable,
      sampleCount: comparison.strategy.sampleCount,
      tradeCount: comparison.strategy.tradeCount,
      benchmarkComparisonState: determineComparisonState(comparison),
      outperformedBenchmarkIds: [...comparison.outperformedBenchmarkIds],
      underperformedBenchmarkIds: [...comparison.underperformedBenchmarkIds],
      strategyExpectedEv: comparison.strategy.expectedEv,
      strategyRealizedEv: comparison.strategy.realizedEv,
      strategyRetainedEdge: comparison.strategy.realizedVsExpected,
      benchmarkComparisons: comparison.comparisons.map((entry) => ({
        benchmarkId: entry.benchmarkId,
        benchmarkName: entry.benchmarkName,
        outperformed: entry.strategyOutperformed,
        realizedEvGap: entry.realizedEvGap,
        retainedEdgeGap: entry.realizedVsExpectedGap,
      })),
    };
  });

  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    anchoredAt: latestObservedAt.toISOString(),
    observationRange: {
      from: earliestObservedAt.toISOString(),
      to: latestObservedAt.toISOString(),
    },
    windows,
    stabilityOfOutperformance: summarizeStability(windows),
  };
}

function determineComparisonState(
  comparison: BaselineComparisonReport,
): RollingBenchmarkComparisonState {
  if (comparison.benchmarks.length === 0 || comparison.strategy.sampleCount === 0) {
    return 'insufficient_data';
  }

  if (
    comparison.outperformedBenchmarkIds.length >
    comparison.underperformedBenchmarkIds.length
  ) {
    return 'outperforming';
  }

  if (
    comparison.underperformedBenchmarkIds.length >
    comparison.outperformedBenchmarkIds.length
  ) {
    return 'underperforming';
  }

  return 'mixed';
}

function summarizeStability(
  windows: RollingBenchmarkWindowScore[],
): RollingBenchmarkOutperformanceStability {
  const counts = {
    outperforming: 0,
    underperforming: 0,
    mixed: 0,
    insufficient_data: 0,
  };

  for (const window of windows) {
    counts[window.benchmarkComparisonState] += 1;
  }

  const eligibleWindowCount =
    windows.length - counts.insufficient_data;
  const score =
    eligibleWindowCount === 0
      ? 0
      : Number(
          (
            (counts.outperforming - counts.underperforming) / eligibleWindowCount
          ).toFixed(3),
        );

  return {
    stableOutperformance:
      eligibleWindowCount > 0 &&
      counts.underperforming === 0 &&
      counts.outperforming >= Math.max(2, Math.ceil(eligibleWindowCount / 2)),
    score,
    dominantState: determineDominantState(counts),
    outperformingWindowCount: counts.outperforming,
    underperformingWindowCount: counts.underperforming,
    mixedWindowCount: counts.mixed,
    insufficientWindowCount: counts.insufficient_data,
  };
}

function determineDominantState(counts: {
  outperforming: number;
  underperforming: number;
  mixed: number;
  insufficient_data: number;
}): RollingBenchmarkDominantState {
  const ranked = (
    Object.entries(counts) as Array<[RollingBenchmarkComparisonState, number]>
  ).sort((left, right) => right[1] - left[1]);

  if (ranked[0]?.[1] === 0) {
    return 'insufficient_data';
  }

  if (ranked[0]?.[1] === ranked[1]?.[1]) {
    return 'balanced';
  }

  return ranked[0]?.[0] ?? 'insufficient_data';
}
