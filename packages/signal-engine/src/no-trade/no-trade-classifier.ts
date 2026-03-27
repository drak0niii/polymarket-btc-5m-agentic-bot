import type { RegimeLabel } from '../regime-classifier';

export type NoTradeReasonCode =
  | 'spread_too_wide'
  | 'orderbook_stale'
  | 'low_depth'
  | 'high_toxicity'
  | 'venue_uncertainty_elevated'
  | 'regime_unstable'
  | 'edge_too_marginal_after_costs'
  | 'event_window_too_noisy';

export interface NoTradeClassifierConditions {
  spread: number | null;
  spreadLimit: number | null;
  orderbookFresh: boolean;
  orderbookAgeMs: number | null;
  topLevelDepth: number | null;
  minimumTopLevelDepth: number | null;
  toxicityScore: number | null;
  toxicityState: string | null;
  venueUncertaintyLabel: string | null;
  regimeLabel: RegimeLabel | string | null;
  regimeConfidence: number | null;
  regimeTransitionRisk: number | null;
  expectedNetEdgeBps: number | null;
  minimumNetEdgeBps: number | null;
  empiricalBlockRate: number | null;
  empiricalSampleCount: number | null;
  timeToExpirySeconds: number | null;
  noTradeWindowSeconds: number | null;
}

export interface NoTradeClassifierInput {
  spread: number | null;
  spreadLimit?: number | null;
  orderbookFresh: boolean;
  orderbookAgeMs?: number | null;
  topLevelDepth: number | null;
  minimumTopLevelDepth?: number | null;
  toxicityScore?: number | null;
  toxicityState?: string | null;
  venueUncertaintyLabel?: string | null;
  regimeLabel?: RegimeLabel | string | null;
  regimeConfidence?: number | null;
  regimeTransitionRisk?: number | null;
  expectedNetEdgeBps?: number | null;
  minimumNetEdgeBps?: number | null;
  timeToExpirySeconds?: number | null;
  noTradeWindowSeconds?: number | null;
  empiricalEvidence?: {
    blockRate?: number | null;
    sampleCount?: number | null;
    dominantReasonCodes?: NoTradeReasonCode[];
  } | null;
}

export interface NoTradeClassifierOutput {
  allowTrade: boolean;
  reasonCodes: NoTradeReasonCode[];
  confidence: number;
  conditions: NoTradeClassifierConditions;
}

const DEFAULT_SPREAD_LIMIT = 0.05;
const DEFAULT_MIN_TOP_LEVEL_DEPTH = 20;

