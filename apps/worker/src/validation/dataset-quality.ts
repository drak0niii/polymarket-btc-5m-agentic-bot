import fs from 'fs';
import path from 'path';
import type {
  HistoricalExecutableCase,
  HistoricalValidationDataset,
} from './p23-validation';

export type DatasetQualityVerdict =
  | 'accepted'
  | 'accepted_with_warnings'
  | 'rejected_for_validation';

export interface DatasetQualityThresholds {
  minObservationCount: number;
  minReplayFrameCount: number;
  minDistinctMarkets: number;
  minDistinctTimeBuckets: number;
  minDistinctRegimes: number;
  minDistinctLiquidityBuckets: number;
  maxDuplicateObservationRate: number;
  maxDuplicateReplayRate: number;
  maxMissingCriticalFieldRate: number;
  maxStaleFeatureRate: number;
}

export interface DatasetQualityDistributionEntry {
  key: string;
  count: number;
  share: number;
}

export interface DatasetQualityCoverage {
  regimes: DatasetQualityDistributionEntry[];
  timeBuckets: DatasetQualityDistributionEntry[];
  sourceKinds: DatasetQualityDistributionEntry[];
  liquidityBuckets: DatasetQualityDistributionEntry[];
  marketStructureBuckets: DatasetQualityDistributionEntry[];
}

export interface DatasetQualityReport {
  generatedAt: string;
  datasetPath: string;
  datasetType: HistoricalValidationDataset['datasetType'];
  datasetVersion: string;
  capturedAt: string;
  timeRange: {
    startAt: string | null;
    endAt: string | null;
    coveredHours: number;
  };
  provenance: {
    sources: Record<string, string>;
    sourceCount: number;
    collectionMethod: string[];
  };
  counts: {
    observations: number;
    replayFrames: number;
    executableCases: number;
    distinctMarkets: number;
  };
  quality: {
    missingCriticalFieldRate: number;
    duplicateObservationRate: number;
    duplicateReplayRate: number;
    staleFeatureRate: number;
  };
  coverage: DatasetQualityCoverage;
  biasRiskFlags: string[];
  blockingReasons: string[];
  warnings: string[];
  verdict: DatasetQualityVerdict;
  thresholds: DatasetQualityThresholds;
  reportPath: string;
}

const DEFAULT_THRESHOLDS: DatasetQualityThresholds = {
  minObservationCount: 24,
  minReplayFrameCount: 24,
  minDistinctMarkets: 12,
  minDistinctTimeBuckets: 3,
  minDistinctRegimes: 2,
  minDistinctLiquidityBuckets: 2,
  maxDuplicateObservationRate: 0.05,
  maxDuplicateReplayRate: 0.1,
  maxMissingCriticalFieldRate: 0.05,
  maxStaleFeatureRate: 0.15,
};

function uniqueCount(values: string[]): number {
  return new Set(values.filter((value) => value.length > 0)).size;
}

function rate(numerator: number, denominator: number): number {
  if (!Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }

  return numerator / denominator;
}

function toDistribution(values: string[]): DatasetQualityDistributionEntry[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = value.trim();
    if (!key) {
      continue;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const total = values.filter((value) => value.trim().length > 0).length;
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, count]) => ({
      key,
      count,
      share: rate(count, total),
    }));
}

function hasMissingCriticalObservationFields(
  dataset: HistoricalValidationDataset,
  index: number,
): boolean {
  const observation = dataset.observations[index];
  const replay = dataset.replayFrames[index % Math.max(dataset.replayFrames.length, 1)];

  if (!observation || !replay) {
    return true;
  }

  const lastCandle = observation.candleWindow[observation.candleWindow.length - 1];
  return [
    observation.observationId,
    observation.slug,
    observation.conditionId,
    observation.observedAt,
    observation.marketEndAt,
    observation.upTokenId,
    observation.timeBucket,
    observation.sourceKind,
    replay.replayKey,
    replay.tokenId,
    lastCandle?.timestamp ?? '',
  ].some((value) => String(value ?? '').trim().length === 0);
}

function isStaleObservationFeature(observation: HistoricalValidationDataset['observations'][number]): boolean {
  if (observation.candleWindow.length === 0) {
    return true;
  }

  const lastCandle = new Date(
    observation.candleWindow[observation.candleWindow.length - 1]?.timestamp ?? '',
  ).getTime();
  const observedAt = new Date(observation.observedAt).getTime();
  if (!Number.isFinite(lastCandle) || !Number.isFinite(observedAt)) {
    return true;
  }

  return Math.abs(observedAt - lastCandle) > 10 * 60 * 1000;
}

