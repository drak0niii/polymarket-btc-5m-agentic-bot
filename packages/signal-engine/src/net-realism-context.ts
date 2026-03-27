import type {
  LiquidityBucket,
  NetEdgeVenueUncertaintyLabel,
  SpreadBucket,
} from '@polymarket-btc-5m-agentic-bot/domain';

export type NetRealismUrgency = 'low' | 'normal' | 'high';

export interface NetRealismContext {
  spreadAtDecision: number | null;
  bookDepthAtIntendedPrice: number | null;
  expectedFillFraction: number | null;
  expectedQueueDelayMs: number | null;
  expectedPartialFillPenalty: number | null;
  expectedCancelReplacePenalty: number | null;
  venueUncertaintyLabel: NetEdgeVenueUncertaintyLabel | null;
  feeScheduleLabel: string | null;
  spreadBucket: SpreadBucket;
  liquidityBucket: LiquidityBucket;
  urgency: NetRealismUrgency;
  venueMode: string | null;
}

export function buildNetRealismContext(input: {
  spreadAtDecision: number | null;
  bookDepthAtIntendedPrice: number | null;
  expectedFillFraction: number | null;
  expectedQueueDelayMs: number | null;
  expectedPartialFillPenalty: number | null;
  expectedCancelReplacePenalty: number | null;
  venueUncertaintyLabel: NetEdgeVenueUncertaintyLabel | null;
  feeScheduleLabel: string | null;
  urgency?: NetRealismUrgency | null;
  venueMode?: string | null;
}): NetRealismContext {
  const spreadAtDecision = finiteOrNull(input.spreadAtDecision);
  const bookDepthAtIntendedPrice = finiteOrNull(input.bookDepthAtIntendedPrice);
  return {
    spreadAtDecision,
    bookDepthAtIntendedPrice,
    expectedFillFraction: clampFraction(input.expectedFillFraction),
    expectedQueueDelayMs: finiteOrNull(input.expectedQueueDelayMs),
    expectedPartialFillPenalty: nonNegativeOrNull(input.expectedPartialFillPenalty),
    expectedCancelReplacePenalty: nonNegativeOrNull(input.expectedCancelReplacePenalty),
    venueUncertaintyLabel: input.venueUncertaintyLabel ?? null,
    feeScheduleLabel: input.feeScheduleLabel ?? null,
    spreadBucket: classifySpreadBucket(spreadAtDecision),
    liquidityBucket: classifyLiquidityBucket(bookDepthAtIntendedPrice),
    urgency: input.urgency ?? classifyUrgency(input.expectedQueueDelayMs),
    venueMode: input.venueMode ?? null,
  };
}

export function classifySpreadBucket(spread: number | null | undefined): SpreadBucket {
  if (!Number.isFinite(spread ?? Number.NaN) || (spread ?? 0) <= 0) {
    return 'unknown';
  }
  if ((spread ?? 0) <= 0.01) {
    return 'tight';
  }
  if ((spread ?? 0) <= 0.025) {
    return 'normal';
  }
  if ((spread ?? 0) <= 0.05) {
    return 'wide';
  }
  return 'stressed';
}

export function classifyLiquidityBucket(
  bookDepthAtIntendedPrice: number | null | undefined,
): LiquidityBucket {
  if (
    !Number.isFinite(bookDepthAtIntendedPrice ?? Number.NaN) ||
    (bookDepthAtIntendedPrice ?? 0) <= 0
  ) {
    return 'unknown';
  }
  if ((bookDepthAtIntendedPrice ?? 0) < 20) {
    return 'thin';
  }
  if ((bookDepthAtIntendedPrice ?? 0) < 100) {
    return 'balanced';
  }
  return 'deep';
}

export function classifyUrgency(
  expectedQueueDelayMs: number | null | undefined,
): NetRealismUrgency {
  if (!Number.isFinite(expectedQueueDelayMs ?? Number.NaN)) {
    return 'normal';
  }
  if ((expectedQueueDelayMs ?? 0) >= 25_000) {
    return 'high';
  }
  if ((expectedQueueDelayMs ?? 0) <= 7_500) {
    return 'low';
  }
  return 'normal';
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeOrNull(value: number | null | undefined): number | null {
  if (!Number.isFinite(value ?? Number.NaN)) {
    return null;
  }
  return Math.max(0, value ?? 0);
}

function clampFraction(value: number | null | undefined): number | null {
  if (!Number.isFinite(value ?? Number.NaN)) {
    return null;
  }
  return Math.max(0, Math.min(1, value ?? 0));
}
