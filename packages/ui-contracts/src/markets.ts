export interface MarketContract {
  id: string;
  slug: string;
  title: string;
  status: string;
  tokenIdYes: string | null;
  tokenIdNo: string | null;
  resolutionSource: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrderbookContract {
  id: string;
  marketId: string;
  bidLevels: unknown;
  askLevels: unknown;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  depthScore: number | null;
  observedAt: string;
  createdAt: string;
}