export type VersionLineageKind =
  | 'strategy_version'
  | 'feature_set_version'
  | 'calibration_version'
  | 'execution_policy_version'
  | 'risk_policy_version'
  | 'allocation_policy_version';

export type LiveDecisionType =
  | 'signal_build'
  | 'signal_execution'
  | 'order_execution'
  | 'learning_cycle'
  | 'promotion'
  | 'quarantine'
  | 'rollback'
  | 'capital_allocation';

export type VenueUncertaintyLabel = 'healthy' | 'degraded' | 'unsafe';

export type VenueRuntimeMode =
  | 'normal'
  | 'size-reduced'
  | 'cancel-only'
  | 'reconciliation-only';

export interface StrategyVersionLineage {
  kind: 'strategy_version';
  versionId: string;
  strategyVersionId: string;
  strategyVariantId: string | null;
}

export interface FeatureSetVersionLineage {
  kind: 'feature_set_version';
  versionId: string;
  featureSetId: string;
  parameterHash: string;
  parentStrategyVersionId: string | null;
}

export interface CalibrationVersionLineage {
  kind: 'calibration_version';
  versionId: string;
  contextKey: string;
  strategyVariantId: string;
  regime: string | null;
  calibrationRevision: number;
}

export interface ExecutionPolicyVersionLineage {
  kind: 'execution_policy_version';
  versionId: string;
  contextKey: string;
  strategyVariantId: string;
  regime: string | null;
}

export interface RiskPolicyVersionLineage {
  kind: 'risk_policy_version';
  versionId: string;
  policyId: string;
  parameterHash: string;
}

export interface AllocationPolicyVersionLineage {
  kind: 'allocation_policy_version';
  versionId: string;
  policyId: string;
  strategyVariantId: string | null;
  allocationDecisionKey: string | null;
  parameterHash: string;
}

export interface DecisionVersionLineage {
  strategyVersion: StrategyVersionLineage | null;
  featureSetVersion: FeatureSetVersionLineage | null;
  calibrationVersion: CalibrationVersionLineage | null;
  executionPolicyVersion: ExecutionPolicyVersionLineage | null;
  riskPolicyVersion: RiskPolicyVersionLineage | null;
  allocationPolicyVersion: AllocationPolicyVersionLineage | null;
}

export interface DecisionReplaySnapshot {
  marketState: Record<string, unknown> | null;
  runtimeState: Record<string, unknown> | null;
  learningState: Record<string, unknown> | null;
  lineageState: Record<string, unknown> | null;
  activeParameterBundle: Record<string, unknown> | null;
  venueMode: VenueRuntimeMode | null;
  venueUncertainty: VenueUncertaintyLabel | null;
}

export interface VersionLineageDecisionRecord {
  decisionId: string;
  decisionType: LiveDecisionType;
  recordedAt: string;
  summary: string;
  signalId: string | null;
  signalDecisionId: string | null;
  orderId: string | null;
  marketId: string | null;
  strategyVariantId: string | null;
  cycleId: string | null;
  lineage: DecisionVersionLineage;
  replay: DecisionReplaySnapshot;
  tags: string[];
}

export interface VersionLineageRegistryState {
  schemaVersion: number;
  updatedAt: string;
  decisions: Record<string, VersionLineageDecisionRecord>;
  bySignalId: Record<string, string[]>;
  bySignalDecisionId: Record<string, string[]>;
  byOrderId: Record<string, string[]>;
  byMarketId: Record<string, string[]>;
  byStrategyVariantId: Record<string, string[]>;
  byCycleId: Record<string, string[]>;
}

export function createEmptyDecisionVersionLineage(): DecisionVersionLineage {
  return {
    strategyVersion: null,
    featureSetVersion: null,
    calibrationVersion: null,
    executionPolicyVersion: null,
    riskPolicyVersion: null,
    allocationPolicyVersion: null,
  };
}

export function createDefaultVersionLineageRegistryState(
  now = new Date(),
): VersionLineageRegistryState {
  return {
    schemaVersion: 1,
    updatedAt: now.toISOString(),
    decisions: {},
    bySignalId: {},
    bySignalDecisionId: {},
    byOrderId: {},
    byMarketId: {},
    byStrategyVariantId: {},
    byCycleId: {},
  };
}
