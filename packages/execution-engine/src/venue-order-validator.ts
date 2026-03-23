export type VenueSide = 'BUY' | 'SELL';
export type VenueOrderType = 'GTC' | 'FOK' | 'FAK' | 'GTD';
export type ExecutionStyle = 'rest' | 'cross';

export type VenueOrderValidationReasonCode =
  | 'token_id_missing'
  | 'invalid_side'
  | 'invalid_price'
  | 'invalid_size'
  | 'unsupported_order_type'
  | 'tick_size_missing'
  | 'min_order_size_missing'
  | 'neg_risk_missing'
  | 'invalid_tick_size'
  | 'invalid_min_order_size'
  | 'price_not_on_tick'
  | 'size_below_min_order_size'
  | 'market_order_type_requires_immediate_execution'
  | 'resting_order_type_requires_resting_execution'
  | 'invalid_gtd_expiration'
  | 'gtd_expiration_below_security_threshold'
  | 'unexpected_expiration_for_immediate_order'
  | 'post_only_conflicts_with_immediate_execution';

export interface VenueOrderMetadata {
  tickSize?: number | null;
  minOrderSize?: number | null;
  negRisk?: boolean | null;
}

export interface VenueOrderValidatorInput {
  tokenId: string;
  side: VenueSide;
  price: number;
  size: number;
  orderType: VenueOrderType;
  metadata: VenueOrderMetadata;

  /**
   * Whether this order is intended to rest on the book
   * or cross immediately.
   */
  executionStyle?: ExecutionStyle | null;

  /**
   * GTD orders require expiration.
   * Immediate execution orders should not carry expiration.
   */
  expiration?: string | null;

  /**
   * Reserved for future support. If true, immediate order types must be rejected.
   */
  postOnly?: boolean | null;

  /**
   * If true, quantize price to tick before evaluating.
   * Default false: reject off-tick prices instead of mutating them.
   */
  normalizePriceToTick?: boolean | null;
}

export interface VenueOrderValidationResult {
  valid: boolean;
  normalizedPrice: number | null;
  normalizedSize: number | null;
  reasonCode: VenueOrderValidationReasonCode | null;
  reasonMessage: string | null;
}

export class VenueOrderValidator {
  validate(input: VenueOrderValidatorInput): VenueOrderValidationResult {
    if (!input.tokenId || input.tokenId.trim().length === 0) {
      return this.fail('token_id_missing', 'tokenId is required.');
    }

    if (input.side !== 'BUY' && input.side !== 'SELL') {
      return this.fail('invalid_side', `Invalid side: ${String(input.side)}.`);
    }

    if (!Number.isFinite(input.price) || input.price <= 0) {
      return this.fail('invalid_price', 'Price must be a positive finite number.');
    }

    if (!Number.isFinite(input.size) || input.size <= 0) {
      return this.fail('invalid_size', 'Size must be a positive finite number.');
    }

    if (!this.isSupportedOrderType(input.orderType)) {
      return this.fail(
        'unsupported_order_type',
        `Unsupported order type: ${String(input.orderType)}.`,
      );
    }

    const tickSize = this.normalizePositiveNumber(input.metadata.tickSize);
    if (tickSize === null) {
      return this.fail('tick_size_missing', 'tickSize is missing.');
    }

    const minOrderSize = this.normalizePositiveNumber(input.metadata.minOrderSize);
    if (minOrderSize === null) {
      return this.fail('min_order_size_missing', 'minOrderSize is missing.');
    }

    if (typeof input.metadata.negRisk !== 'boolean') {
      return this.fail('neg_risk_missing', 'negRisk is missing.');
    }

    if (!Number.isFinite(tickSize) || tickSize <= 0) {
      return this.fail('invalid_tick_size', 'tickSize must be a positive finite number.');
    }

    if (!Number.isFinite(minOrderSize) || minOrderSize <= 0) {
      return this.fail(
        'invalid_min_order_size',
        'minOrderSize must be a positive finite number.',
      );
    }

    let normalizedPrice = input.price;
    if (input.normalizePriceToTick === true) {
      normalizedPrice = this.quantizeToTick(input.price, tickSize);
    }

    if (!this.isOnTick(normalizedPrice, tickSize)) {
      return this.fail(
        'price_not_on_tick',
        `Price ${normalizedPrice} is not aligned to tickSize ${tickSize}.`,
      );
    }

    if (input.size < minOrderSize) {
      return this.fail(
        'size_below_min_order_size',
        `Size ${input.size} is below minOrderSize ${minOrderSize}.`,
      );
    }

    const executionStyle = input.executionStyle ?? null;

    if ((input.orderType === 'FOK' || input.orderType === 'FAK') && executionStyle === 'rest') {
      return this.fail(
        'market_order_type_requires_immediate_execution',
        `${input.orderType} requires immediate execution semantics.`,
      );
    }

    if ((input.orderType === 'GTC' || input.orderType === 'GTD') && executionStyle === 'cross') {
      return this.fail(
        'resting_order_type_requires_resting_execution',
        `${input.orderType} is a resting order type and is incompatible with cross execution.`,
      );
    }

    if (input.orderType === 'GTD') {
      if (!input.expiration) {
        return this.fail(
          'invalid_gtd_expiration',
          'GTD orders require a valid expiration timestamp.',
        );
      }

      const expirationTs = new Date(input.expiration).getTime();
      if (!Number.isFinite(expirationTs)) {
        return this.fail(
          'invalid_gtd_expiration',
          'GTD expiration must be a valid timestamp.',
        );
      }

      if (expirationTs - Date.now() < 60_000) {
        return this.fail(
          'gtd_expiration_below_security_threshold',
          'GTD expiration must be at least one minute in the future.',
        );
      }
    }

    if ((input.orderType === 'FOK' || input.orderType === 'FAK') && input.expiration) {
      return this.fail(
        'unexpected_expiration_for_immediate_order',
        `${input.orderType} orders must not include expiration.`,
      );
    }

    if (
      input.postOnly === true &&
      (input.orderType === 'FOK' || input.orderType === 'FAK')
    ) {
      return this.fail(
        'post_only_conflicts_with_immediate_execution',
        'postOnly is incompatible with immediate execution order types.',
      );
    }

    return {
      valid: true,
      normalizedPrice,
      normalizedSize: input.size,
      reasonCode: null,
      reasonMessage: null,
    };
  }

  private isSupportedOrderType(value: string): value is VenueOrderType {
    return value === 'GTC' || value === 'FOK' || value === 'FAK' || value === 'GTD';
  }

  private normalizePositiveNumber(value: number | null | undefined): number | null {
    return Number.isFinite(value) && (value as number) > 0 ? (value as number) : null;
  }

  private isOnTick(price: number, tickSize: number): boolean {
    const scaled = price / tickSize;
    return Math.abs(scaled - Math.round(scaled)) <= 1e-9;
  }

  private quantizeToTick(price: number, tickSize: number): number {
    const rounded = Math.round(price / tickSize) * tickSize;
    return Number(rounded.toFixed(this.decimalPlaces(tickSize)));
  }

  private decimalPlaces(value: number): number {
    const asString = value.toString();
    const idx = asString.indexOf('.');
    return idx === -1 ? 0 : asString.length - idx - 1;
  }

  private fail(
    reasonCode: VenueOrderValidationReasonCode,
    reasonMessage: string,
  ): VenueOrderValidationResult {
    return {
      valid: false,
      normalizedPrice: null,
      normalizedSize: null,
      reasonCode,
      reasonMessage,
    };
  }
}
