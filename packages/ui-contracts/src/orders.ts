export interface OrderContract {
  id: string;
  marketId: string;
  signalId: string | null;
  strategyVersionId: string | null;
  status: string;
  side: string;
  price: number;
  size: number;
  expectedEv: number | null;
  postedAt: string | null;
  acknowledgedAt: string | null;
  canceledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FillContract {
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