export type HealthLabel =
  | 'healthy'
  | 'watch'
  | 'degraded'
  | 'quarantine_candidate';

export type LiquidityBucket = 'unknown' | 'thin' | 'balanced' | 'deep';

export type SpreadBucket = 'unknown' | 'tight' | 'normal' | 'wide' | 'stressed';

export type TimeToExpiryBucket =
  | 'unknown'
  | 'under_5m'
  | 'under_15m'
  | 'under_60m'
  | 'over_60m';

export type EntryTimingBucket =
  | 'unknown'
  | 'instant'
  | 'early'
  | 'delayed'
  | 'late';

export type ExecutionStyle = 'unknown' | 'maker' | 'taker' | 'hybrid';

export type LearningTradeSide = 'unknown' | 'buy' | 'sell';

export interface RegimePerformanceSnapshot {
  key: string;
  regime: string;
  liquidityBucket: LiquidityBucket;
  spreadBucket: SpreadBucket;
  timeToExpiryBucket: TimeToExpiryBucket;
  entryTimingBucket: EntryTimingBucket;
  executionStyle: ExecutionStyle;
  side: LearningTradeSide;
  strategyVariantId: string;
  sampleCount: number;
  winRate: number;
  expectedEvSum: number;
  realizedEvSum: number;
  avgExpectedEv: number;
  avgRealizedEv: number;
  realizedVsExpected: number;
  avgFillRate: number;
  avgSlippage: number;
  health: HealthLabel;
  lastObservedAt: string | null;
}

export interface CalibrationState {
  contextKey: string;
  strategyVariantId: string;
  regime: string | null;
  sampleCount: number;
  brierScore: number;
  logLoss: number;
  shrinkageFactor: number;
  overconfidenceScore: number;
  health: HealthLabel;
  version: number;
  driftSignals: string[];
  lastUpdatedAt: string | null;
}

export type ExecutionPolicyMode =
  | 'maker_preferred'
  | 'balanced'
  | 'taker_preferred';

export interface ExecutionLearningContext {
  contextKey: string;
  strategyVariantId: string;
  regime: string | null;
  sampleCount: number;
  makerSampleCount: number;
  takerSampleCount: number;
  makerFillRate: number;
  takerFillRate: number;
  averageFillDelayMs: number | null;
  averageSlippage: number;
  adverseSelectionScore: number;
  cancelSuccessRate: number;
  partialFillRate: number;
  makerPunished: boolean;
  health: HealthLabel;
  notes: string[];
  activePolicyVersionId: string | null;
  lastUpdatedAt: string | null;
}

export interface ExecutionPolicyVersion {
  versionId: string;
  contextKey: string;
  strategyVariantId: string;
  regime: string | null;
  mode: ExecutionPolicyMode;
  recommendedRoute: 'maker' | 'taker';
  recommendedExecutionStyle: 'rest' | 'cross';
  sampleCount: number;
  makerFillRateAssumption: number;
  takerFillRateAssumption: number;
  expectedFillDelayMs: number | null;
  expectedSlippage: number;
  adverseSelectionScore: number;
  cancelSuccessRate: number;
  partialFillRate: number;
  health: HealthLabel;
  rationale: string[];
  sourceCycleId: string | null;
  supersedesVersionId: string | null;
  createdAt: string;
}

export interface ExecutionLearningState {
  version: number;
  updatedAt: string | null;
  contexts: Record<string, ExecutionLearningContext>;
  policyVersions: Record<string, ExecutionPolicyVersion>;
  activePolicyVersionIds: Record<string, string>;
  lastPolicyChangeAt: string | null;
}

export type PortfolioLearningSleeveType = 'variant' | 'regime' | 'opportunity_class';

export interface PortfolioAllocationSlice {
  sliceKey: string;
  sleeveType: PortfolioLearningSleeveType;
  sleeveValue: string;
  sampleCount: number;
  allocatedCapital: number;
  expectedEvSum: number;
  realizedEvSum: number;
  realizedVsExpected: number | null;
  allocationShare: number;
  targetMultiplier: number;
  lastUpdatedAt: string | null;
}

