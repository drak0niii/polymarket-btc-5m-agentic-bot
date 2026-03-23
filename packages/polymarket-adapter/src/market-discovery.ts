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
  constructor(private readonly gammaClient: GammaClient) {}

  async discoverActiveBtcMarkets(): Promise<DiscoveredMarket[]> {
    const result = await this.discoverActiveBtcMarketsDetailed();
    return result.markets;
  }

  async discoverActiveBtcMarketsDetailed(): Promise<{
    markets: DiscoveredMarket[];
    failures: VenueParserIssue[];
  }> {
    const { markets, failures } = await this.gammaClient.listMarketsDetailed();

    return {
      markets: markets
        .filter((market) => this.isRelevantBtcFiveMinuteMarket(market))
        .map((market) => this.mapMarket(market)),
      failures,
    };
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
    const isFiveMinute =
      text.includes('5m') ||
      text.includes('5-minute') ||
      text.includes('5 min') ||
      text.includes('five minute');

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
