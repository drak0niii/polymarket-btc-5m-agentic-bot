export interface OrderbookLevel {
  price: number;
  size: number;
}

export interface Orderbook {
  id: string;
  marketId: string;
  bidLevels: OrderbookLevel[];
  askLevels: OrderbookLevel[];
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  depthScore: number | null;
  observedAt: string;
  createdAt: string;
}