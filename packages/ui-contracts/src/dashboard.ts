import type {
  SentinelStatusContract,
  TradingOperatingMode,
} from './control';

export interface DashboardContract {
  botState: unknown;
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
  portfolio: unknown | null;
  diagnostics: {
    execution: unknown[];
    evDrift: unknown[];
    regimes: unknown[];
  };
  activity: unknown[];
}