function computeBiasRiskFlags(input: {
  duplicateObservationRate: number;
  duplicateReplayRate: number;
  missingCriticalFieldRate: number;
  staleFeatureRate: number;
  timeBuckets: DatasetQualityDistributionEntry[];
  regimes: DatasetQualityDistributionEntry[];
  liquidityBuckets: DatasetQualityDistributionEntry[];
  distinctMarkets: number;
  sourceCount: number;
}): string[] {
  const flags: string[] = [];

  if (input.duplicateObservationRate > 0.02 || input.duplicateReplayRate > 0.05) {
    flags.push('duplicate_record_pressure');
  }
  if (input.missingCriticalFieldRate > 0) {
    flags.push('missing_critical_fields_present');
  }
  if (input.staleFeatureRate > 0) {
    flags.push('stale_feature_rows_present');
  }
  if ((input.timeBuckets[0]?.share ?? 0) > 0.65) {
    flags.push('time_of_day_concentration');
  }
  if ((input.regimes[0]?.share ?? 0) > 0.75) {
    flags.push('regime_concentration');
  }
  if ((input.liquidityBuckets[0]?.share ?? 0) > 0.8) {
    flags.push('liquidity_concentration');
  }
  if (input.distinctMarkets < 24) {
    flags.push('market_diversity_thin');
  }
  if (input.sourceCount < 3) {
    flags.push('source_provenance_thin');
  }

  return flags;
}

function determineVerdict(input: {
  thresholds: DatasetQualityThresholds;
  observations: number;
  replayFrames: number;
  distinctMarkets: number;
  distinctTimeBuckets: number;
  distinctRegimes: number;
  distinctLiquidityBuckets: number;
  duplicateObservationRate: number;
  duplicateReplayRate: number;
  missingCriticalFieldRate: number;
  staleFeatureRate: number;
  biasRiskFlags: string[];
}): {
  verdict: DatasetQualityVerdict;
  blockingReasons: string[];
  warnings: string[];
} {
  const blockingReasons: string[] = [];
  if (input.observations < input.thresholds.minObservationCount) {
    blockingReasons.push('observation_count_below_threshold');
  }
  if (input.replayFrames < input.thresholds.minReplayFrameCount) {
    blockingReasons.push('replay_frame_count_below_threshold');
  }
  if (input.distinctMarkets < input.thresholds.minDistinctMarkets) {
    blockingReasons.push('market_diversity_below_threshold');
  }
  if (input.distinctTimeBuckets < input.thresholds.minDistinctTimeBuckets) {
    blockingReasons.push('time_bucket_coverage_below_threshold');
  }
  if (input.distinctRegimes < input.thresholds.minDistinctRegimes) {
    blockingReasons.push('regime_coverage_below_threshold');
  }
  if (input.distinctLiquidityBuckets < input.thresholds.minDistinctLiquidityBuckets) {
    blockingReasons.push('liquidity_coverage_below_threshold');
  }
  if (input.duplicateObservationRate > input.thresholds.maxDuplicateObservationRate) {
    blockingReasons.push('duplicate_observation_rate_above_threshold');
  }
  if (input.duplicateReplayRate > input.thresholds.maxDuplicateReplayRate) {
    blockingReasons.push('duplicate_replay_rate_above_threshold');
  }
  if (input.missingCriticalFieldRate > input.thresholds.maxMissingCriticalFieldRate) {
    blockingReasons.push('missing_critical_field_rate_above_threshold');
  }
  if (input.staleFeatureRate > input.thresholds.maxStaleFeatureRate) {
    blockingReasons.push('stale_feature_rate_above_threshold');
  }

  const warnings = input.biasRiskFlags.filter(
    (flag) =>
      !blockingReasons.includes('duplicate_observation_rate_above_threshold') ||
      flag !== 'duplicate_record_pressure',
  );

  if (blockingReasons.length > 0) {
    return {
      verdict: 'rejected_for_validation',
      blockingReasons,
      warnings,
    };
  }

  if (warnings.length > 0) {
    return {
      verdict: 'accepted_with_warnings',
      blockingReasons,
      warnings,
    };
  }

  return {
    verdict: 'accepted',
    blockingReasons,
    warnings,
  };
}

