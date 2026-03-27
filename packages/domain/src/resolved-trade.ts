export type ResolvedTradeLifecycleState =
  | 'partially_filled_open'
  | 'economically_resolved'
  | 'economically_resolved_with_portfolio_truth';

export interface ResolvedTradeBenchmarkContext {
  benchmarkComparisonState: string | null;
  baselinePenaltyMultiplier: number | null;
  regimeBenchmarkGateState: string | null;
  underperformedBenchmarkIds: string[];
  outperformedBenchmarkIds: string[];
  reasonCodes: string[];
}

export interface ResolvedTradeAttribution {
  benchmarkContext: ResolvedTradeBenchmarkContext | null;
  lossAttributionCategory: string | null;
  executionAttributionCategory: string | null;
  primaryLeakageDriver: string | null;
  secondaryLeakageDrivers: string[];
  reasonCodes: string[];
}

export interface ResolvedTradeExecutionQuality {
  intendedPrice: number;
  averageFillPrice: number | null;
  size: number;
  notional: number;
  estimatedFeeAtDecision: number | null;
  realizedFee: number;
  estimatedSlippageBps: number | null;
  realizedSlippageBps: number | null;
  queueDelayMs: number | null;
  fillFraction: number;
}

export interface ResolvedTradeNetOutcome {
  expectedNetEdgeBps: number | null;
  realizedNetEdgeBps: number | null;
  maxFavorableExcursionBps: number | null;
  maxAdverseExcursionBps: number | null;
  realizedPnl: number | null;
}

export interface ResolvedTradeRecord {
  tradeId: string;
  orderId: string;
  venueOrderId: string | null;
  marketId: string;
  tokenId: string;
  strategyVariantId: string | null;
  strategyVersion: string | null;
  regime: string | null;
  archetype: string | null;
  decisionTimestamp: string | null;
  submissionTimestamp: string | null;
  firstFillTimestamp: string | null;
  finalizedTimestamp: string;
  side: 'BUY' | 'SELL';
  intendedPrice: number;
  averageFillPrice: number | null;
  size: number;
  notional: number;
  estimatedFeeAtDecision: number | null;
  realizedFee: number;
  estimatedSlippageBps: number | null;
  realizedSlippageBps: number | null;
  queueDelayMs: number | null;
  fillFraction: number;
  expectedNetEdgeBps: number | null;
  realizedNetEdgeBps: number | null;
  maxFavorableExcursionBps: number | null;
  maxAdverseExcursionBps: number | null;
  toxicityScoreAtDecision: number | null;
  benchmarkContext: ResolvedTradeBenchmarkContext | null;
  lossAttributionCategory: string | null;
  executionAttributionCategory: string | null;
  lifecycleState: ResolvedTradeLifecycleState;
  attribution: ResolvedTradeAttribution;
  executionQuality: ResolvedTradeExecutionQuality;
  netOutcome: ResolvedTradeNetOutcome;
  capturedAt: string;
}
