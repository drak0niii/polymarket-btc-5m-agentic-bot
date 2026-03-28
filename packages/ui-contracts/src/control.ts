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
  eligibleForLiveTrading: boolean;
  warningText: string | null;
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
      env: boolean;
      signing: boolean;
      credentials: boolean;
      liveMode: boolean;
      riskConfig: boolean;
    };
    blockingReasons: string[];
  };
  controlPlane: {
    source: string;
    pendingCommands: Array<{
      id: string;
      command: 'start' | 'stop' | 'halt';
      cancelOpenOrders: boolean;
      createdAt: string;
    }>;
    activeCommands: RuntimeCommandContract[];
    recentCommands: RuntimeCommandContract[];
    latestCommandByType: {
      start: RuntimeCommandContract | null;
      stop: RuntimeCommandContract | null;
      halt: RuntimeCommandContract | null;
    };
  };
}

export interface RuntimeCommandContract {
  id: string;
  command: 'start' | 'stop' | 'halt';
  reason: string;
  requestedBy: string | null;
  cancelOpenOrders: boolean;
  status: 'pending' | 'processing' | 'applied' | 'failed';
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
  processedAt: string | null;
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
