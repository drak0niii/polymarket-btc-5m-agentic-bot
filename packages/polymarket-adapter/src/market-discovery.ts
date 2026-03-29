import { GammaClient, GammaMarket } from './gamma-client';
import { VenueParserIssue } from './parsers/venue-parsers';

export interface DiscoveredMarket {
  id: string;
  slug: string;
  title: string;
  status: string;
  active: boolean;
  closed: boolean;
  tradable: boolean;
  enableOrderBook: boolean;
  negativeRisk: boolean | null;
  tokenIdYes: string | null;
  tokenIdNo: string | null;
  resolutionSource: string | null;
  conditionId: string | null;
  expiresAt: string | null;
}

export class MarketDiscovery {
  private static readonly ACTIVE_MARKETS_PAGE_SIZE = 500;
  private static readonly FIVE_MINUTE_PATTERNS = [
    /\b5m\b/i,
    /\b5-minute\b/i,
    /\b5 min\b/i,
    /\bfive minute\b/i,
  ];

  constructor(private readonly gammaClient: GammaClient) {}

  async discoverActiveBtcMarkets(): Promise<DiscoveredMarket[]> {
    const result = await this.discoverActiveBtcMarketsDetailed();
    return result.markets;
  }

  async discoverActiveBtcMarketsDetailed(): Promise<{
    markets: DiscoveredMarket[];
    failures: VenueParserIssue[];
  }> {
    const { markets, failures } = await this.listActiveMarketsDetailed();

    return {
      markets: markets
        .filter((market) => this.isRelevantBtcFiveMinuteMarket(market))
        .map((market) => this.mapMarket(market)),
      failures,
    };
  }

  private async listActiveMarketsDetailed(): Promise<{
    markets: GammaMarket[];
    failures: VenueParserIssue[];
  }> {
    const markets: GammaMarket[] = [];
    const failures: VenueParserIssue[] = [];
    let offset = 0;

    while (true) {
      const result = await this.gammaClient.listMarketsDetailed({
        active: true,
        closed: false,
        limit: MarketDiscovery.ACTIVE_MARKETS_PAGE_SIZE,
        offset,
      });
      markets.push(...result.markets);
      failures.push(...result.failures);

      if (result.markets.length < MarketDiscovery.ACTIVE_MARKETS_PAGE_SIZE) {
        break;
      }

      offset += MarketDiscovery.ACTIVE_MARKETS_PAGE_SIZE;
    }

    return { markets, failures };
  }

  private isRelevantBtcFiveMinuteMarket(market: GammaMarket): boolean {
    const slug = String(market.slug ?? '').toLowerCase();
    const question = String(market.question ?? '').toLowerCase();
    const active = market.active !== false;
    const closed = market.closed === true;

    if (!active || closed) {
      return false;
    }

    const text = `${slug} ${question}`;
    const isBtc = text.includes('btc') || text.includes('bitcoin');
    const isFiveMinute = MarketDiscovery.FIVE_MINUTE_PATTERNS.some((pattern) =>
      pattern.test(text),
    );

    return isBtc && isFiveMinute;
  }

  private mapMarket(market: GammaMarket): DiscoveredMarket {
    return {
      id: market.id,
      slug: market.slug,
      title: market.question,
      status:
        market.closed === true
          ? 'closed'
          : market.active === false
            ? 'inactive'
            : 'active',
      active: market.active,
      closed: market.closed,
      tradable: market.tradable,
      enableOrderBook: market.enableOrderBook,
      negativeRisk: market.negativeRisk,
      tokenIdYes: market.tokenIdYes,
      tokenIdNo: market.tokenIdNo,
      resolutionSource: typeof market.endDate === 'string' ? 'configured' : null,
      conditionId: market.conditionId,
      expiresAt: market.endDate,
    };
  }
}
