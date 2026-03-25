import type { HealthLabel } from '@polymarket-btc-5m-agentic-bot/domain';

export interface RegimeLocalSizingContextEntry {
  contextType: 'regime' | 'archetype';
  contextValue: string;
  sampleCount: number;
  retentionRatio: number | null;
  realizedVsExpectedGap: number | null;
  rankScore: number | null;
}

export interface RegimeLocalSizingInput {
  regime: string | null;
  archetype: string | null;
  regimeSnapshotHealth: HealthLabel | null;
  regimeSnapshotSampleCount: number | null;
  regimeSnapshotRealizedVsExpected: number | null;
  retentionByRegime: RegimeLocalSizingContextEntry[];
  retentionByArchetype: RegimeLocalSizingContextEntry[];
}

export interface RegimeLocalSizingDecision {
  regimeSizeMultiplier: number;
  archetypeSizeMultiplier: number;
  combinedSizeMultiplier: number;
  regimeSizingReasonCodes: string[];
  evidence: Record<string, unknown>;
  capturedAt: string;
}

export interface RegimeLocalSizingSummaryEntry {
  contextType: 'regime' | 'archetype';
  contextValue: string;
  sampleCount: number;
  retentionRatio: number | null;
  realizedVsExpectedGap: number | null;
  recommendedSizeMultiplier: number;
  reasonCodes: string[];
}

export interface RegimeLocalSizingSummary {
  generatedAt: string;
  sampleCount: number;
  byRegime: RegimeLocalSizingSummaryEntry[];
  byArchetype: RegimeLocalSizingSummaryEntry[];
  mostConstrainedContexts: RegimeLocalSizingSummaryEntry[];
}

export class RegimeLocalSizing {
  evaluate(input: RegimeLocalSizingInput): RegimeLocalSizingDecision {
    const regimeEntry = findEntry(input.retentionByRegime, input.regime);
    const archetypeEntry = findEntry(input.retentionByArchetype, input.archetype);
    const reasonCodes: string[] = [];

    let regimeSizeMultiplier = 1;
    let archetypeSizeMultiplier = 1;

    if (input.regimeSnapshotHealth === 'watch') {
      regimeSizeMultiplier *= 0.96;
      reasonCodes.push('regime_snapshot_watch');
    }
    if (input.regimeSnapshotHealth === 'degraded') {
      regimeSizeMultiplier *= 0.82;
      reasonCodes.push('regime_snapshot_degraded');
    }
    if (input.regimeSnapshotHealth === 'quarantine_candidate') {
      regimeSizeMultiplier *= 0.6;
      reasonCodes.push('regime_snapshot_quarantine_candidate');
    }
    if (
      input.regimeSnapshotRealizedVsExpected != null &&
      input.regimeSnapshotRealizedVsExpected < 0.85
    ) {
      regimeSizeMultiplier *= 0.92;
      reasonCodes.push('regime_snapshot_retention_soft');
    }
    if (
      input.regimeSnapshotRealizedVsExpected != null &&
      input.regimeSnapshotRealizedVsExpected < 0.7
    ) {
      regimeSizeMultiplier *= 0.78;
      reasonCodes.push('regime_snapshot_retention_hard');
    }
    if (
      input.regimeSnapshotSampleCount != null &&
      input.regimeSnapshotSampleCount > 0 &&
      input.regimeSnapshotSampleCount < 6
    ) {
      regimeSizeMultiplier *= 0.96;
      reasonCodes.push('regime_snapshot_sample_thin');
    }

    const regimeDecision = applyContextEntry({
      entry: regimeEntry,
      prefix: 'regime_local',
      sampleSoftMultiplier: 0.97,
      sampleHardMultiplier: 0.92,
      retentionSoftMultiplier: 0.9,
      retentionHardMultiplier: 0.75,
      retentionCriticalMultiplier: 0.58,
      gapSoftMultiplier: 0.94,
      gapHardMultiplier: 0.8,
      rankNegativeMultiplier: 0.94,
      rankWeakMultiplier: 0.86,
    });
    regimeSizeMultiplier *= regimeDecision.multiplier;
    reasonCodes.push(...regimeDecision.reasonCodes);

    const archetypeDecision = applyContextEntry({
      entry: archetypeEntry,
      prefix: 'archetype_local',
      sampleSoftMultiplier: 0.98,
      sampleHardMultiplier: 0.94,
      retentionSoftMultiplier: 0.93,
      retentionHardMultiplier: 0.82,
      retentionCriticalMultiplier: 0.68,
      gapSoftMultiplier: 0.96,
      gapHardMultiplier: 0.84,
      rankNegativeMultiplier: 0.96,
      rankWeakMultiplier: 0.9,
    });
    archetypeSizeMultiplier *= archetypeDecision.multiplier;
    reasonCodes.push(...archetypeDecision.reasonCodes);

    regimeSizeMultiplier = clamp(regimeSizeMultiplier, 0.35, 1);
    archetypeSizeMultiplier = clamp(archetypeSizeMultiplier, 0.4, 1);
    const combinedSizeMultiplier = clamp(
      regimeSizeMultiplier * archetypeSizeMultiplier,
      0.2,
      1,
    );

    return {
      regimeSizeMultiplier,
      archetypeSizeMultiplier,
      combinedSizeMultiplier,
      regimeSizingReasonCodes: Array.from(new Set(reasonCodes)),
      evidence: {
        regime: input.regime,
        archetype: input.archetype,
        regimeSnapshotHealth: input.regimeSnapshotHealth,
        regimeSnapshotSampleCount: input.regimeSnapshotSampleCount,
        regimeSnapshotRealizedVsExpected: input.regimeSnapshotRealizedVsExpected,
        regimeEntry,
        archetypeEntry,
      },
      capturedAt: new Date().toISOString(),
    };
  }
}

