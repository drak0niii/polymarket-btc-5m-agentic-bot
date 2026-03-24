export type TradeQualityLabel =
  | 'excellent'
  | 'good'
  | 'mixed'
  | 'poor'
  | 'destructive';

export interface TradeQualityComponentScore {
  score: number;
  label: TradeQualityLabel;
  reasons: string[];
  evidence: Record<string, unknown>;
}

export interface TradeQualityBreakdown {
  forecastQuality: TradeQualityComponentScore;
  calibrationQuality: TradeQualityComponentScore;
  executionQuality: TradeQualityComponentScore;
  timingQuality: TradeQualityComponentScore;
  policyCompliance: TradeQualityComponentScore;
  realizedOutcomeQuality: TradeQualityComponentScore;
  overallScore: number;
  reasons: string[];
}

export interface TradeQualityScore {
  tradeId: string;
  orderId: string | null;
  signalId: string | null;
  marketId: string | null;
  strategyVariantId: string | null;
  regime: string | null;
  marketContext: string | null;
  executionStyle: string | null;
  evaluatedAt: string;
  label: TradeQualityLabel;
  breakdown: TradeQualityBreakdown;
}
