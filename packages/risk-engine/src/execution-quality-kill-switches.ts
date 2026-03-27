import { KillSwitchTrigger } from './kill-switch';

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
  abnormalCancelLatencyCount?: number;
  repeatedPartialFillToxicityCount?: number;
  fillQualityDriftCount?: number;
  realizedVsExpectedCostBlowoutCount?: number;
}

export interface ExecutionQualityTrigger extends KillSwitchTrigger {
  family:
    | 'fill_quality'
    | 'post_failures'
    | 'cancel_failures'
    | 'heartbeat_failures'
    | 'divergence'
    | 'stale_book'
    | 'cancel_latency'
    | 'partial_fill_toxicity'
    | 'fill_quality_drift'
    | 'cost_blowout';
  triggerName: string;
  rationale: string;
  recommendedAction:
    | 'observe'
    | 'reduced_frequency'
    | 'passive_only'
    | 'no_new_entries'
    | 'reconciliation_only'
    | 'cancel_only'
    | 'halted_hard';
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
      triggers.push(
        trigger({
          family: 'fill_quality',
          triggerName: 'fill_quality_deterioration',
          reasonCode: 'fill_quality_deterioration',
          severity,
          recommendedState: severity >= 5 ? 'halt' : 'passive_only',
          recommendedAction: severity >= 5 ? 'halted_hard' : 'passive_only',
          blockNewEntries: true,
          forceReduction: severity >= 5,
          rationale:
            'Realized slippage has drifted materially above expected slippage across recent fills.',
          evidence: {
            sampleCount: slippageDriftDiagnostics.length,
          },
        }),
      );
    }

    if (input.postFailureCount >= 2) {
      const severity = input.postFailureCount >= 6 ? 5 : input.postFailureCount >= 4 ? 4 : 2;
      triggers.push(
        trigger({
          family: 'post_failures',
          triggerName: 'post_failure_pressure',
          reasonCode: 'post_failure_pressure',
          severity,
          recommendedState:
            severity >= 5 ? 'halt' : severity >= 4 ? 'no_new_entries' : 'reduced_frequency',
          recommendedAction:
            severity >= 5
              ? 'halted_hard'
              : severity >= 4
                ? 'reconciliation_only'
                : 'reduced_frequency',
          blockNewEntries: severity >= 4,
          forceReduction: false,
          rationale: 'Repeated post failures indicate the venue submit path is degraded.',
          evidence: {
            postFailureCount: input.postFailureCount,
          },
        }),
      );
    }

    if (input.cancelFailureCount >= 1) {
      const severity =
        input.cancelFailuresWithWorkingOrders >= 3
          ? 5
          : input.cancelFailuresWithWorkingOrders >= 1 || input.cancelFailureCount >= 3
            ? 4
            : 3;
      triggers.push(
        trigger({
          family: 'cancel_failures',
          triggerName: 'cancel_failure_pressure',
          reasonCode: 'cancel_failure_pressure',
          severity,
          recommendedState:
            severity >= 5 ? 'halt' : severity >= 4 ? 'no_new_entries' : 'passive_only',
          recommendedAction:
            severity >= 5
              ? 'halted_hard'
              : severity >= 4
                ? 'cancel_only'
                : 'passive_only',
          blockNewEntries: true,
          forceReduction: severity >= 5,
          rationale:
            'Cancel failures with active orders mean stale exposure may persist beyond intended risk bounds.',
          evidence: {
            cancelFailureCount: input.cancelFailureCount,
            cancelFailuresWithWorkingOrders: input.cancelFailuresWithWorkingOrders,
          },
        }),
      );
    }

    if ((input.abnormalCancelLatencyCount ?? 0) >= 1) {
      const count = input.abnormalCancelLatencyCount ?? 0;
      triggers.push(
        trigger({
          family: 'cancel_latency',
          triggerName: 'abnormal_cancel_latency',
          reasonCode: 'abnormal_cancel_latency',
          severity: count >= 3 ? 4 : 3,
          recommendedState: count >= 3 ? 'no_new_entries' : 'passive_only',
          recommendedAction: count >= 3 ? 'cancel_only' : 'passive_only',
          blockNewEntries: count >= 3,
          forceReduction: false,
          rationale:
            'Cancel acknowledgments are arriving too slowly, so repeated repost behavior should be avoided.',
          evidence: {
            abnormalCancelLatencyCount: count,
          },
        }),
      );
    }

    if ((input.repeatedPartialFillToxicityCount ?? 0) >= 2) {
      const count = input.repeatedPartialFillToxicityCount ?? 0;
      triggers.push(
        trigger({
          family: 'partial_fill_toxicity',
          triggerName: 'repeated_partial_fill_toxicity',
          reasonCode: 'repeated_partial_fill_toxicity',
          severity: count >= 4 ? 5 : 3,
          recommendedState: count >= 4 ? 'halt' : 'no_new_entries',
          recommendedAction: count >= 4 ? 'halted_hard' : 'reconciliation_only',
          blockNewEntries: true,
          forceReduction: count >= 4,
          rationale:
            'Recent partial fills are repeatedly followed by toxic short-horizon drift, indicating adverse selection pressure.',
          evidence: {
            repeatedPartialFillToxicityCount: count,
          },
        }),
      );
    }

    if ((input.fillQualityDriftCount ?? 0) >= 2) {
      const count = input.fillQualityDriftCount ?? 0;
      triggers.push(
        trigger({
          family: 'fill_quality_drift',
          triggerName: 'fill_quality_drift',
          reasonCode: 'fill_quality_drift',
          severity: count >= 4 ? 4 : 3,
          recommendedState: count >= 4 ? 'no_new_entries' : 'passive_only',
          recommendedAction: count >= 4 ? 'reconciliation_only' : 'passive_only',
          blockNewEntries: count >= 4,
          forceReduction: false,
          rationale:
            'Observed fill quality has drifted enough from expected behavior to require more conservative execution.',
          evidence: {
            fillQualityDriftCount: count,
          },
        }),
      );
    }

    if ((input.realizedVsExpectedCostBlowoutCount ?? 0) >= 2) {
      const count = input.realizedVsExpectedCostBlowoutCount ?? 0;
      triggers.push(
        trigger({
          family: 'cost_blowout',
          triggerName: 'realized_vs_expected_cost_blowout',
          reasonCode: 'realized_vs_expected_cost_blowout',
          severity: count >= 4 ? 5 : 4,
          recommendedState: count >= 4 ? 'halt' : 'no_new_entries',
          recommendedAction: count >= 4 ? 'halted_hard' : 'cancel_only',
          blockNewEntries: true,
          forceReduction: true,
          rationale:
            'Realized execution costs are materially worse than expected often enough to invalidate normal order submission.',
          evidence: {
            realizedVsExpectedCostBlowoutCount: count,
          },
        }),
      );
    }

    if (input.heartbeatFailuresWithOpenOrders >= 1) {
      const severity = input.heartbeatFailuresWithOpenOrders >= 2 ? 5 : 4;
      triggers.push(
        trigger({
          family: 'heartbeat_failures',
          triggerName: 'heartbeat_failed_with_open_orders',
          reasonCode: 'heartbeat_failed_with_open_orders',
          severity,
          recommendedState: severity >= 5 ? 'halt' : 'no_new_entries',
          recommendedAction: severity >= 5 ? 'halted_hard' : 'reconciliation_only',
          blockNewEntries: true,
          forceReduction: severity >= 5,
          rationale:
            'Venue heartbeat failed while open orders were live, so execution truth freshness cannot be trusted.',
          evidence: {
            heartbeatFailuresWithOpenOrders: input.heartbeatFailuresWithOpenOrders,
          },
        }),
      );
    }

    if (input.divergenceStatus !== 'none') {
      const severity = input.divergenceStatus === 'critical' ? 5 : 3;
      triggers.push(
        trigger({
          family: 'divergence',
          triggerName:
            input.divergenceStatus === 'critical'
              ? 'venue_local_divergence_critical'
              : 'venue_local_divergence_warning',
          reasonCode:
            input.divergenceStatus === 'critical'
              ? 'venue_local_divergence_critical'
              : 'venue_local_divergence_warning',
          severity,
          recommendedState:
            input.divergenceStatus === 'critical' ? 'halt' : 'no_new_entries',
          recommendedAction:
            input.divergenceStatus === 'critical'
              ? 'halted_hard'
              : 'reconciliation_only',
          blockNewEntries: true,
          forceReduction: input.divergenceStatus === 'critical',
          rationale:
            'Local and venue execution truth are diverging beyond the allowed tolerance.',
          evidence: {
            divergenceStatus: input.divergenceStatus,
          },
        }),
      );
    }

    const staleRejectRate =
      input.totalRecentDecisions > 0
        ? input.staleBookRejectCount / input.totalRecentDecisions
        : 0;
    if (input.staleBookRejectCount >= 3 && staleRejectRate >= 0.4) {
      triggers.push(
        trigger({
          family: 'stale_book',
          triggerName: 'stale_book_rejection_spike',
          reasonCode: 'stale_book_rejection_spike',
          severity: staleRejectRate >= 0.7 ? 4 : 2,
          recommendedState: staleRejectRate >= 0.7 ? 'no_new_entries' : 'reduced_frequency',
          recommendedAction:
            staleRejectRate >= 0.7 ? 'reconciliation_only' : 'reduced_frequency',
          blockNewEntries: staleRejectRate >= 0.7,
          forceReduction: false,
          rationale:
            'A large share of recent decisions were rejected due to stale book state, indicating execution truth degradation.',
          evidence: {
            staleBookRejectCount: input.staleBookRejectCount,
            totalRecentDecisions: input.totalRecentDecisions,
            staleRejectRate,
          },
        }),
      );
    }

    return {
      triggers,
    };
  }
}

function trigger(
  input: Omit<ExecutionQualityTrigger, 'family' | 'triggerName' | 'rationale' | 'recommendedAction'> & {
    family: ExecutionQualityTrigger['family'];
    triggerName: string;
    rationale: string;
    recommendedAction: ExecutionQualityTrigger['recommendedAction'];
  },
): ExecutionQualityTrigger {
  return input;
}
