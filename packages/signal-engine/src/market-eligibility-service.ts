import {
  BtcFiveMinuteTradeableUniverse,
  UniverseMarketInput,
} from './btc-five-minute-tradeable-universe';

export type MarketEligibilityReasonCode =
  | 'enable_orderbook_required'
  | 'market_inactive'
  | 'market_closed'
  | 'insufficient_depth'
  | 'spread_too_wide'
  | 'tick_size_incompatible'
  | 'time_to_resolution_invalid'
  | 'abnormal_market_metadata'
  | 'universe_rejected'
  | 'passed';

export interface MarketEligibilityInput {
  market: UniverseMarketInput & {
    enableOrderBook?: boolean | null;
    abnormalTransition?: boolean | null;
  };
  spread: number | null;
  bidDepth: number;
  askDepth: number;
  topLevelDepth: number;
  tickSize: number | null;
  orderbookObservedAt?: string | Date | null;
  marketObservedAt?: string | Date | null;
  recentTradeCount?: number | null;
  maxOrderbookAgeMs: number;
  maxMarketAgeMs: number;
  noTradeWindowSeconds: number;
  maxExpiryWindowSeconds?: number;
}

export interface MarketEligibilityVerdict {
  eligible: boolean;
  reasonCode: MarketEligibilityReasonCode;
  reasonMessage: string | null;
}

export class MarketEligibilityService {
  private readonly universe = new BtcFiveMinuteTradeableUniverse();

  evaluate(input: MarketEligibilityInput): MarketEligibilityVerdict {
    if (input.market.enableOrderBook === false) {
      return {
        eligible: false,
        reasonCode: 'enable_orderbook_required',
        reasonMessage: 'Market is not orderbook enabled.',
      };
    }

    if (input.market.abnormalTransition === true) {
      return {
        eligible: false,
        reasonCode: 'abnormal_market_metadata',
        reasonMessage: 'Market metadata shows an abnormal transition or suspension.',
      };
    }

    const universeVerdict = this.universe.assessContinuation({
      market: input.market,
      spread: input.spread,
      bidDepth: input.bidDepth,
      askDepth: input.askDepth,
      topLevelDepth: input.topLevelDepth,
      orderbookObservedAt: input.orderbookObservedAt,
      marketObservedAt: input.marketObservedAt,
      recentTradeCount: input.recentTradeCount,
      maxOrderbookAgeMs: input.maxOrderbookAgeMs,
      maxMarketAgeMs: input.maxMarketAgeMs,
      noTradeWindowSeconds: input.noTradeWindowSeconds,
      maxExpiryWindowSeconds: input.maxExpiryWindowSeconds,
    });

    if (!universeVerdict.admitted) {
      return {
        eligible: false,
        reasonCode: 'universe_rejected',
        reasonMessage: universeVerdict.reasonCode,
      };
    }

    if (!Number.isFinite(input.tickSize) || (input.tickSize as number) <= 0 || (input.tickSize as number) > 0.05) {
      return {
        eligible: false,
        reasonCode: 'tick_size_incompatible',
        reasonMessage: 'Tick size is missing or incompatible with the strategy.',
      };
    }

    return {
      eligible: true,
      reasonCode: 'passed',
      reasonMessage: null,
    };
  }
}
