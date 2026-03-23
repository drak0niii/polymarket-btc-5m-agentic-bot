export interface RiskConfig {
  maxOpenPositions: number;
  maxDailyLossPct: number;
  maxPerTradeRiskPct: number;
  maxKellyFraction: number;
  maxConsecutiveLosses: number;
  noTradeWindowSeconds: number;
}

export interface RiskDecision {
  signalId: string;
  approved: boolean;
  reasonCode: string;
  reasonMessage: string | null;
  positionSize: number | null;
  capturedAt: string;
}