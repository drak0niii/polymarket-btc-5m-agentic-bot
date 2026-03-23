export interface PortfolioContract {
  id: string;
  bankroll: number;
  availableCapital: number;
  openExposure: number;
  realizedPnlDay: number;
  unrealizedPnl: number;
  consecutiveLosses: number;
  capturedAt: string;
  createdAt: string;
}