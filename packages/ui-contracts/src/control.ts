export type TradingOperatingMode = 'sentinel_simulation' | 'live_trading';

export type SentinelRecommendationState =
  | 'not_ready'
  | 'ready_to_consider_live';

export interface SentinelStatusContract {
  updatedAt: string;
  recommendationState: SentinelRecommendationState;
  recommendationMessage: string;
  simulatedTradesCompleted: number;
  simulatedTradesLearned: number;
  targetSimulatedTrades: number;
  targetLearnedTrades: number;
  readinessScore: number;
  readinessThreshold: number;
  expectedVsRealizedEdgeGapBps: number;
  fillQualityPassRate: number;
  noTradeDisciplinePassRate: number;
  unresolvedAnomalyCount: number;
  recommendedLiveEnable: boolean;
}

export interface BotControlStateContract {
  state:
    | 'bootstrapping'
    | 'running'
    | 'degraded'
    | 'reconciliation_only'
    | 'cancel_only'
    | 'halted_hard'
    | 'stopped';
  operatingMode: TradingOperatingMode;
  sentinelEnabled: boolean;
  recommendedLiveEnable: boolean;
  sentinelStatus: SentinelStatusContract | null;
  liveConfig: {
    maxOpenPositions: number;
    maxDailyLossPct: number;
    maxPerTradeRiskPct: number;
    maxKellyFraction: number;
    maxConsecutiveLosses: number;
    noTradeWindowSeconds: number;
    evaluationIntervalMs: number;
    orderReconcileIntervalMs: number;
    portfolioRefreshIntervalMs: number;
  };
  lastTransitionAt: string | null;
  lastTransitionReason: string | null;
  readiness: {
    ready: boolean;
    checks: {
      startupRunbook: boolean;
      authenticatedVenueSmoke: boolean;
      recovery: boolean;
      secrets: boolean;
    };
  };
}

export interface SetOperatingModeRequestContract {
  operatingMode: TradingOperatingMode;
  requestedBy?: string;
}

export interface OperatingModeResponseContract {
  operatingMode: TradingOperatingMode;
  sentinelEnabled: boolean;
  eligibleForLiveTrading: boolean;
  warningText: string | null;
  sentinelStatus: SentinelStatusContract | null;
}
