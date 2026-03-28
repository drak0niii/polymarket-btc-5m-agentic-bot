export type BotRuntimeState =
  | 'bootstrapping'
  | 'running'
  | 'degraded'
  | 'reconciliation_only'
  | 'cancel_only'
  | 'halted_hard'
  | 'stopped';

export type RuntimeTransitionReasonFamily =
  | 'operator'
  | 'startup'
  | 'execution_anomaly'
  | 'venue_operational'
  | 'portfolio_risk'
  | 'recovery';

export interface RuntimeTransitionRequest {
  currentState: BotRuntimeState;
  nextState: BotRuntimeState;
  family: RuntimeTransitionReasonFamily;
  reasonCode: string;
  rationale: string[];
  requestedAt: string;
}

export interface RuntimeSubsystemPermissions {
  allowMarketDataReads: boolean;
  allowStrategyEvaluation: boolean;
  allowNewEntries: boolean;
  allowOrderSubmit: boolean;
  allowOrderCancel: boolean;
  allowEmergencyCancel: boolean;
  allowReconciliation: boolean;
  allowPortfolioRefresh: boolean;
  allowHeartbeat: boolean;
  allowStartupChecks: boolean;
}

const LEGAL_TRANSITIONS: Record<BotRuntimeState, BotRuntimeState[]> = {
  stopped: ['bootstrapping', 'halted_hard'],
  bootstrapping: [
    'running',
    'degraded',
    'reconciliation_only',
    'cancel_only',
    'halted_hard',
    'stopped',
  ],
  running: ['bootstrapping', 'degraded', 'reconciliation_only', 'cancel_only', 'halted_hard', 'stopped'],
  degraded: ['bootstrapping', 'running', 'reconciliation_only', 'cancel_only', 'halted_hard', 'stopped'],
  reconciliation_only: ['bootstrapping', 'running', 'degraded', 'cancel_only', 'halted_hard', 'stopped'],
  cancel_only: ['bootstrapping', 'reconciliation_only', 'halted_hard', 'stopped'],
  halted_hard: ['bootstrapping', 'stopped'],
};

export function permissionsForRuntimeState(
  state: BotRuntimeState,
): RuntimeSubsystemPermissions {
  switch (state) {
    case 'bootstrapping':
      return {
        allowMarketDataReads: true,
        allowStrategyEvaluation: false,
        allowNewEntries: false,
        allowOrderSubmit: false,
        allowOrderCancel: true,
        allowEmergencyCancel: false,
        allowReconciliation: true,
        allowPortfolioRefresh: true,
        allowHeartbeat: true,
        allowStartupChecks: true,
      };
    case 'running':
      return {
        allowMarketDataReads: true,
        allowStrategyEvaluation: true,
        allowNewEntries: true,
        allowOrderSubmit: true,
        allowOrderCancel: true,
        allowEmergencyCancel: false,
        allowReconciliation: true,
        allowPortfolioRefresh: true,
        allowHeartbeat: true,
        allowStartupChecks: false,
      };
    case 'degraded':
      return {
        allowMarketDataReads: true,
        allowStrategyEvaluation: false,
        allowNewEntries: false,
        allowOrderSubmit: false,
        allowOrderCancel: true,
        allowEmergencyCancel: false,
        allowReconciliation: true,
        allowPortfolioRefresh: true,
        allowHeartbeat: true,
        allowStartupChecks: false,
      };
    case 'reconciliation_only':
      return {
        allowMarketDataReads: true,
        allowStrategyEvaluation: false,
        allowNewEntries: false,
        allowOrderSubmit: false,
        allowOrderCancel: true,
        allowEmergencyCancel: false,
        allowReconciliation: true,
        allowPortfolioRefresh: true,
        allowHeartbeat: true,
        allowStartupChecks: false,
      };
    case 'cancel_only':
      return {
        allowMarketDataReads: true,
        allowStrategyEvaluation: false,
        allowNewEntries: false,
        allowOrderSubmit: false,
        allowOrderCancel: true,
        allowEmergencyCancel: false,
        allowReconciliation: true,
        allowPortfolioRefresh: true,
        allowHeartbeat: true,
        allowStartupChecks: false,
      };
    case 'halted_hard':
      return {
        allowMarketDataReads: false,
        allowStrategyEvaluation: false,
        allowNewEntries: false,
        allowOrderSubmit: false,
        allowOrderCancel: false,
        allowEmergencyCancel: true,
        allowReconciliation: false,
        allowPortfolioRefresh: false,
        allowHeartbeat: false,
        allowStartupChecks: false,
      };
    case 'stopped':
    default:
      return {
        allowMarketDataReads: false,
        allowStrategyEvaluation: false,
        allowNewEntries: false,
        allowOrderSubmit: false,
        allowOrderCancel: false,
        allowEmergencyCancel: false,
        allowReconciliation: false,
        allowPortfolioRefresh: false,
        allowHeartbeat: false,
        allowStartupChecks: false,
      };
  }
}

export function canTransitionRuntimeState(
  current: BotRuntimeState,
  next: BotRuntimeState,
): boolean {
  if (current === next) {
    return true;
  }

  return LEGAL_TRANSITIONS[current]?.includes(next) ?? false;
}

export function buildRuntimeTransitionRequest(input: {
  currentState: BotRuntimeState;
  nextState: BotRuntimeState;
  family: RuntimeTransitionReasonFamily;
  reasonCode: string;
  rationale?: string[];
  requestedAt?: string;
}): RuntimeTransitionRequest | null {
  if (input.currentState === input.nextState) {
    return null;
  }
  if (!canTransitionRuntimeState(input.currentState, input.nextState)) {
    throw new Error(
      `Illegal runtime transition request from ${input.currentState} to ${input.nextState}.`,
    );
  }
  return {
    currentState: input.currentState,
    nextState: input.nextState,
    family: input.family,
    reasonCode: input.reasonCode,
    rationale: input.rationale ?? [],
    requestedAt: input.requestedAt ?? new Date().toISOString(),
  };
}

export function normalizePersistedRuntimeState(value: string | null | undefined): BotRuntimeState {
  switch (value) {
    case 'bootstrapping':
    case 'running':
    case 'degraded':
    case 'reconciliation_only':
    case 'cancel_only':
    case 'halted_hard':
    case 'stopped':
      return value;
    default:
      return 'stopped';
  }
}