export function buildDatasetQualityReport(input: {
  dataset: HistoricalValidationDataset;
  datasetPath: string;
  executableCases: HistoricalExecutableCase[];
  reportPath: string;
  now?: Date;
  thresholds?: Partial<DatasetQualityThresholds>;
}): DatasetQualityReport {
  const thresholds: DatasetQualityThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...input.thresholds,
  };
  const observedTimes = input.dataset.observations
    .map((observation) => new Date(observation.observedAt).getTime())
    .filter((timestamp) => Number.isFinite(timestamp));
  const timeRangeStart = observedTimes.length > 0 ? new Date(Math.min(...observedTimes)) : null;
  const timeRangeEnd = observedTimes.length > 0 ? new Date(Math.max(...observedTimes)) : null;
  const coveredHours =
    timeRangeStart && timeRangeEnd
      ? Math.max(0, (timeRangeEnd.getTime() - timeRangeStart.getTime()) / (60 * 60 * 1000))
      : 0;

  const duplicateObservationRate = rate(
    input.dataset.observations.length -
      uniqueCount(input.dataset.observations.map((observation) => observation.observationId)),
    input.dataset.observations.length,
  );
  const duplicateReplayRate = rate(
    input.dataset.replayFrames.length -
      uniqueCount(input.dataset.replayFrames.map((frame) => frame.replayKey)),
    input.dataset.replayFrames.length,
  );
  const missingCriticalFieldRate = rate(
    input.dataset.observations.filter((_, index) =>
      hasMissingCriticalObservationFields(input.dataset, index),
    ).length,
    input.dataset.observations.length,
  );
  const staleFeatureRate = rate(
    input.dataset.observations.filter((observation) =>
      isStaleObservationFeature(observation),
    ).length,
    input.dataset.observations.length,
  );

  const regimes = toDistribution(
    input.executableCases.map((entry) => entry.regime),
  );
  const timeBuckets = toDistribution(
    input.dataset.observations.map((observation) => observation.timeBucket),
  );
  const sourceKinds = toDistribution(
    input.dataset.observations.map((observation) => observation.sourceKind),
  );
  const liquidityBuckets = toDistribution(
    input.executableCases.map((entry) => entry.liquidityBucket),
  );
  const marketStructureBuckets = toDistribution(
    input.executableCases.map((entry) => entry.marketStructureBucket),
  );
  const distinctMarkets = uniqueCount(
    input.dataset.observations.map((observation) => observation.slug),
  );
  const biasRiskFlags = computeBiasRiskFlags({
    duplicateObservationRate,
    duplicateReplayRate,
    missingCriticalFieldRate,
    staleFeatureRate,
    timeBuckets,
    regimes,
    liquidityBuckets,
    distinctMarkets,
    sourceCount: Object.keys(input.dataset.provenance ?? {}).length,
  });
  const verdict = determineVerdict({
    thresholds,
    observations: input.dataset.observations.length,
    replayFrames: input.dataset.replayFrames.length,
    distinctMarkets,
    distinctTimeBuckets: timeBuckets.length,
    distinctRegimes: regimes.length,
    distinctLiquidityBuckets: liquidityBuckets.length,
    duplicateObservationRate,
    duplicateReplayRate,
    missingCriticalFieldRate,
    staleFeatureRate,
    biasRiskFlags,
  });

  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    datasetPath: input.datasetPath,
    datasetType: input.dataset.datasetType,
    datasetVersion: input.dataset.datasetVersion,
    capturedAt: input.dataset.capturedAt,
    timeRange: {
      startAt: timeRangeStart?.toISOString() ?? null,
      endAt: timeRangeEnd?.toISOString() ?? null,
      coveredHours,
    },
    provenance: {
      sources: input.dataset.provenance,
      sourceCount: Object.keys(input.dataset.provenance ?? {}).length,
      collectionMethod: Object.keys(input.dataset.provenance ?? {}),
    },
    counts: {
      observations: input.dataset.observations.length,
      replayFrames: input.dataset.replayFrames.length,
      executableCases: input.executableCases.length,
      distinctMarkets,
    },
    quality: {
      missingCriticalFieldRate,
      duplicateObservationRate,
      duplicateReplayRate,
      staleFeatureRate,
    },
    coverage: {
      regimes,
      timeBuckets,
      sourceKinds,
      liquidityBuckets,
      marketStructureBuckets,
    },
    biasRiskFlags,
    blockingReasons: verdict.blockingReasons,
    warnings: verdict.warnings,
    verdict: verdict.verdict,
    thresholds,
    reportPath: input.reportPath,
  };
}

export function persistDatasetQualityReport(
  reportPath: string,
  report: Omit<DatasetQualityReport, 'reportPath'>,
): DatasetQualityReport {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const finalReport: DatasetQualityReport = {
    ...report,
    reportPath,
  };
  fs.writeFileSync(reportPath, JSON.stringify(finalReport, null, 2));
  return finalReport;
}