export function buildRegimeLocalSizingSummary(input: {
  now: Date;
  retentionByRegime: RegimeLocalSizingContextEntry[];
  retentionByArchetype: RegimeLocalSizingContextEntry[];
}): RegimeLocalSizingSummary {
  const model = new RegimeLocalSizing();
  const byRegime = input.retentionByRegime
    .map((entry) => {
      const decision = model.evaluate({
        regime: entry.contextValue,
        archetype: null,
        regimeSnapshotHealth: null,
        regimeSnapshotSampleCount: entry.sampleCount,
        regimeSnapshotRealizedVsExpected:
          entry.retentionRatio != null ? entry.retentionRatio : null,
        retentionByRegime: [entry],
        retentionByArchetype: [],
      });
      return {
        contextType: 'regime' as const,
        contextValue: entry.contextValue,
        sampleCount: entry.sampleCount,
        retentionRatio: entry.retentionRatio,
        realizedVsExpectedGap: entry.realizedVsExpectedGap,
        recommendedSizeMultiplier: decision.regimeSizeMultiplier,
        reasonCodes: decision.regimeSizingReasonCodes,
      };
    })
    .sort((left, right) => left.recommendedSizeMultiplier - right.recommendedSizeMultiplier)
    .slice(0, 12);
  const byArchetype = input.retentionByArchetype
    .map((entry) => {
      const decision = model.evaluate({
        regime: null,
        archetype: entry.contextValue,
        regimeSnapshotHealth: null,
        regimeSnapshotSampleCount: null,
        regimeSnapshotRealizedVsExpected: null,
        retentionByRegime: [],
        retentionByArchetype: [entry],
      });
      return {
        contextType: 'archetype' as const,
        contextValue: entry.contextValue,
        sampleCount: entry.sampleCount,
        retentionRatio: entry.retentionRatio,
        realizedVsExpectedGap: entry.realizedVsExpectedGap,
        recommendedSizeMultiplier: decision.archetypeSizeMultiplier,
        reasonCodes: decision.regimeSizingReasonCodes,
      };
    })
    .sort((left, right) => left.recommendedSizeMultiplier - right.recommendedSizeMultiplier)
    .slice(0, 12);

  return {
    generatedAt: input.now.toISOString(),
    sampleCount: input.retentionByRegime.length + input.retentionByArchetype.length,
    byRegime,
    byArchetype,
    mostConstrainedContexts: [...byRegime, ...byArchetype]
      .sort((left, right) => left.recommendedSizeMultiplier - right.recommendedSizeMultiplier)
      .slice(0, 8),
  };
}

function findEntry(
  entries: RegimeLocalSizingContextEntry[],
  contextValue: string | null,
): RegimeLocalSizingContextEntry | null {
  if (!contextValue) {
    return null;
  }
  return entries.find((entry) => entry.contextValue === contextValue) ?? null;
}

function applyContextEntry(input: {
  entry: RegimeLocalSizingContextEntry | null;
  prefix: string;
  sampleSoftMultiplier: number;
  sampleHardMultiplier: number;
  retentionSoftMultiplier: number;
  retentionHardMultiplier: number;
  retentionCriticalMultiplier: number;
  gapSoftMultiplier: number;
  gapHardMultiplier: number;
  rankNegativeMultiplier: number;
  rankWeakMultiplier: number;
}): { multiplier: number; reasonCodes: string[] } {
  if (!input.entry) {
    return { multiplier: 1, reasonCodes: [] };
  }

  let multiplier = 1;
  const reasonCodes: string[] = [];

  if (input.entry.sampleCount < 6) {
    multiplier *= input.sampleSoftMultiplier;
    reasonCodes.push(`${input.prefix}_sample_soft`);
  }
  if (input.entry.sampleCount < 3) {
    multiplier *= input.sampleHardMultiplier;
    reasonCodes.push(`${input.prefix}_sample_hard`);
  }
  if (input.entry.retentionRatio != null && input.entry.retentionRatio < 0.9) {
    multiplier *= input.retentionSoftMultiplier;
    reasonCodes.push(`${input.prefix}_retention_soft`);
  }
  if (input.entry.retentionRatio != null && input.entry.retentionRatio < 0.75) {
    multiplier *= input.retentionHardMultiplier;
    reasonCodes.push(`${input.prefix}_retention_hard`);
  }
  if (input.entry.retentionRatio != null && input.entry.retentionRatio < 0.55) {
    multiplier *= input.retentionCriticalMultiplier;
    reasonCodes.push(`${input.prefix}_retention_critical`);
  }
  if (
    input.entry.realizedVsExpectedGap != null &&
    input.entry.realizedVsExpectedGap < -0.01
  ) {
    multiplier *= input.gapSoftMultiplier;
    reasonCodes.push(`${input.prefix}_gap_soft`);
  }
  if (
    input.entry.realizedVsExpectedGap != null &&
    input.entry.realizedVsExpectedGap < -0.03
  ) {
    multiplier *= input.gapHardMultiplier;
    reasonCodes.push(`${input.prefix}_gap_hard`);
  }
  if (input.entry.rankScore != null && input.entry.rankScore < 0) {
    multiplier *= input.rankNegativeMultiplier;
    reasonCodes.push(`${input.prefix}_rank_negative`);
  }
  if (input.entry.rankScore != null && input.entry.rankScore < -0.03) {
    multiplier *= input.rankWeakMultiplier;
    reasonCodes.push(`${input.prefix}_rank_weak`);
  }

  return {
    multiplier,
    reasonCodes,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}
