export interface BotControlStateContract {
  state:
    | 'bootstrapping'
    | 'running'
    | 'degraded'
    | 'reconciliation_only'
    | 'cancel_only'
    | 'halted_hard'
    | 'stopped';
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
