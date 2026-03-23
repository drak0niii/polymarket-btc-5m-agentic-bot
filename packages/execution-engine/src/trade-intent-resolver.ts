export type Outcome = 'YES' | 'NO';
export type VenueSide = 'BUY' | 'SELL';
export type TradeIntent = 'ENTER' | 'REDUCE' | 'EXIT' | 'FLIP';
export type InventoryEffect = 'INCREASE' | 'DECREASE' | 'NEUTRAL';

export interface TradeIntentResolverMarketInput {
  id: string;
  tokenIdYes?: string | null;
  tokenIdNo?: string | null;
}

export interface TradeIntentResolverSignalInput {
  id?: string;
  marketId?: string | null;

  /**
   * Legacy / venue-facing side if present.
   * Must not be used alone to infer token selection.
   */
  side?: string | null;

  /**
   * Explicit target token if already resolved upstream.
   */
  tokenId?: string | null;

  /**
   * Explicit target outcome / thesis if known.
   */
  outcome?: string | null;
  targetOutcome?: string | null;

  /**
   * Explicit action semantics if known.
   */
  action?: string | null;
  intent?: string | null;
  venueSide?: string | null;
}

export interface TradeIntentResolverInventoryInput {
  /**
   * Current open quantity for YES token, if known.
   */
  yesQuantity?: number | null;

  /**
   * Current open quantity for NO token, if known.
   */
  noQuantity?: number | null;

  /**
   * Current open quantity for an explicit token, if known.
   */
  quantityByTokenId?: Record<string, number | null> | null;
}

export interface ResolvedTradeIntent {
  marketId: string | null;
  tokenId: string;
  outcome: Outcome;
  venueSide: VenueSide;
  intent: TradeIntent;
  inventoryEffect: InventoryEffect;
}

export interface TradeIntentResolutionFailure {
  ok: false;
  reasonCode:
    | 'market_token_missing'
    | 'signal_token_unknown'
    | 'signal_outcome_unknown'
    | 'signal_token_outcome_conflict'
    | 'intent_missing'
    | 'intent_requires_inventory'
    | 'intent_side_conflict'
    | 'unsupported_flip_direct'
    | 'ambiguous_trade_intent';
  resolved: null;
}

export interface TradeIntentResolutionSuccess {
  ok: true;
  reasonCode: null;
  resolved: ResolvedTradeIntent;
}

export type TradeIntentResolutionResult =
  | TradeIntentResolutionSuccess
  | TradeIntentResolutionFailure;

export class TradeIntentResolver {
  resolve(input: {
    market: TradeIntentResolverMarketInput;
    signal: TradeIntentResolverSignalInput;
    inventory?: TradeIntentResolverInventoryInput | null;
  }): TradeIntentResolutionResult {
    const market = input.market;
    const signal = input.signal;
    const inventory = input.inventory ?? null;

    const tokenIdYes = this.clean(market.tokenIdYes);
    const tokenIdNo = this.clean(market.tokenIdNo);

    if (!tokenIdYes && !tokenIdNo) {
      return this.fail('market_token_missing');
    }

    const explicitTokenId = this.clean(signal.tokenId);
    const explicitOutcome =
      this.normalizeOutcome(signal.outcome) ??
      this.normalizeOutcome(signal.targetOutcome);

    const explicitIntent =
      this.normalizeIntent(signal.action) ??
      this.normalizeIntent(signal.intent) ??
      this.inferIntentFromLegacySide(signal.side);

    const explicitVenueSide =
      this.normalizeVenueSide(signal.venueSide) ??
      this.normalizeVenueSide(signal.side);

    let resolvedTokenId: string | null = null;
    let resolvedOutcome: Outcome | null = null;

    if (explicitTokenId) {
      const tokenMatch = this.resolveOutcomeFromTokenId({
        tokenId: explicitTokenId,
        tokenIdYes,
        tokenIdNo,
      });

      if (!tokenMatch) {
        return this.fail('signal_token_unknown');
      }

      resolvedTokenId = explicitTokenId;
      resolvedOutcome = tokenMatch;
    }

    if (explicitOutcome) {
      const tokenIdFromOutcome =
        explicitOutcome === 'YES' ? tokenIdYes : tokenIdNo;

      if (!tokenIdFromOutcome) {
        return this.fail('signal_outcome_unknown');
      }

      if (resolvedTokenId && resolvedOutcome && resolvedOutcome !== explicitOutcome) {
        return this.fail('signal_token_outcome_conflict');
      }

      resolvedTokenId = tokenIdFromOutcome;
      resolvedOutcome = explicitOutcome;
    }

    if (!resolvedTokenId || !resolvedOutcome) {
      return this.fail('ambiguous_trade_intent');
    }

    if (!explicitIntent) {
      return this.fail('intent_missing');
    }

    if (explicitIntent === 'FLIP') {
      return this.fail('unsupported_flip_direct');
    }

    const venueSide = this.resolveVenueSideFromIntent(explicitIntent);
    const inventoryEffect = this.resolveInventoryEffectFromIntent(explicitIntent);

    if (!venueSide || !inventoryEffect) {
      return this.fail('ambiguous_trade_intent');
    }

    if (explicitVenueSide && explicitVenueSide !== venueSide) {
      return this.fail('intent_side_conflict');
    }

    if (inventoryEffect === 'DECREASE' && inventory) {
      const currentQty = this.resolveInventoryQuantity({
        tokenId: resolvedTokenId,
        outcome: resolvedOutcome,
        inventory,
      });

      if (!(currentQty > 0)) {
        return this.fail('intent_requires_inventory');
      }
    }

    return {
      ok: true,
      reasonCode: null,
      resolved: {
        marketId: this.clean(signal.marketId) ?? market.id ?? null,
        tokenId: resolvedTokenId,
        outcome: resolvedOutcome,
        venueSide,
        intent: explicitIntent,
        inventoryEffect,
      },
    };
  }

