import {
  ExecutionRoute,
  ExecutionSemanticsPolicy,
  OrderUrgency,
  OrderType,
  PartialFillTolerance,
} from './execution-semantics-policy';
import type { NetEdgeVenueUncertaintyLabel } from '@polymarket-btc-5m-agentic-bot/domain';
import {
  FillProbabilityEstimator,
  type FillProbabilityEstimatorResult,
} from './fill-probability-estimator';
import {
  FillRealismStore,
  buildFillRealismBucket,
  type FillRealismBucketKey,
} from './fill-realism-store';
import {
  PostFillToxicityStore,
  type PostFillToxicitySummary,
} from './post-fill-toxicity-store';
import {
  QueuePositionEstimator,
  type QueuePositionEstimatorResult,
} from './queue-position-estimator';
import {
  SlippageEstimator,
  type SlippageEstimatorResult,
} from './slippage-estimator';

export type Outcome = 'YES' | 'NO';
export type TradeIntent = 'ENTER' | 'REDUCE' | 'EXIT' | 'FLIP';
export type VenueSide = 'BUY' | 'SELL';
export type InventoryEffect = 'INCREASE' | 'DECREASE' | 'NEUTRAL';

export interface ResolvedOrderIntent {
  /**
   * Specific Polymarket token that will be traded.
   */
  tokenId: string;

  /**
   * Strategy thesis / outcome the token represents.
   */
  outcome: Outcome;

  /**
   * Portfolio / trade semantics.
   */
  intent: TradeIntent;

  /**
   * Exchange-facing side only.
   * BUY = acquire inventory of tokenId
   * SELL = dispose of inventory of tokenId
   */
  venueSide: VenueSide;

  /**
   * Inventory meaning of the order.
   */
  inventoryEffect: InventoryEffect;
}

export interface VenueOrderConstraints {
  tickSize?: number | null;
  minOrderSize?: number | null;
  negRisk?: boolean | null;
}

export interface LiquiditySnapshot {
  /**
   * Quantity available at the best price level on the contra side.
   * BUY consumes ask liquidity.
   * SELL consumes bid liquidity.
   */
  topLevelDepth?: number | null;

  /**
   * Optional broader immediately-executable depth estimate.
   * When present, it is preferred over topLevelDepth for FOK/FAK decisions.
   */
  executableDepth?: number | null;

  recentMatchedVolume?: number | null;
  restingSizeAhead?: number | null;
  bestBid?: number | null;
  bestAsk?: number | null;
  spread?: number | null;
}

export interface OrderPlannerInput {
  resolvedIntent: ResolvedOrderIntent;
  price: number;
  size: number;
  urgency: OrderUrgency;
  expiryAt: string;
  noTradeWindowSeconds: number;
  now?: string | null;
  partialFillTolerance?: PartialFillTolerance | null;
  preferResting?: boolean | null;

  /**
   * Whether the order is intended to rest on the book or cross immediately.
   * rest = prefer GTC/GTD
   * cross = prefer FOK/FAK
   */
  executionStyle?: 'rest' | 'cross' | null;

  /**
   * Token-specific venue constraints cached from Polymarket.
   */
  venueConstraints?: VenueOrderConstraints | null;

  /**
   * Immediate liquidity context for choosing FOK vs FAK.
   */
  liquidity?: LiquiditySnapshot | null;
  regime?: string | null;
  venueUncertaintyLabel?: NetEdgeVenueUncertaintyLabel | null;
  feeRateBpsEstimate?: number | null;
}

export interface OrderPlannerStyleRationale {
  code: string;
  message: string;
}

export interface OrderPlannerResult {
  orderType: OrderType;

  /**
   * Echoed resolved execution semantics so downstream systems never need to
   * reconstruct intent from side alone.
   */
  tokenId: string;
  outcome: Outcome;
  intent: TradeIntent;
  inventoryEffect: InventoryEffect;

  /**
   * Venue-facing side for submission to Polymarket.
   */
  side: VenueSide;

  price: number;
  size: number;
  urgency: OrderUrgency;

  /**
   * Echoed planning inputs relevant for downstream adapter/validator logic.
   */
  expiration: string | null;
  executionStyle: 'rest' | 'cross';
  route: ExecutionRoute;
  timeDiscipline: 'open_ended' | 'deadline' | 'immediate';
  partialFillTolerance: PartialFillTolerance;
  policyReasonCode: string;
  policyReasonMessage: string;
  allowedOrderTypes: OrderType[];
  tickSize: number | null;
  minOrderSize: number | null;
  negRisk: boolean | null;
  expectedFillProbability: number;
  expectedFillFraction: number | null;
  expectedQueueDelayMs: number | null;
  expectedRealizedCostBps: number;
  expectedAdverseSelectionPenaltyBps: number;
  recommendedOrderStyleRationale: OrderPlannerStyleRationale[];
  executionBucketContext: FillRealismBucketKey;
  fillProbabilityEstimate: FillProbabilityEstimatorResult;
  queueEstimate: QueuePositionEstimatorResult;
  slippageEstimate: SlippageEstimatorResult;
  postFillToxicitySummary: PostFillToxicitySummary | null;