export interface PortfolioDrawdownState {
  sleeveKey: string;
  sleeveType: PortfolioLearningSleeveType;
  sleeveValue: string;
  realizedEvCumulative: number;
  peakRealizedEv: number;
  troughRealizedEv: number;
  currentDrawdown: number;
  maxDrawdown: number;
  lastUpdatedAt: string | null;
}

export interface PortfolioConcentrationSignal {
  signalKey: string;
  sleeveType: PortfolioLearningSleeveType;
  sleeveValue: string;
  allocationShare: number;
  concentrationScore: number;
  penaltyMultiplier: number;
  severity: 'none' | 'low' | 'medium' | 'high';
  reasons: string[];
  lastUpdatedAt: string | null;
}

export interface StrategyCorrelationSignal {
  signalKey: string;
  leftVariantId: string;
  rightVariantId: string;
  sharedSampleCount: number;
  overlapScore: number;
  realizedAlignment: number;
  penaltyMultiplier: number;
  hiddenOverlap: boolean;
  reasons: string[];
  lastUpdatedAt: string | null;
}

export interface PortfolioAllocationDecisionRecord {
  decisionKey: string;
  strategyVariantId: string;
  targetMultiplier: number;
  status: 'increase' | 'hold' | 'reduce' | 'block_scale';
  reasons: string[];
  evidence: Record<string, unknown>;
  decidedAt: string | null;
}

export interface PortfolioLearningState {
  version: number;
  updatedAt: string | null;
  allocationByVariant: Record<string, PortfolioAllocationSlice>;
  allocationByRegime: Record<string, PortfolioAllocationSlice>;
  allocationByOpportunityClass: Record<string, PortfolioAllocationSlice>;
  drawdownBySleeve: Record<string, PortfolioDrawdownState>;
  concentrationSignals: Record<string, PortfolioConcentrationSignal>;
  correlationSignals: Record<string, StrategyCorrelationSignal>;
  allocationDecisions: Record<string, PortfolioAllocationDecisionRecord>;
  lastCorrelationUpdatedAt: string | null;
  lastAllocationUpdatedAt: string | null;
}

export interface PromotionDecision {
  decision: 'not_evaluated' | 'reject' | 'shadow_only' | 'canary' | 'promote' | 'rollback';
  reasons: string[];
  evidence: Record<string, unknown>;
  decidedAt: string | null;
}

export interface QuarantineDecision {
  status: 'none' | 'watch' | 'quarantine_recommended' | 'quarantined';
  severity: 'none' | 'low' | 'medium' | 'high';
  reasons: string[];
  scope: {
    strategyVariantId?: string | null;
    regime?: string | null;
    marketContext?: string | null;
  };
  decidedAt: string | null;
}

export interface CapitalAllocationDecision {
  status: 'unchanged' | 'reduce' | 'hold' | 'increase';
  targetMultiplier: number;
  reasons: string[];
  decidedAt: string | null;
}

export interface StrategyVariantState {
  strategyVariantId: string;
  health: HealthLabel;
  lastLearningAt: string | null;
  regimeSnapshots: Record<string, RegimePerformanceSnapshot>;
  calibrationContexts: string[];
  executionLearning: ExecutionLearningState;
  lastPromotionDecision: PromotionDecision;
  lastQuarantineDecision: QuarantineDecision;
  lastCapitalAllocationDecision: CapitalAllocationDecision;
}

export interface LearningCycleSummary {
  cycleId: string;
  startedAt: string;
  completedAt: string | null;
  status: 'completed' | 'completed_with_warnings' | 'failed';
  analyzedWindow: {
    from: string;
    to: string;
  };
  realizedOutcomeCount: number;
  attributionSliceCount: number;
  calibrationUpdates: number;
  shrinkageActions: number;
  degradedContexts: string[];
  warnings: string[];
  errors: string[];
  reviewOutputs?: Record<string, unknown> | null;
}

