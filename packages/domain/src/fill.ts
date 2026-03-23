export interface Fill {
  id: string;
  marketId: string;
  orderId: string | null;
  price: number;
  size: number;
  fee: number | null;
  realizedPnl: number | null;
  filledAt: string;
  createdAt: string;
}