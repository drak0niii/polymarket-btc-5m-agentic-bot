import {
  ParsedGammaMarket,
  ParsedGammaMarketsResponse,
  parseGammaMarket,
  parseGammaMarketsPayload,
} from './parsers/venue-parsers';

export type GammaMarket = ParsedGammaMarket;

export class GammaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async listMarkets(): Promise<GammaMarket[]> {
    const result = await this.listMarketsDetailed();
    return result.markets;
  }

  async listMarketsDetailed(input?: {
    active?: boolean;
    closed?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<ParsedGammaMarketsResponse> {
    const url = new URL(`${this.baseUrl}/markets`);
    if (typeof input?.active === 'boolean') {
      url.searchParams.set('active', String(input.active));
    }
    if (typeof input?.closed === 'boolean') {
      url.searchParams.set('closed', String(input.closed));
    }
    if (typeof input?.limit === 'number') {
      url.searchParams.set('limit', String(input.limit));
    }
    if (typeof input?.offset === 'number') {
      url.searchParams.set('offset', String(input.offset));
    }

    const response = await this.fetchImpl(url);

    if (!response.ok) {
      throw new Error(
        `Gamma listMarkets failed: ${response.status} ${response.statusText}`,
      );
    }

    return parseGammaMarketsPayload(await response.json(), 'gamma_list_markets');
  }

  async getMarketById(marketId: string): Promise<GammaMarket> {
    const response = await this.fetchImpl(`${this.baseUrl}/markets/${marketId}`);

    if (!response.ok) {
      throw new Error(
        `Gamma getMarketById failed: ${response.status} ${response.statusText}`,
      );
    }

    return parseGammaMarket(await response.json(), 'gamma_get_market_by_id');
  }
}
