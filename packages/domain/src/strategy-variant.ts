import type { HealthLabel } from './learning-state';

export type StrategyVariantLifecycleStatus =
  | 'incumbent'
  | 'shadow'
  | 'canary'
  | 'quarantined'
  | 'retired';

export type StrategyVariantEvaluationMode =
  | 'shadow_only'
  | 'canary'
  | 'partial'
  | 'full';

export type StrategyRolloutStage =
  | 'shadow_only'
  | 'canary_1pct'
  | 'canary_5pct'
  | 'partial'
  | 'full';

export type StrategyPromotionVerdict =
  | 'reject'
  | 'shadow_only'
  | 'canary'
  | 'promote'
  | 'rollback';

export type StrategyRollbackTriggerCode =
  | 'realized_ev_collapse'
  | 'calibration_collapse'
  | 'execution_deterioration'
  | 'unexplained_drawdown'
  | 'quarantine_escalation';

export interface StrategyVariantLineage {
  variantId: string;
  strategyVersionId: string;
  parentVariantId: string | null;
  createdAt: string;
  createdReason: string;
}

export interface StrategyVariantRecord {
  variantId: string;
  strategyVersionId: string;
  status: StrategyVariantLifecycleStatus;
  evaluationMode: StrategyVariantEvaluationMode;
  rolloutStage: StrategyRolloutStage;
  health: HealthLabel;
  lineage: StrategyVariantLineage;
  capitalAllocationPct: number;
  lastShadowEvaluatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ShadowEvaluationEvidence {
  variantId: string;
  incumbentVariantId: string | null;
  evaluationMode: 'shadow';
  sampleCount: number;
  calibrationHealth: HealthLabel;
  executionHealth: HealthLabel;
  realizedVsExpected: number | null;
  realizedPnl: number;
  improvementVsIncumbent: number | null;
  sufficientSample: boolean;
  reasons: string[];
  evaluatedAt: string;
}

export interface StrategyPromotionDecision {
  verdict: StrategyPromotionVerdict;
  candidateVariantId: string | null;
  incumbentVariantId: string | null;
  targetRolloutStage: StrategyRolloutStage;
  reasons: string[];
  evidence: {
    sampleCount: number;
    calibrationHealth: HealthLabel;
    executionHealth: HealthLabel;
    realizedVsExpected: number | null;
    realizedPnl: number;
    improvementVsIncumbent: number | null;
    netEdgeQuality?: number | null;
    maxDrawdownPct?: number | null;
    capitalLeakageRatio?: number | null;
    executionEvRetention?: number | null;
    regimeStabilityScore?: number | null;
    stabilityAdjustedCapitalGrowthScore?: number | null;
    compoundingEfficiencyScore?: number | null;
    promotionGate?: Record<string, unknown>;
    stabilityCheck?: Record<string, unknown>;
  };
  rollbackCriteria: StrategyRollbackTriggerCode[];
  decidedAt: string;
}

export interface StrategyQuarantineScope {
  variantId: string;
  regime: string | null;
  marketContext: string | null;
}

export interface StrategyQuarantineRecord {
  quarantineId: string;
  scope: StrategyQuarantineScope;
  severity: 'low' | 'medium' | 'high';
  reasonCode: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface StrategyRolloutRecord {
  incumbentVariantId: string | null;
  challengerVariantId: string | null;
  stage: StrategyRolloutStage;
  challengerAllocationPct: number;
  rolloutSalt: string;
  appliedReason: string;
  appliedAt: string;
}

export interface StrategyRollbackRecord {
  rollbackId: string;
  trigger: StrategyRollbackTriggerCode;
  fromVariantId: string;
  toVariantId: string | null;
  reasons: string[];
  createdAt: string;
}

export interface StrategyDeploymentRegistryState {
  schemaVersion: number;
  updatedAt: string;
  incumbentVariantId: string | null;
  activeRollout: StrategyRolloutRecord | null;
  variants: Record<string, StrategyVariantRecord>;
  quarantines: Record<string, StrategyQuarantineRecord>;
  retiredVariantIds: string[];
  lastPromotionDecision: StrategyPromotionDecision | null;
  lastRollback: StrategyRollbackRecord | null;
}

export function buildStrategyVariantId(strategyVersionId: string): string {
  return `variant:${strategyVersionId}`;
}

export function createStrategyVariantRecord(input: {
  strategyVersionId: string;
  parentVariantId?: string | null;
  status?: StrategyVariantLifecycleStatus;
  evaluationMode?: StrategyVariantEvaluationMode;
  rolloutStage?: StrategyRolloutStage;
  health?: HealthLabel;
  capitalAllocationPct?: number;
  now?: Date;
  createdReason?: string;
}): StrategyVariantRecord {
  const now = input.now ?? new Date();
  const variantId = buildStrategyVariantId(input.strategyVersionId);
  return {
    variantId,
    strategyVersionId: input.strategyVersionId,
    status: input.status ?? 'shadow',
    evaluationMode: input.evaluationMode ?? 'shadow_only',
    rolloutStage: input.rolloutStage ?? 'shadow_only',
    health: input.health ?? 'healthy',
    lineage: {
      variantId,
      strategyVersionId: input.strategyVersionId,
      parentVariantId: input.parentVariantId ?? null,
      createdAt: now.toISOString(),
      createdReason: input.createdReason ?? 'registered_from_strategy_version',
    },
    capitalAllocationPct: input.capitalAllocationPct ?? 0,
    lastShadowEvaluatedAt: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function createDefaultStrategyDeploymentRegistryState(
  now = new Date(),
): StrategyDeploymentRegistryState {
  return {
    schemaVersion: 1,
    updatedAt: now.toISOString(),
    incumbentVariantId: null,
    activeRollout: null,
    variants: {},
    quarantines: {},
    retiredVariantIds: [],
    lastPromotionDecision: null,
    lastRollback: null,
  };
}
