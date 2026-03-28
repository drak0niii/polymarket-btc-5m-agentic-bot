import type {
  BotControlStateContract,
  SentinelStatusContract,
  TradingOperatingMode,
} from './control';

export interface PortfolioSnapshotContract {
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

export interface PortfolioStateContract {
  status: 'ready' | 'missing';
  message: string | null;
  snapshot: PortfolioSnapshotContract | null;
}

export interface DashboardContract {
  botState: BotControlStateContract;
  readinessDashboard: unknown;
  operatingMode: TradingOperatingMode;
  sentinelStatus: SentinelStatusContract | null;
  recommendationMessage: string;
  simulatedTradesCompleted: number;
  simulatedTradesLearned: number;
  targetSimulatedTrades: number;
  readinessScore: number;
  readinessThreshold: number;
  recommendedLiveEnable: boolean;
  markets: unknown[];
  signals: unknown[];
  orders: unknown[];
  portfolio: PortfolioStateContract;
  diagnostics: {
    execution: unknown[];
    evDrift: unknown[];
    regimes: unknown[];
  };
  activity: unknown[];
}