  createdAt: string;
}

export class OrderPlanner {
  private readonly executionSemanticsPolicy = new ExecutionSemanticsPolicy();
  private readonly fillRealismStore: FillRealismStore;
  private readonly fillProbabilityEstimator: FillProbabilityEstimator;
  private readonly queuePositionEstimator: QueuePositionEstimator;
  private readonly slippageEstimator: SlippageEstimator;
  private readonly postFillToxicityStore: PostFillToxicityStore;

  constructor(input?: {
    fillRealismStore?: FillRealismStore;
    postFillToxicityStore?: PostFillToxicityStore;
  }) {
    this.fillRealismStore = input?.fillRealismStore ?? new FillRealismStore();
    this.postFillToxicityStore =
      input?.postFillToxicityStore ?? new PostFillToxicityStore();
    this.fillProbabilityEstimator = new FillProbabilityEstimator(this.fillRealismStore);
    this.queuePositionEstimator = new QueuePositionEstimator(this.fillRealismStore);
    this.slippageEstimator = new SlippageEstimator(this.fillRealismStore);
  }

  plan(input: OrderPlannerInput): OrderPlannerResult {
    this.validate(input);

    const normalizedPrice = this.normalizePriceToTick(
      input.price,
      input.venueConstraints?.tickSize ?? null,
    );

    const executionSemantics = this.executionSemanticsPolicy.evaluate({
      action: input.resolvedIntent.intent as 'ENTER' | 'REDUCE' | 'EXIT',
      urgency: input.urgency,
      size: input.size,
      executableDepth: this.getExecutableDepth(input.liquidity ?? null),
      expiryAt: input.expiryAt,
      now: input.now ?? null,
      noTradeWindowSeconds: input.noTradeWindowSeconds,
      partialFillTolerance: input.partialFillTolerance ?? null,
      preferResting: input.preferResting ?? null,
      executionStyle: input.executionStyle ?? null,
    });
    const executionBucketContext = buildFillRealismBucket({
      spreadBucket: classifySpreadBucket(input.liquidity?.spread ?? null),
      liquidityBucket: classifyLiquidityBucket(this.getExecutableDepth(input.liquidity ?? null)),
      orderUrgency: input.urgency,
      regime: input.regime ?? null,
      executionStyle: executionSemantics.route === 'maker' ? 'maker' : 'taker',
      venueUncertaintyLabel: input.venueUncertaintyLabel ?? null,
    });
    const queueEstimate = this.queuePositionEstimator.estimate({
      restingSizeAhead: this.normalizePositive(input.liquidity?.restingSizeAhead ?? null) ?? 0,
      orderSize: input.size,
      recentMatchedVolume: this.normalizePositive(input.liquidity?.recentMatchedVolume ?? null) ?? 0,
      bucket: executionBucketContext,
    });
    const fillProbabilityEstimate = this.fillProbabilityEstimator.estimate({
      orderSize: input.size,
      topLevelDepth: this.normalizePositive(input.liquidity?.topLevelDepth ?? null) ?? 0,
      recentMatchedVolume: this.normalizePositive(input.liquidity?.recentMatchedVolume ?? null) ?? 0,
      queuePressureScore: queueEstimate.estimatedWaitScore,
      bucket: executionBucketContext,
    });
    const slippageEstimate = this.slippageEstimator.estimate({
      side: input.resolvedIntent.venueSide,
      bestBid: this.normalizePositive(input.liquidity?.bestBid ?? null),
      bestAsk: this.normalizePositive(input.liquidity?.bestAsk ?? null),
      targetSize: input.size,
      topLevelDepth: this.normalizePositive(input.liquidity?.topLevelDepth ?? null) ?? 0,
      bucket: executionBucketContext,
    });
    const postFillToxicitySummary = this.postFillToxicityStore.summarize({
      bucket: executionBucketContext,
      limit: 250,
    });
    const expectedAdverseSelectionPenaltyBps =
      postFillToxicitySummary.expectedAdverseSelectionPenaltyBps ?? 0;
    const feeRateBpsEstimate = this.normalizeNonNegative(input.feeRateBpsEstimate ?? null) ?? 20;
    const expectedRealizedCostBps =
      Math.max(0, feeRateBpsEstimate) +
      Math.max(0, slippageEstimate.finalExpectedSlippageBps) +
      Math.max(0, expectedAdverseSelectionPenaltyBps);
    const recommendedOrderStyleRationale = this.buildStyleRationale({
      executionSemantics,
      fillProbabilityEstimate,
      queueEstimate,
      slippageEstimate,
      expectedAdverseSelectionPenaltyBps,
    });

    return {
      orderType: executionSemantics.orderType,
      tokenId: input.resolvedIntent.tokenId,
      outcome: input.resolvedIntent.outcome,
      intent: input.resolvedIntent.intent,
      inventoryEffect: input.resolvedIntent.inventoryEffect,
      side: input.resolvedIntent.venueSide,
      price: normalizedPrice,
      size: input.size,
      urgency: input.urgency,
      expiration: executionSemantics.expiration,
      executionStyle: executionSemantics.executionStyle,
      route: executionSemantics.route,
      timeDiscipline: executionSemantics.timeDiscipline,
      partialFillTolerance: executionSemantics.partialFillTolerance,
      policyReasonCode: executionSemantics.reasonCode,
      policyReasonMessage: executionSemantics.reasonMessage,
      allowedOrderTypes: executionSemantics.allowedOrderTypes,
      tickSize: this.normalizePositive(input.venueConstraints?.tickSize ?? null),
      minOrderSize: this.normalizePositive(input.venueConstraints?.minOrderSize ?? null),
      negRisk:
        typeof input.venueConstraints?.negRisk === 'boolean'
          ? input.venueConstraints.negRisk
          : null,
      expectedFillProbability: fillProbabilityEstimate.fillProbability,
      expectedFillFraction: fillProbabilityEstimate.expectedFillFraction,
      expectedQueueDelayMs: queueEstimate.centralEstimateMs,
      expectedRealizedCostBps,
      expectedAdverseSelectionPenaltyBps,
      recommendedOrderStyleRationale,
      executionBucketContext,
      fillProbabilityEstimate,
      queueEstimate,
      slippageEstimate,
      postFillToxicitySummary,
      createdAt: new Date().toISOString(),
    };
  }

