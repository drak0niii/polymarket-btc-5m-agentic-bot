const BTC_PATTERN = /\b(?:btc|bitcoin)\b/i;
const FIVE_MINUTE_PATTERN =
  /\b5\s*(?:m|min|mins|minute|minutes)\b|\bfive\s*minute\b/i;
const EXCLUDED_PATTERN =
  /\b(?:eth|ethereum|sol|solana|nasdaq|spy|gold|oil|election)\b/i;

export type BtcFiveMinuteUniverseReasonCode =
  | 'market_id_missing'
  | 'market_inactive'
  | 'market_closed'
  | 'market_not_tradable'
  | 'ambiguous_market_identity'
  | 'non_btc_market'
  | 'non_five_minute_market'
  | 'duplicate_candidate'
  | 'token_metadata_incomplete'
  | 'expiry_missing'
  | 'outside_trade_window'
  | 'near_resolution_blocked'
  | 'negative_risk_unsupported'
  | 'market_quality_insufficient'
  | 'stale_venue_state'
  | 'insufficient_orderbook_support'
  | 'insufficient_recent_activity'
  | 'passed';

export interface BtcFiveMinuteUniverseDecision {
  admitted: boolean;
  reasonCode: BtcFiveMinuteUniverseReasonCode;
  reasonMessage: string | null;
  candidateKey: string | null;
}

export interface UniverseMarketInput {
  id?: string | null;
  slug?: string | null;
  title?: string | null;
  question?: string | null;
  description?: string | null;
  category?: string | null;
  active?: boolean | null;
  closed?: boolean | null;
  tradable?: boolean | null;
  tokenIdYes?: string | null;
  tokenIdNo?: string | null;
  durationSeconds?: number | null;
  expiresAt?: string | Date | null;
  negativeRisk?: boolean | null;
}

export interface UniverseContinuationInput {
  market: UniverseMarketInput;
  spread: number | null;
  bidDepth: number;
  askDepth: number;
  topLevelDepth: number;
  orderbookObservedAt?: string | Date | null;
  marketObservedAt?: string | Date | null;
  recentTradeCount?: number | null;
  maxOrderbookAgeMs: number;
  maxMarketAgeMs: number;
  noTradeWindowSeconds: number;
  maxExpiryWindowSeconds?: number;
  minCombinedDepth?: number;
  minTopLevelDepth?: number;
  maxSpread?: number;
  minRecentTradeCount?: number;
}

export class BtcFiveMinuteTradeableUniverse {
  assessDiscovery(
    market: UniverseMarketInput,
    options?: {
      noTradeWindowSeconds?: number;
      maxExpiryWindowSeconds?: number;
      duplicateKeys?: Set<string>;
    },
  ): BtcFiveMinuteUniverseDecision {
    const id = this.clean(market.id);
    if (!id) {
      return this.reject('market_id_missing', 'Market id is missing.');
    }

    if (market.active === false) {
      return this.reject('market_inactive', 'Market is not active.');
    }

    if (market.closed === true) {
      return this.reject('market_closed', 'Market is already closed.');
    }

    if (market.tradable === false) {
      return this.reject('market_not_tradable', 'Market is not tradable.');
    }

    const text = this.marketText(market);
    if (!BTC_PATTERN.test(text)) {
      return this.reject('non_btc_market', 'Market is not BTC-linked.');
    }

    if (EXCLUDED_PATTERN.test(text)) {
      return this.reject(
        'ambiguous_market_identity',
        'Market title mixes BTC with another product taxonomy.',
      );
    }

    const durationSeconds = Number(market.durationSeconds ?? Number.NaN);
    const isFiveMinute =
      Number.isFinite(durationSeconds) && durationSeconds >= 240 && durationSeconds <= 360
        ? true
        : FIVE_MINUTE_PATTERN.test(text);

    if (!isFiveMinute) {
      return this.reject(
        'non_five_minute_market',
        'Market does not prove 5-minute cadence.',
      );
    }

    if (!this.clean(market.tokenIdYes) || !this.clean(market.tokenIdNo)) {
      return this.reject(
        'token_metadata_incomplete',
        'Market is missing YES/NO token metadata.',
      );
    }

    const expiresAt = this.parseDate(market.expiresAt);
    if (!expiresAt) {
      return this.reject('expiry_missing', 'Market expiry is missing.');
    }

    const secondsToExpiry = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
    const blockedWindow = options?.noTradeWindowSeconds ?? 30;
    const maxWindow = options?.maxExpiryWindowSeconds ?? 20 * 60;

    if (secondsToExpiry <= 0 || secondsToExpiry > maxWindow) {
      return this.reject(
        'outside_trade_window',
        'Market expiry is outside the BTC 5-minute trade window.',
      );
    }

    if (secondsToExpiry <= blockedWindow) {
      return this.reject(
        'near_resolution_blocked',
        'Market is inside the no-trade near-resolution window.',
      );
    }

    if (market.negativeRisk === true) {
      return this.reject(
        'negative_risk_unsupported',
        'Negative-risk markets are excluded by policy.',
      );
    }

    const candidateKey = this.candidateKey(market, expiresAt);
    if (candidateKey && options?.duplicateKeys?.has(candidateKey)) {
      return this.reject('duplicate_candidate', 'Duplicate BTC 5-minute market candidate.');
    }

    return {
      admitted: true,
      reasonCode: 'passed',
      reasonMessage: null,
      candidateKey,
    };
  }

