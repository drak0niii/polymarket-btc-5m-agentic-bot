export type TradingOperatingMode = 'sentinel_simulation' | 'live_trading';

export type SentinelRecommendationState =
  | 'not_ready'
  | 'ready_to_consider_live';

export interface SentinelBaselineKnowledge {
  baselineId: string;
  createdAt: string;
  operatingMode: TradingOperatingMode;
  targetSimulatedTrades: number;
  targetLearnedTrades: number;
  readinessThreshold: number;
  boundedLearningSurfaces: string[];
  sourceOfTruth: {
    simulatedTradesPath: string;
    learningUpdatesPath: string;
    readinessPath: string;
  };
  notes: string[];
}

export interface SentinelSimulatedTradeRecord {
  simulationTradeId: string;
  signalId: string;
  marketId: string;
  tokenId: string;
  strategyVersionId: string | null;
  strategyVariantId: string | null;
  regime: string | null;
  simulatedAt: string;
  side: 'BUY' | 'SELL';
  operatingMode: TradingOperatingMode;
  expectedFillProbability: number;
  realizedFillProbability: number;
  expectedFillFraction: number;
  realizedFillFraction: number;
  expectedQueueDelayMs: number | null;
  realizedQueueDelayMs: number | null;
  expectedFeeBps: number;
  realizedFeeBps: number;
  expectedSlippageBps: number;
  realizedSlippageBps: number;
  expectedNetEdgeAfterCostsBps: number;
  realizedNetEdgeAfterCostsBps: number;
  expectedVsRealizedEdgeGapBps: number;
  fillQualityPassed: boolean;
  noTradeDisciplinePassed: boolean;
  unresolvedAnomalyCount: number;
  rationale: string[];
  evidenceRefs: string[];
}

export interface SentinelLearningUpdate {
  learningUpdateId: string;
  simulationTradeId: string;
  learnedAt: string;
  parameterChanges: Array<{
    parameter: string;
    previousValue?: number | string | boolean | null;
    nextValue?: number | string | boolean | null;
    rationale: string[];
    boundedBy: string[];
  }>;
  evidenceRefs: string[];
  reason: string;
  rollbackCriteria: string[];
}

export interface SentinelReadinessStatus {
  updatedAt: string;
  operatingMode: TradingOperatingMode;
  recommendationState: SentinelRecommendationState;
  recommendationMessage: string;
  simulatedTradesCompleted: number;
  simulatedTradesLearned: number;
  targetSimulatedTrades: number;
  targetLearnedTrades: number;
  readinessScore: number;
  readinessThreshold: number;
  simulatedNetEdgeAfterCostsBps: number;
  expectedVsRealizedEdgeGapBps: number;
  fillQualityPassRate: number;
  noTradeDisciplinePassRate: number;
  learningCoverage: number;
  unresolvedAnomalyCount: number;
  recommendedLiveEnable: boolean;
}
