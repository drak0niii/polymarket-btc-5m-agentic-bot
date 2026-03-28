export class DashboardResponseDto {
  botState!: unknown;
  readinessDashboard!: unknown;
  operatingMode!: 'sentinel_simulation' | 'live_trading';
  sentinelStatus!: unknown | null;
  recommendationMessage!: string;
  simulatedTradesCompleted!: number;
  simulatedTradesLearned!: number;
  targetSimulatedTrades!: number;
  readinessScore!: number;
  readinessThreshold!: number;
  recommendedLiveEnable!: boolean;
  markets!: unknown[];
  signals!: unknown[];
  orders!: unknown[];
  portfolio!: unknown | null;
  diagnostics!: {
    execution: unknown[];
    evDrift: unknown[];
    regimes: unknown[];
  };
  activity!: unknown[];
}
