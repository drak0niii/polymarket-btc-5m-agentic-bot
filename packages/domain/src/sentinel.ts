export type TradingOperatingMode = 'sentinel_simulation' | 'live_trading';

export type SentinelRecommendationState =
  | 'not_ready'
  | 'ready_to_consider_live';

export interface SentinelBaselineKnowledge {
  baselineId: string;
  createdAt: string;
  operatingMode: TradingOperatingMode;
  strategyVariantId?: string | null;
  strategyVersion?: string | null;
  regimeModelVersion?: string | null;
  initialNetEdgeAssumptions?: {
    expectedNetEdgeBps: number;
  };
  initialCostAssumptions?: {
    expectedFeeBps: number;
    expectedSlippageBps: number;
  };
  initialTrustScore?: number;
  targetSimulatedTrades: number;
  targetLearnedTrades: number;
  readinessThreshold: number;
  safeToGoLiveThresholds?: {
    targetSimulatedTrades: number;
    targetLearnedTrades: number;
    readinessThreshold: number;
    maxExpectedVsRealizedEdgeGapBps: number;
    minFillQualityPassRate: number;
    minNoTradeDisciplinePassRate: number;
    maxUnresolvedAnomalyCount: number;
  };
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
  decisionId?: string;
  marketId: string;
  tokenId: string;
  strategyVersionId: string | null;
  strategyVariantId: string | null;
  regime: string | null;
  simulatedAt: string;
  intendedPrice?: number;
  simulatedFillPrice?: number;
  simulatedFee?: number;
  simulatedSlippageBps?: number;
  expectedNetEdgeBps?: number;
  realizedNetEdgeBps?: number;
  fillProbabilityUsed?: number;
  orderbookSnapshotRef?: string | null;
  createdAt?: string;
  finalizedAt?: string;
  learned?: boolean;
  learningOutcomeRef?: string | null;
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
  mode?: TradingOperatingMode;
  recommendationState: SentinelRecommendationState;
  recommendationMessage: string;
  simulatedTradesCompleted: number;
  simulatedTradesLearned: number;
  targetSimulatedTrades: number;
  targetLearnedTrades: number;
  readinessScore: number;
  readinessThreshold: number;
  simulatedNetEdgeAfterCostsBps: number;
  netEdgeAfterCostsBps?: number;
  expectedVsRealizedEdgeGapBps: number;
  fillQualityPassRate: number;
  noTradeDisciplinePassRate: number;
  learningCoverage: number;
  unresolvedAnomalyCount: number;
  recommendedLiveEnable: boolean;
  lastLearningAt?: string | null;
  baselineKnowledgeVersion?: string;
}
