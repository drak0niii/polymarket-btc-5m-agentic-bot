import { KillSwitchTrigger } from './kill-switch';
import { SafetyState } from './safety-state';

export interface ExecutionQualityDiagnostic {
  expectedSlippage: number | null;
  realizedSlippage: number | null;
  expectedEv: number | null;
  realizedEv: number | null;
  staleOrder: boolean;
}

export interface ExecutionQualityKillSwitchInput {
  diagnostics: ExecutionQualityDiagnostic[];
  postFailureCount: number;
  cancelFailureCount: number;
  cancelFailuresWithWorkingOrders: number;
  heartbeatFailuresWithOpenOrders: number;
  divergenceStatus: 'none' | 'warning' | 'critical';
  staleBookRejectCount: number;
  totalRecentDecisions: number;
}

export interface ExecutionQualityTrigger extends KillSwitchTrigger {
  family:
    | 'fill_quality'
    | 'post_failures'
    | 'cancel_failures'
    | 'heartbeat_failures'
    | 'divergence'
    | 'stale_book';
}

export interface ExecutionQualityKillSwitchResult {
  triggers: ExecutionQualityTrigger[];
}

export class ExecutionQualityKillSwitches {
  evaluate(input: ExecutionQualityKillSwitchInput): ExecutionQualityKillSwitchResult {
    const triggers: ExecutionQualityTrigger[] = [];

    const slippageDriftDiagnostics = input.diagnostics.filter(
      (diagnostic) =>
        diagnostic.expectedSlippage != null &&
        diagnostic.realizedSlippage != null &&
        diagnostic.expectedSlippage > 0 &&
        diagnostic.realizedSlippage > diagnostic.expectedSlippage * 1.5,
    );
    if (slippageDriftDiagnostics.length >= 3) {
      const severity = slippageDriftDiagnostics.length >= 5 ? 5 : 3;
      triggers.push({
        family: 'fill_quality',
        reasonCode: 'fill_quality_deterioration',
        severity,
        recommendedState: severity >= 5 ? 'halt' : 'passive_only',
        blockNewEntries: true,
        forceReduction: severity >= 5,
        evidence: {
          sampleCount: slippageDriftDiagnostics.length,
        },
      });
    }

    if (input.postFailureCount >= 2) {
      const severity = input.postFailureCount >= 6 ? 5 : input.postFailureCount >= 4 ? 4 : 2;
      triggers.push({
        family: 'post_failures',
        reasonCode: 'post_failure_pressure',
        severity,
        recommendedState:
          severity >= 5 ? 'halt' : severity >= 4 ? 'no_new_entries' : 'reduced_frequency',
        blockNewEntries: severity >= 4,
        forceReduction: false,
        evidence: {
          postFailureCount: input.postFailureCount,
        },
      });
    }

    if (input.cancelFailureCount >= 1) {
      const severity =
        input.cancelFailuresWithWorkingOrders >= 3
          ? 5
          : input.cancelFailuresWithWorkingOrders >= 1 || input.cancelFailureCount >= 3
            ? 4
            : 3;
      triggers.push({
        family: 'cancel_failures',
        reasonCode: 'cancel_failure_pressure',
        severity,
        recommendedState:
          severity >= 5 ? 'halt' : severity >= 4 ? 'no_new_entries' : 'passive_only',
        blockNewEntries: true,
        forceReduction: severity >= 5,
        evidence: {
          cancelFailureCount: input.cancelFailureCount,
          cancelFailuresWithWorkingOrders: input.cancelFailuresWithWorkingOrders,
        },
      });
    }

    if (input.heartbeatFailuresWithOpenOrders >= 1) {
      const severity = input.heartbeatFailuresWithOpenOrders >= 2 ? 5 : 4;
      triggers.push({
        family: 'heartbeat_failures',
        reasonCode: 'heartbeat_failed_with_open_orders',
        severity,
        recommendedState: severity >= 5 ? 'halt' : 'no_new_entries',
        blockNewEntries: true,
        forceReduction: severity >= 5,
        evidence: {
          heartbeatFailuresWithOpenOrders: input.heartbeatFailuresWithOpenOrders,
        },
      });
    }

    if (input.divergenceStatus !== 'none') {
      const severity = input.divergenceStatus === 'critical' ? 5 : 3;
      triggers.push({
        family: 'divergence',
        reasonCode:
          input.divergenceStatus === 'critical'
            ? 'venue_local_divergence_critical'
            : 'venue_local_divergence_warning',
        severity,
        recommendedState:
          input.divergenceStatus === 'critical' ? 'halt' : 'no_new_entries',
        blockNewEntries: true,
        forceReduction: input.divergenceStatus === 'critical',
        evidence: {
          divergenceStatus: input.divergenceStatus,
        },
      });
    }

    const staleRejectRate =
      input.totalRecentDecisions > 0
        ? input.staleBookRejectCount / input.totalRecentDecisions
        : 0;
    if (input.staleBookRejectCount >= 3 && staleRejectRate >= 0.4) {
      triggers.push({
        family: 'stale_book',
        reasonCode: 'stale_book_rejection_spike',
        severity: staleRejectRate >= 0.7 ? 4 : 2,
        recommendedState: staleRejectRate >= 0.7 ? 'no_new_entries' : 'reduced_frequency',
        blockNewEntries: staleRejectRate >= 0.7,
        forceReduction: false,
        evidence: {
          staleBookRejectCount: input.staleBookRejectCount,
          totalRecentDecisions: input.totalRecentDecisions,
          staleRejectRate,
        },
      });
    }

    return {
      triggers,
    };
  }
}
