import {
  ExecutionRoute,
  ExecutionSemanticsPolicy,
  ExecutionStyle,
  OrderUrgency,
  OrderType,
  PartialFillTolerance,
} from './execution-semantics-policy';

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

  createdAt: string;
}

export class OrderPlanner {
  private readonly executionSemanticsPolicy = new ExecutionSemanticsPolicy();

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
