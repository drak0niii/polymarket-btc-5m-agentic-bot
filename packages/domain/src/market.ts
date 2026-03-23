export interface Market {
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

export interface MarketSnapshot {
  id: string;
  marketId: string;
  marketPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  volume: number | null;
  expiresAt: string | null;
  observedAt: string;
  createdAt: string;
}