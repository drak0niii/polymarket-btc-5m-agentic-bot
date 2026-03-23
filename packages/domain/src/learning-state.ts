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

export interface ExecutionLearningState {
  version: number;
  updatedAt: string | null;
  contexts: Record<
    string,
    {
      sampleCount: number;
      health: HealthLabel;
      notes: string[];
    }
  >;
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
}

export interface LearningEvent {
  id: string;
  type:
    | 'learning_cycle_started'
    | 'learning_cycle_completed'
    | 'learning_cycle_failed'
    | 'calibration_updated'
    | 'edge_decay_detected'
    | 'confidence_shrinkage_changed';
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
}

export function createDefaultExecutionLearningState(): ExecutionLearningState {
  return {
    version: 1,
    updatedAt: null,
    contexts: {},
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
  };
}