  assessContinuation(input: UniverseContinuationInput): BtcFiveMinuteUniverseDecision {
    const discovery = this.assessDiscovery(input.market, {
      noTradeWindowSeconds: input.noTradeWindowSeconds,
      maxExpiryWindowSeconds: input.maxExpiryWindowSeconds,
    });
    if (!discovery.admitted) {
      return discovery;
    }

    if (this.ageMs(input.orderbookObservedAt) > input.maxOrderbookAgeMs) {
      return this.reject('stale_venue_state', 'Orderbook state is stale.');
    }

    if (this.ageMs(input.marketObservedAt) > input.maxMarketAgeMs) {
      return this.reject('stale_venue_state', 'Market snapshot state is stale.');
    }

    const minCombinedDepth = input.minCombinedDepth ?? 50;
    const minTopLevelDepth = input.minTopLevelDepth ?? 20;
    const maxSpread = input.maxSpread ?? 0.05;
    const recentTradeCount = input.recentTradeCount ?? 0;
    const minRecentTradeCount = input.minRecentTradeCount ?? 1;

    if (
      input.bidDepth + input.askDepth < minCombinedDepth ||
      input.topLevelDepth < minTopLevelDepth
    ) {
      return this.reject(
        'insufficient_orderbook_support',
        'Displayed orderbook depth is below BTC 5-minute minimums.',
      );
    }

    if ((input.spread ?? Infinity) > maxSpread) {
      return this.reject(
        'market_quality_insufficient',
        'Displayed spread exceeds the admissible BTC 5-minute threshold.',
      );
    }

    if (recentTradeCount < minRecentTradeCount) {
      return this.reject(
        'insufficient_recent_activity',
        'Recent trade activity is too weak for live deployment.',
      );
    }

    return {
      admitted: true,
      reasonCode: 'passed',
      reasonMessage: null,
      candidateKey: discovery.candidateKey,
    };
  }

  candidateKey(market: UniverseMarketInput, expiresAt?: Date | null): string | null {
    const slug = this.clean(market.slug);
    if (slug) {
      return slug.toLowerCase();
    }

    const title = this.clean(market.title) ?? this.clean(market.question);
    const expiry = expiresAt ?? this.parseDate(market.expiresAt);
    if (!title || !expiry) {
      return null;
    }

    return `${title.toLowerCase()}::${expiry.toISOString()}`;
  }

  private marketText(market: UniverseMarketInput): string {
    return [
      market.slug,
      market.title,
      market.question,
      market.description,
      market.category,
    ]
      .map((value) => this.clean(value) ?? '')
      .join(' ')
      .toLowerCase();
  }

  private parseDate(value: string | Date | null | undefined): Date | null {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }

    if (typeof value !== 'string' || value.trim().length === 0) {
      return null;
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private ageMs(value: string | Date | null | undefined): number {
    const parsed = this.parseDate(value ?? null);
    if (!parsed) {
      return Number.POSITIVE_INFINITY;
    }

    return Math.max(0, Date.now() - parsed.getTime());
  }

  private clean(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private reject(
    reasonCode: BtcFiveMinuteUniverseReasonCode,
    reasonMessage: string,
  ): BtcFiveMinuteUniverseDecision {
    return {
      admitted: false,
      reasonCode,
      reasonMessage,
      candidateKey: null,
    };
  }
}