export class NoTradeClassifier {
  classify(input: NoTradeClassifierInput): NoTradeClassifierOutput {
    const spreadLimit = finiteOrNull(input.spreadLimit) ?? DEFAULT_SPREAD_LIMIT;
    const minimumTopLevelDepth =
      finiteOrNull(input.minimumTopLevelDepth) ?? DEFAULT_MIN_TOP_LEVEL_DEPTH;
    const expectedNetEdgeBps = finiteOrNull(input.expectedNetEdgeBps);
    const minimumNetEdgeBps = finiteOrNull(input.minimumNetEdgeBps) ?? 0;
    const toxicityScore = finiteOrNull(input.toxicityScore);
    const regimeConfidence = finiteOrNull(input.regimeConfidence);
    const regimeTransitionRisk = finiteOrNull(input.regimeTransitionRisk);
    const blockRate = finiteOrNull(input.empiricalEvidence?.blockRate);
    const sampleCount = finiteOrNull(input.empiricalEvidence?.sampleCount);
    const dominantReasonCodes = [...new Set(input.empiricalEvidence?.dominantReasonCodes ?? [])];
    const reasonCodes: NoTradeReasonCode[] = [];

    if (
      finiteOrNull(input.spread) != null &&
      input.spread != null &&
      input.spread > spreadLimit
    ) {
      reasonCodes.push('spread_too_wide');
    }

    if (!input.orderbookFresh) {
      reasonCodes.push('orderbook_stale');
    }

    if (
      finiteOrNull(input.topLevelDepth) != null &&
      input.topLevelDepth != null &&
      input.topLevelDepth < minimumTopLevelDepth
    ) {
      reasonCodes.push('low_depth');
    }

    if (
      toxicityScore != null &&
      (toxicityScore >= 0.72 ||
        input.toxicityState === 'unsafe' ||
        input.toxicityState === 'blocked')
    ) {
      reasonCodes.push('high_toxicity');
    }

    if (
      input.venueUncertaintyLabel === 'unsafe' ||
      (input.venueUncertaintyLabel === 'degraded' &&
        ((expectedNetEdgeBps != null && expectedNetEdgeBps <= minimumNetEdgeBps * 1.35) ||
          (blockRate != null && blockRate >= 0.55)))
    ) {
      reasonCodes.push('venue_uncertainty_elevated');
    }

    if (
      (regimeConfidence != null && regimeConfidence < 0.58) ||
      (regimeTransitionRisk != null && regimeTransitionRisk >= 0.62) ||
      (sampleCount != null &&
        sampleCount >= 6 &&
        blockRate != null &&
        blockRate >= 0.6 &&
        dominantReasonCodes.includes('regime_unstable'))
    ) {
      reasonCodes.push('regime_unstable');
    }

    if (
      expectedNetEdgeBps != null &&
      expectedNetEdgeBps <=
        Math.max(minimumNetEdgeBps, minimumNetEdgeBps * 1.15 + empiricalMarginTightener(blockRate, sampleCount))
    ) {
      reasonCodes.push('edge_too_marginal_after_costs');
    }

    if (
      (input.timeToExpirySeconds != null &&
        input.noTradeWindowSeconds != null &&
        input.timeToExpirySeconds <= input.noTradeWindowSeconds + 5) ||
      (sampleCount != null &&
        sampleCount >= 6 &&
        blockRate != null &&
        blockRate >= 0.55 &&
        dominantReasonCodes.includes('event_window_too_noisy'))
    ) {
      reasonCodes.push('event_window_too_noisy');
    }

    const uniqueReasonCodes = [...new Set(reasonCodes)];
    const allowTrade = uniqueReasonCodes.length === 0;
    return {
      allowTrade,
      reasonCodes: uniqueReasonCodes,
      confidence: buildDecisionConfidence({
        allowTrade,
        spread: finiteOrNull(input.spread),
        spreadLimit,
        topLevelDepth: finiteOrNull(input.topLevelDepth),
        minimumTopLevelDepth,
        toxicityScore,
        regimeConfidence,
        regimeTransitionRisk,
        blockRate,
        sampleCount,
      }),
      conditions: {
        spread: finiteOrNull(input.spread),
        spreadLimit,
        orderbookFresh: input.orderbookFresh,
        orderbookAgeMs: finiteOrNull(input.orderbookAgeMs),
        topLevelDepth: finiteOrNull(input.topLevelDepth),
        minimumTopLevelDepth,
        toxicityScore,
        toxicityState: input.toxicityState ?? null,
        venueUncertaintyLabel: input.venueUncertaintyLabel ?? null,
        regimeLabel: input.regimeLabel ?? null,
        regimeConfidence,
        regimeTransitionRisk,
        expectedNetEdgeBps,
        minimumNetEdgeBps,
        empiricalBlockRate: blockRate,
        empiricalSampleCount: sampleCount,
        timeToExpirySeconds: finiteOrNull(input.timeToExpirySeconds),
        noTradeWindowSeconds: finiteOrNull(input.noTradeWindowSeconds),
      },
    };
  }
}

function buildDecisionConfidence(input: {
  allowTrade: boolean;
  spread: number | null;
  spreadLimit: number;
  topLevelDepth: number | null;
  minimumTopLevelDepth: number;
  toxicityScore: number | null;
  regimeConfidence: number | null;
  regimeTransitionRisk: number | null;
  blockRate: number | null;
  sampleCount: number | null;
}): number {
  const spreadConfidence =
    input.spread == null ? 0.55 : clamp01(1 - Math.max(0, input.spread - input.spreadLimit));
  const depthConfidence =
    input.topLevelDepth == null
      ? 0.5
      : clamp01(input.topLevelDepth / Math.max(1, input.minimumTopLevelDepth));
  const toxicityConfidence =
    input.toxicityScore == null ? 0.55 : clamp01(1 - input.toxicityScore);
  const regimeConfidence = clamp01(input.regimeConfidence ?? 0.55);
  const transitionConfidence = clamp01(1 - (input.regimeTransitionRisk ?? 0.45));
  const empiricalConfidence =
    input.sampleCount != null && input.sampleCount > 0
      ? clamp01((input.sampleCount / 12) * (0.55 + (input.blockRate ?? 0.5) * 0.45))
      : 0.45;

  const base = average([
    spreadConfidence,
    depthConfidence,
    toxicityConfidence,
    regimeConfidence,
    transitionConfidence,
    empiricalConfidence,
  ]);
  return input.allowTrade ? clamp01(base) : clamp01(0.55 + base * 0.45);
}

function empiricalMarginTightener(
  blockRate: number | null,
  sampleCount: number | null,
): number {
  if (blockRate == null || sampleCount == null || sampleCount < 6) {
    return 0;
  }
  return Math.max(0, Math.min(18, blockRate * Math.min(sampleCount, 24))) * 0.01;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}
