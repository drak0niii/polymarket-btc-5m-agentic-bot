import type { ToxicityRecommendedAction, ToxicityState } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import type { HistoricalExecutableCase } from './p23-validation';

export interface RetentionReportToxicityBucket {
  toxicityState: ToxicityState;
  sampleCount: number;
  expectedEv: number;
  realizedEv: number;
  retentionRatio: number | null;
  averageCalibrationGap: number;
  recommendedActions: ToxicityRecommendedAction[];
}

export interface RetentionReportRegimeEntry {
  regime: string;
  sampleCount: number;
  expectedEv: number;
  realizedEv: number;
  retentionRatio: number | null;
  averageCalibrationGap: number;
  absoluteCalibrationGap: number;
  averageToxicityScore: number;
  dominantToxicityState: ToxicityState | 'mixed';
  toxicityBuckets: RetentionReportToxicityBucket[];
}

export interface RetentionReport {
  generatedAt: string;
  aggregateExpectedEv: number;
  aggregateRealizedEv: number;
  aggregateRetentionRatio: number | null;
  perRegime: RetentionReportRegimeEntry[];
  toxicityConditioned: RetentionReportToxicityBucket[];
}

export function buildRetentionReport(input: {
  executableCases: HistoricalExecutableCase[];
  now?: Date;
}): RetentionReport {
  const generatedAt = (input.now ?? new Date()).toISOString();
  const aggregateExpectedEv = sum(input.executableCases.map((entry) => entry.costAdjustedEv));
  const aggregateRealizedEv = sum(input.executableCases.map((entry) => entry.realizedReturn));
  const perRegime = Array.from(groupBy(input.executableCases, (entry) => entry.regime).entries())
    .map(([regime, cases]) => buildRegimeEntry(regime, cases))
    .sort((left, right) => left.regime.localeCompare(right.regime));
  const toxicityConditioned = Array.from(
    groupBy(input.executableCases, (entry) => entry.toxicity.toxicityState).entries(),
  )
    .map(([toxicityState, cases]) =>
      buildToxicityBucket(toxicityState as ToxicityState, cases),
    )
    .sort((left, right) => toxicitySeverity(right.toxicityState) - toxicitySeverity(left.toxicityState));

  return {
    generatedAt,
    aggregateExpectedEv,
    aggregateRealizedEv,
    aggregateRetentionRatio: calculateRetentionRatio(aggregateExpectedEv, aggregateRealizedEv),
    perRegime,
    toxicityConditioned,
  };
}

function buildRegimeEntry(
  regime: string,
  cases: HistoricalExecutableCase[],
): RetentionReportRegimeEntry {
  const expectedEv = sum(cases.map((entry) => entry.costAdjustedEv));
  const realizedEv = sum(cases.map((entry) => entry.realizedReturn));
  const toxicityBuckets = Array.from(
    groupBy(cases, (entry) => entry.toxicity.toxicityState).entries(),
  )
    .map(([toxicityState, entries]) =>
      buildToxicityBucket(toxicityState as ToxicityState, entries),
    )
    .sort((left, right) => toxicitySeverity(right.toxicityState) - toxicitySeverity(left.toxicityState));

  return {
    regime,
    sampleCount: cases.length,
    expectedEv,
    realizedEv,
    retentionRatio: calculateRetentionRatio(expectedEv, realizedEv),
    averageCalibrationGap: average(cases.map((entry) => entry.realizedOutcome - entry.predictedProbability)),
    absoluteCalibrationGap: average(
      cases.map((entry) => Math.abs(entry.realizedOutcome - entry.predictedProbability)),
    ),
    averageToxicityScore: average(cases.map((entry) => entry.toxicity.toxicityScore)),
    dominantToxicityState: dominantToxicityState(cases),
    toxicityBuckets,
  };
}

function buildToxicityBucket(
  toxicityState: ToxicityState,
  cases: HistoricalExecutableCase[],
): RetentionReportToxicityBucket {
  const expectedEv = sum(cases.map((entry) => entry.costAdjustedEv));
  const realizedEv = sum(cases.map((entry) => entry.realizedReturn));
  return {
    toxicityState,
    sampleCount: cases.length,
    expectedEv,
    realizedEv,
    retentionRatio: calculateRetentionRatio(expectedEv, realizedEv),
    averageCalibrationGap: average(
      cases.map((entry) => entry.realizedOutcome - entry.predictedProbability),
    ),
    recommendedActions: Array.from(
      new Set(cases.map((entry) => entry.toxicity.recommendedAction)),
    ).sort(),
  };
}

function dominantToxicityState(
  cases: HistoricalExecutableCase[],
): ToxicityState | 'mixed' {
  const counts = new Map<ToxicityState, number>();
  for (const entry of cases) {
    counts.set(
      entry.toxicity.toxicityState,
      (counts.get(entry.toxicity.toxicityState) ?? 0) + 1,
    );
  }

  const ordered = Array.from(counts.entries()).sort((left, right) => {
    if (right[1] !== left[1]) {
      return right[1] - left[1];
    }
    return toxicitySeverity(right[0]) - toxicitySeverity(left[0]);
  });

  if (ordered.length === 0) {
    return 'mixed';
  }
  if (ordered.length === 1 || ordered[0]![1] > (cases.length / 2)) {
    return ordered[0]![0];
  }
  return 'mixed';
}

function calculateRetentionRatio(
  expectedEv: number,
  realizedEv: number,
): number | null {
  if (!Number.isFinite(expectedEv) || !Number.isFinite(realizedEv)) {
    return null;
  }
  if (Math.abs(expectedEv) <= 1e-9) {
    return Math.abs(realizedEv) <= 1e-9 ? 1 : null;
  }
  return realizedEv / expectedEv;
}

function groupBy<T>(
  items: T[],
  keySelector: (item: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keySelector(item);
    const bucket = grouped.get(key) ?? [];
    bucket.push(item);
    grouped.set(key, bucket);
  }
  return grouped;
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

function toxicitySeverity(value: ToxicityState): number {
  const severity: Record<ToxicityState, number> = {
    normal: 0,
    elevated: 1,
    high: 2,
    blocked: 3,
  };
  return severity[value];
}