export interface LearningEvent {
  id: string;
  type:
    | 'learning_cycle_started'
    | 'learning_cycle_completed'
    | 'learning_cycle_failed'
    | 'calibration_updated'
    | 'edge_decay_detected'
    | 'confidence_shrinkage_changed'
    | 'strategy_variant_registered'
    | 'shadow_evaluation_completed'
    | 'strategy_promotion_decided'
    | 'strategy_quarantined'
    | 'strategy_rollout_changed'
    | 'strategy_rollback_triggered'
    | 'execution_learning_updated'
    | 'execution_policy_versioned'
    | 'adverse_selection_detected'
    | 'portfolio_learning_updated'
    | 'capital_allocation_decided'
    | 'correlation_signal_detected';
  severity: 'info' | 'warning' | 'critical';
  createdAt: string;
  cycleId: string | null;
  strategyVariantId: string | null;
  contextKey: string | null;
  summary: string;
  details: Record<string, unknown>;
}

export interface LearningState {
  schemaVersion: number;
  updatedAt: string;
  lastCycleStartedAt: string | null;
  lastCycleCompletedAt: string | null;
  lastCycleSummary: LearningCycleSummary | null;
  strategyVariants: Record<string, StrategyVariantState>;
  calibration: Record<string, CalibrationState>;
  executionLearning: ExecutionLearningState;
  portfolioLearning: PortfolioLearningState;
}

export function createDefaultExecutionLearningState(): ExecutionLearningState {
  return {
    version: 1,
    updatedAt: null,
    contexts: {},
    policyVersions: {},
    activePolicyVersionIds: {},
    lastPolicyChangeAt: null,
  };
}

export function createDefaultPortfolioLearningState(): PortfolioLearningState {
  return {
    version: 1,
    updatedAt: null,
    allocationByVariant: {},
    allocationByRegime: {},
    allocationByOpportunityClass: {},
    drawdownBySleeve: {},
    concentrationSignals: {},
    correlationSignals: {},
    allocationDecisions: {},
    lastCorrelationUpdatedAt: null,
    lastAllocationUpdatedAt: null,
  };
}

export function createDefaultExecutionLearningContext(input: {
  contextKey: string;
  strategyVariantId: string;
  regime?: string | null;
}): ExecutionLearningContext {
  return {
    contextKey: input.contextKey,
    strategyVariantId: input.strategyVariantId,
    regime: input.regime ?? null,
    sampleCount: 0,
    makerSampleCount: 0,
    takerSampleCount: 0,
    makerFillRate: 0,
    takerFillRate: 0,
    averageFillDelayMs: null,
    averageSlippage: 0,
    adverseSelectionScore: 0,
    cancelSuccessRate: 1,
    partialFillRate: 0,
    makerPunished: false,
    health: 'healthy',
    notes: [],
    activePolicyVersionId: null,
    lastUpdatedAt: null,
  };
}

export function createDefaultPromotionDecision(): PromotionDecision {
  return {
    decision: 'not_evaluated',
    reasons: [],
    evidence: {},
    decidedAt: null,
  };
}

export function createDefaultQuarantineDecision(): QuarantineDecision {
  return {
    status: 'none',
    severity: 'none',
    reasons: [],
    scope: {},
    decidedAt: null,
  };
}

export function createDefaultCapitalAllocationDecision(): CapitalAllocationDecision {
  return {
    status: 'unchanged',
    targetMultiplier: 1,
    reasons: [],
    decidedAt: null,
  };
}

export function createDefaultStrategyVariantState(
  strategyVariantId: string,
): StrategyVariantState {
  return {
    strategyVariantId,
    health: 'healthy',
    lastLearningAt: null,
    regimeSnapshots: {},
    calibrationContexts: [],
    executionLearning: createDefaultExecutionLearningState(),
    lastPromotionDecision: createDefaultPromotionDecision(),
    lastQuarantineDecision: createDefaultQuarantineDecision(),
    lastCapitalAllocationDecision: createDefaultCapitalAllocationDecision(),
  };
}

export function createDefaultLearningState(now = new Date()): LearningState {
  return {
    schemaVersion: 1,
    updatedAt: now.toISOString(),
    lastCycleStartedAt: null,
    lastCycleCompletedAt: null,
    lastCycleSummary: null,
    strategyVariants: {},
    calibration: {},
    executionLearning: createDefaultExecutionLearningState(),
    portfolioLearning: createDefaultPortfolioLearningState(),
  };
}
