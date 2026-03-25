export type RetentionContextType = 'regime' | 'archetype' | 'toxicity_state';

export interface RetentionContextObservation {
  regime?: string | null;
  archetype?: string | null;
  toxicityState?: string | null;
  expectedNetEdge: number | null;
  realizedNetEdge: number | null;
}

export interface RetentionContextBucket {
  contextType: RetentionContextType;
  contextValue: string;
  sampleCount: number;
  expectedNetEdge: number;
  realizedNetEdge: number;
  retentionRatio: number | null;
  realizedVsExpectedGap: number;
}

export interface RetentionContextRankedEntry extends RetentionContextBucket {
  rankScore: number;
}

export interface RetentionContextReport {
  generatedAt: string;
  sampleCount: number;
  retentionByRegime: RetentionContextBucket[];
  retentionByArchetype: RetentionContextBucket[];
  retentionByToxicityState: RetentionContextBucket[];
  topDegradingContexts: RetentionContextRankedEntry[];
  topImprovingContexts: RetentionContextRankedEntry[];
}

export function buildRetentionContextReport(input: {
  observations: RetentionContextObservation[];
  now?: Date;
}): RetentionContextReport {
  const generatedAt = (input.now ?? new Date()).toISOString();
  const normalized = input.observations
    .map(normalizeObservation)
    .filter((entry): entry is NormalizedObservation => entry != null);
  const buckets = [
    ...buildBuckets(normalized, 'regime'),
    ...buildBuckets(normalized, 'archetype'),
    ...buildBuckets(normalized, 'toxicity_state'),
  ];

  return {
    generatedAt,
    sampleCount: normalized.length,
    retentionByRegime: buildBuckets(normalized, 'regime'),
    retentionByArchetype: buildBuckets(normalized, 'archetype'),
    retentionByToxicityState: buildBuckets(normalized, 'toxicity_state'),
    topDegradingContexts: [...buckets]
      .sort(compareDegradingContexts)
      .slice(0, 5)
      .map(withRankScore),
    topImprovingContexts: [...buckets]
      .sort(compareImprovingContexts)
      .slice(0, 5)
      .map(withRankScore),
  };
}

interface NormalizedObservation {
  regime: string;
  archetype: string;
  toxicityState: string;
  expectedNetEdge: number;
  realizedNetEdge: number;
}

function normalizeObservation(
  observation: RetentionContextObservation,
): NormalizedObservation | null {
  const expectedNetEdge = normalizeNumber(observation.expectedNetEdge);
  const realizedNetEdge = normalizeNumber(observation.realizedNetEdge);
  if (expectedNetEdge == null || realizedNetEdge == null) {
    return null;
  }

  return {
    regime: normalizeLabel(observation.regime),
    archetype: normalizeLabel(observation.archetype),
    toxicityState: normalizeLabel(observation.toxicityState),
    expectedNetEdge,
    realizedNetEdge,
  };
}

function buildBuckets(
  observations: NormalizedObservation[],
  contextType: RetentionContextType,
): RetentionContextBucket[] {
  const grouped = new Map<string, NormalizedObservation[]>();
  for (const observation of observations) {
    const key =
      contextType === 'regime'
        ? observation.regime
        : contextType === 'archetype'
          ? observation.archetype
          : observation.toxicityState;
    const bucket = grouped.get(key) ?? [];
    bucket.push(observation);
    grouped.set(key, bucket);
  }

  return Array.from(grouped.entries())
    .map(([contextValue, entries]) => {
      const expectedNetEdge = sum(entries.map((entry) => entry.expectedNetEdge));
      const realizedNetEdge = sum(entries.map((entry) => entry.realizedNetEdge));
      return {
        contextType,
        contextValue,
        sampleCount: entries.length,
        expectedNetEdge,
        realizedNetEdge,
        retentionRatio: calculateRetentionRatio(expectedNetEdge, realizedNetEdge),
        realizedVsExpectedGap: realizedNetEdge - expectedNetEdge,
      };
    })
    .sort((left, right) => left.contextValue.localeCompare(right.contextValue));
}

function compareDegradingContexts(
  left: RetentionContextBucket,
  right: RetentionContextBucket,
): number {
  return rankingScore(left) - rankingScore(right);
}

function compareImprovingContexts(
  left: RetentionContextBucket,
  right: RetentionContextBucket,
): number {
  return rankingScore(right) - rankingScore(left);
}

function withRankScore(bucket: RetentionContextBucket): RetentionContextRankedEntry {
  return {
    ...bucket,
    rankScore: rankingScore(bucket),
  };
}

function rankingScore(bucket: RetentionContextBucket): number {
  const retentionRatio = bucket.retentionRatio ?? -1;
  const sampleWeight = Math.min(1, bucket.sampleCount / 5);
  const gapWeight = bucket.realizedVsExpectedGap * 10;
  return retentionRatio * 0.65 + gapWeight * 0.25 + sampleWeight * 0.1;
}

function calculateRetentionRatio(
  expectedNetEdge: number,
  realizedNetEdge: number,
): number | null {
  if (!Number.isFinite(expectedNetEdge) || !Number.isFinite(realizedNetEdge)) {
    return null;
  }
  if (Math.abs(expectedNetEdge) <= 1e-9) {
    return Math.abs(realizedNetEdge) <= 1e-9 ? 1 : null;
  }
  return realizedNetEdge / expectedNetEdge;
}

function normalizeLabel(value: string | null | undefined): string {
  if (typeof value !== 'string') {
    return 'unknown';
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : 'unknown';
}

function normalizeNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