  private resolveOutcomeFromTokenId(input: {
    tokenId: string;
    tokenIdYes: string | null;
    tokenIdNo: string | null;
  }): Outcome | null {
    if (input.tokenIdYes && input.tokenId === input.tokenIdYes) {
      return 'YES';
    }
    if (input.tokenIdNo && input.tokenId === input.tokenIdNo) {
      return 'NO';
    }
    return null;
  }

  private resolveInventoryQuantity(input: {
    tokenId: string;
    outcome: Outcome;
    inventory: TradeIntentResolverInventoryInput | null;
  }): number {
    if (!input.inventory) {
      return 0;
    }

    const byToken = input.inventory.quantityByTokenId ?? null;
    if (byToken && Object.prototype.hasOwnProperty.call(byToken, input.tokenId)) {
      const value = Number(byToken[input.tokenId] ?? 0);
      return Number.isFinite(value) ? value : 0;
    }

    if (input.outcome === 'YES') {
      const value = Number(input.inventory.yesQuantity ?? 0);
      return Number.isFinite(value) ? value : 0;
    }

    const value = Number(input.inventory.noQuantity ?? 0);
    return Number.isFinite(value) ? value : 0;
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

  private resolveInventoryEffectFromIntent(
    intent: TradeIntent,
  ): InventoryEffect | null {
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

  private inferIntentFromLegacySide(value: string | null | undefined): TradeIntent | null {
    const side = this.normalizeVenueSide(value);
    if (!side) {
      return null;
    }

    return side === 'BUY' ? 'ENTER' : 'EXIT';
  }

  private normalizeOutcome(value: string | null | undefined): Outcome | null {
    const normalized = this.clean(value)?.toUpperCase();
    if (normalized === 'YES') {
      return 'YES';
    }
    if (normalized === 'NO') {
      return 'NO';
    }
    return null;
  }

  private normalizeIntent(value: string | null | undefined): TradeIntent | null {
    const normalized = this.clean(value)?.toUpperCase();
    if (normalized === 'ENTER') {
      return 'ENTER';
    }
    if (normalized === 'REDUCE') {
      return 'REDUCE';
    }
    if (normalized === 'EXIT') {
      return 'EXIT';
    }
    if (normalized === 'FLIP') {
      return 'FLIP';
    }
    return null;
  }

  private normalizeVenueSide(value: string | null | undefined): VenueSide | null {
    const normalized = this.clean(value)?.toUpperCase();
    if (normalized === 'BUY') {
      return 'BUY';
    }
    if (normalized === 'SELL') {
      return 'SELL';
    }
    return null;
  }

  private clean(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private fail(
    reasonCode: TradeIntentResolutionFailure['reasonCode'],
  ): TradeIntentResolutionFailure {
    return {
      ok: false,
      reasonCode,
      resolved: null,
    };
  }
}