  private getExecutableDepth(liquidity: LiquiditySnapshot | null): number | null {
    if (!liquidity) {
      return null;
    }

    const executableDepth = this.normalizePositive(liquidity.executableDepth ?? null);
    if (executableDepth !== null) {
      return executableDepth;
    }

    return this.normalizePositive(liquidity.topLevelDepth ?? null);
  }

  private validate(input: OrderPlannerInput): void {
    if (!input.resolvedIntent.tokenId || input.resolvedIntent.tokenId.trim().length === 0) {
      throw new Error('Order planner requires a resolved tokenId.');
    }

    if (!Number.isFinite(input.price) || input.price <= 0) {
      throw new Error('Order planner requires a positive finite price.');
    }

    if (!Number.isFinite(input.size) || input.size <= 0) {
      throw new Error('Order planner requires a positive finite size.');
    }

    const expectedVenueSide = this.resolveVenueSideFromIntent(input.resolvedIntent.intent);
    if (expectedVenueSide && expectedVenueSide !== input.resolvedIntent.venueSide) {
      throw new Error(
        `Resolved intent is inconsistent: intent=${input.resolvedIntent.intent} implies venueSide=${expectedVenueSide}, received=${input.resolvedIntent.venueSide}.`,
      );
    }

    const expectedInventoryEffect = this.resolveInventoryEffectFromIntent(
      input.resolvedIntent.intent,
    );
    if (
      expectedInventoryEffect &&
      expectedInventoryEffect !== input.resolvedIntent.inventoryEffect
    ) {
      throw new Error(
        `Resolved intent is inconsistent: intent=${input.resolvedIntent.intent} implies inventoryEffect=${expectedInventoryEffect}, received=${input.resolvedIntent.inventoryEffect}.`,
      );
    }

    if (!input.expiryAt || Number.isNaN(new Date(input.expiryAt).getTime())) {
      throw new Error('Order planner requires a valid expiryAt timestamp.');
    }

    const tickSize = this.normalizePositive(input.venueConstraints?.tickSize ?? null);
    if (tickSize !== null && !this.isOnTick(input.price, tickSize)) {
      throw new Error(
        `Order planner received price=${input.price} not aligned to tickSize=${tickSize}.`,
      );
    }

    const minOrderSize = this.normalizePositive(
      input.venueConstraints?.minOrderSize ?? null,
    );
    if (minOrderSize !== null && input.size < minOrderSize) {
      throw new Error(
        `Order planner received size=${input.size} below minOrderSize=${minOrderSize}.`,
      );
    }

    if (input.resolvedIntent.intent === 'FLIP') {
      throw new Error(
        'Order planner does not support direct FLIP orders; decompose into EXIT and ENTER upstream.',
      );
    }
  }

  private buildStyleRationale(input: {
    executionSemantics: {
      route: ExecutionRoute;
      reasonCode: string;
      reasonMessage: string;
    };
    fillProbabilityEstimate: FillProbabilityEstimatorResult;
    queueEstimate: QueuePositionEstimatorResult;
    slippageEstimate: SlippageEstimatorResult;
    expectedAdverseSelectionPenaltyBps: number;
  }): OrderPlannerStyleRationale[] {
    const reasons: OrderPlannerStyleRationale[] = [
      {
        code: input.executionSemantics.reasonCode,
        message: input.executionSemantics.reasonMessage,
      },
    ];

    if (input.fillProbabilityEstimate.fillProbability < 0.45) {
      reasons.push({
        code: 'empirical_fill_probability_soft',
        message: 'Recent bucket evidence implies low near-term fill probability.',
      });
    }
    if ((input.queueEstimate.upperBoundMs ?? 0) >= 20_000) {
      reasons.push({
        code: 'queue_delay_tail_elevated',
        message: 'Recent bucket evidence implies a long queue-delay tail for similar orders.',
      });
    }
    if (input.slippageEstimate.finalExpectedSlippageBps >= 30) {
      reasons.push({
        code: 'empirical_slippage_elevated',
        message: 'Recent fills imply slippage above the geometric baseline.',
      });
    }
    if (input.expectedAdverseSelectionPenaltyBps >= 20) {
      reasons.push({
        code: 'post_fill_toxicity_elevated',
        message: 'Recent post-fill drift implies elevated adverse-selection damage.',
      });
    }
    if (input.executionSemantics.route === 'maker') {
      reasons.push({
        code: 'maker_route_retains_optionalitiy',
        message: 'Resting execution preserves optionality when empirical toxicity is not forcing a cross.',
      });
    }
    return reasons;
  }

  private normalizePriceToTick(price: number, tickSize: number | null): number {
    const normalizedTick = this.normalizePositive(tickSize);
    if (normalizedTick === null) {
      return price;
    }

    const rounded = Math.round(price / normalizedTick) * normalizedTick;
    return Number(rounded.toFixed(this.decimalPlaces(normalizedTick)));
  }

  private isOnTick(price: number, tickSize: number): boolean {
    const scaled = price / tickSize;
    return Math.abs(scaled - Math.round(scaled)) <= 1e-9;
  }

  private decimalPlaces(value: number): number {
    const asString = value.toString();
    const idx = asString.indexOf('.');
    return idx === -1 ? 0 : asString.length - idx - 1;
  }

  private normalizePositive(value: number | null | undefined): number | null {
    return Number.isFinite(value) && (value as number) > 0 ? (value as number) : null;
  }

  private normalizeNonNegative(value: number | null | undefined): number | null {
    return Number.isFinite(value) && (value as number) >= 0 ? (value as number) : null;
  }

  private resolveVenueSideFromIntent(intent: TradeIntent): VenueSide | null {
    if (intent === 'ENTER') {
      return 'BUY';
    }

    if (intent === 'REDUCE' || intent === 'EXIT') {
      return 'SELL';
    }

    return null;
  }

  private resolveInventoryEffectFromIntent(intent: TradeIntent): InventoryEffect | null {
    if (intent === 'ENTER') {
      return 'INCREASE';
    }

    if (intent === 'REDUCE' || intent === 'EXIT') {
      return 'DECREASE';
    }

    if (intent === 'FLIP') {
      return 'NEUTRAL';
    }

    return null;
  }
}

function classifySpreadBucket(spread: number | null | undefined) {
  if (!Number.isFinite(spread ?? Number.NaN) || (spread ?? 0) <= 0) {
    return 'unknown' as const;
  }
  if ((spread ?? 0) <= 0.01) {
    return 'tight' as const;
  }
  if ((spread ?? 0) <= 0.025) {
    return 'normal' as const;
  }
  if ((spread ?? 0) <= 0.05) {
    return 'wide' as const;
  }
  return 'stressed' as const;
}

function classifyLiquidityBucket(depth: number | null | undefined) {
  if (!Number.isFinite(depth ?? Number.NaN) || (depth ?? 0) <= 0) {
    return 'unknown' as const;
  }
  if ((depth ?? 0) < 20) {
    return 'thin' as const;
  }
  if ((depth ?? 0) < 100) {
    return 'balanced' as const;
  }
  return 'deep' as const;
}
