export type ExecutionStateAnomalySeverity = 'low' | 'medium' | 'high' | 'critical';

export type ExecutionStateAnomalyReasonCode =
  | 'user_stream_stale_with_live_orders'
  | 'venue_open_orders_disagree_with_local_view'
  | 'repeated_retry_fail_states'
  | 'cancel_acknowledgment_missing_too_long'
  | 'ghost_exposure_after_reconnect'
  | 'locally_filled_absent_from_venue_truth';

export type ExecutionAnomalyRuntimeState =
  | 'running'
  | 'degraded'
  | 'reconciliation_only'
  | 'cancel_only'
  | 'halted_hard';

export interface ExecutionStateAnomaly {
  reasonCode: ExecutionStateAnomalyReasonCode;
  severity: ExecutionStateAnomalySeverity;
  severityScore: number;
  recommendedRuntimeState: ExecutionAnomalyRuntimeState;
  rationale: string;
  evidence: Record<string, number | string | boolean | null>;
}

export interface ExecutionStateAnomalyDetectorInput {
  userStream: {
    stale: boolean;
    liveOrdersWhileStale: boolean;
    connected: boolean;
    reconnectAttempt: number;
    openOrders: number;
    lastTrafficAgeMs: number | null;
    divergenceDetected: boolean;
  };
  venueTruth: {
    disagreementCount: number;
    unresolvedGhostMismatch: boolean;
    lastVenueTruthAgeMs: number | null;
    workingOpenOrders: number;
    cancelPendingTooLongCount: number;
  };
  lifecycle: {
    retryingCount: number;
    failedCount: number;
    ghostExposureDetected: boolean;
    unresolvedIntentCount: number;
    locallyFilledButAbsentCount: number;
    oldestLocallyFilledAbsentAgeMs: number | null;
  };
}

export interface ExecutionStateAnomalyDetectorResult {
  anomalies: ExecutionStateAnomaly[];
  highestSeverity: ExecutionStateAnomalySeverity | null;
  recommendedRuntimeState: ExecutionAnomalyRuntimeState;
  reasonCodes: ExecutionStateAnomalyReasonCode[];
}

export class ExecutionStateAnomalyDetector {
  evaluate(input: ExecutionStateAnomalyDetectorInput): ExecutionStateAnomalyDetectorResult {
    const anomalies: ExecutionStateAnomaly[] = [];

    if (input.userStream.stale && input.userStream.liveOrdersWhileStale) {
      const critical =
        !input.userStream.connected || input.userStream.reconnectAttempt >= 2;
      anomalies.push({
        reasonCode: 'user_stream_stale_with_live_orders',
        severity: critical ? 'critical' : 'high',
        severityScore: critical ? 95 : 78,
        recommendedRuntimeState: critical ? 'cancel_only' : 'reconciliation_only',
        rationale:
          'User stream is stale while live orders still exist, so execution truth cannot be trusted for new entries.',
        evidence: {
          openOrders: input.userStream.openOrders,
          reconnectAttempt: input.userStream.reconnectAttempt,
          lastTrafficAgeMs: input.userStream.lastTrafficAgeMs,
          connected: input.userStream.connected,
        },
      });
    }

    if (input.venueTruth.disagreementCount > 0 || input.userStream.divergenceDetected) {
      const severe = input.venueTruth.disagreementCount >= 3 || input.venueTruth.unresolvedGhostMismatch;
      anomalies.push({
        reasonCode: 'venue_open_orders_disagree_with_local_view',
        severity: severe ? 'high' : 'medium',
        severityScore: severe ? 82 : 58,
        recommendedRuntimeState: severe ? 'cancel_only' : 'reconciliation_only',
        rationale:
          'Venue open-order truth and local/open-stream views disagree enough to undermine normal order management.',
        evidence: {
          disagreementCount: input.venueTruth.disagreementCount,
          unresolvedGhostMismatch: input.venueTruth.unresolvedGhostMismatch,
          lastVenueTruthAgeMs: input.venueTruth.lastVenueTruthAgeMs,
          divergenceDetected: input.userStream.divergenceDetected,
        },
      });
    }

    const retryFailCount = input.lifecycle.retryingCount + input.lifecycle.failedCount;
    if (retryFailCount >= 3) {
      anomalies.push({
        reasonCode: 'repeated_retry_fail_states',
        severity: retryFailCount >= 6 ? 'high' : 'medium',
        severityScore: retryFailCount >= 6 ? 76 : 52,
        recommendedRuntimeState: retryFailCount >= 6 ? 'cancel_only' : 'reconciliation_only',
        rationale:
          'Repeated retry/failure states indicate the execution path is cycling without trustworthy completion.',
        evidence: {
          retryingCount: input.lifecycle.retryingCount,
          failedCount: input.lifecycle.failedCount,
          retryFailCount,
        },
      });
    }

    if (input.venueTruth.cancelPendingTooLongCount > 0) {
      const severe = input.venueTruth.cancelPendingTooLongCount >= 2;
      anomalies.push({
        reasonCode: 'cancel_acknowledgment_missing_too_long',
        severity: severe ? 'high' : 'medium',
        severityScore: severe ? 74 : 49,
        recommendedRuntimeState: severe ? 'cancel_only' : 'reconciliation_only',
        rationale:
          'Cancel acknowledgments are missing beyond the allowed grace window, so repost behavior should not continue normally.',
        evidence: {
          cancelPendingTooLongCount: input.venueTruth.cancelPendingTooLongCount,
          workingOpenOrders: input.venueTruth.workingOpenOrders,
        },
      });
    }

    if (input.lifecycle.ghostExposureDetected || input.lifecycle.unresolvedIntentCount > 0) {
      const critical = input.lifecycle.unresolvedIntentCount > 0;
      anomalies.push({
        reasonCode: 'ghost_exposure_after_reconnect',
        severity: critical ? 'critical' : 'high',
        severityScore: critical ? 99 : 79,
        recommendedRuntimeState: critical ? 'halted_hard' : 'cancel_only',
        rationale:
          'Ghost exposure or unresolved intents remain after reconnect, so the bot must fail closed on new execution.',
        evidence: {
          ghostExposureDetected: input.lifecycle.ghostExposureDetected,
          unresolvedIntentCount: input.lifecycle.unresolvedIntentCount,
        },
      });
    }

    if (
      input.lifecycle.locallyFilledButAbsentCount > 0 &&
      (input.lifecycle.oldestLocallyFilledAbsentAgeMs ?? 0) >= 30_000
    ) {
      const severe = input.lifecycle.locallyFilledButAbsentCount >= 2;
      anomalies.push({
        reasonCode: 'locally_filled_absent_from_venue_truth',
        severity: severe ? 'critical' : 'high',
        severityScore: severe ? 92 : 72,
        recommendedRuntimeState: severe ? 'halted_hard' : 'reconciliation_only',
        rationale:
          'Locally filled orders remain absent from venue truth too long, so fill finality cannot be trusted.',
        evidence: {
          locallyFilledButAbsentCount: input.lifecycle.locallyFilledButAbsentCount,
          oldestLocallyFilledAbsentAgeMs: input.lifecycle.oldestLocallyFilledAbsentAgeMs,
        },
      });
    }

    return summarizeExecutionStateAnomalies(anomalies);
  }
}

export function summarizeExecutionStateAnomalies(
  anomalies: ExecutionStateAnomaly[],
): ExecutionStateAnomalyDetectorResult {
  const highestSeverity = highestSeverityLabel(anomalies);
  const reasonCodes = anomalies.map((anomaly) => anomaly.reasonCode);
  const recommendedRuntimeState = deriveRuntimeState(anomalies);

  return {
    anomalies,
    highestSeverity,
    recommendedRuntimeState,
    reasonCodes,
  };
}

function highestSeverityLabel(
  anomalies: ExecutionStateAnomaly[],
): ExecutionStateAnomalySeverity | null {
  if (anomalies.length === 0) {
    return null;
  }
  return [...anomalies]
    .sort((left, right) => severityPriority(right.severity) - severityPriority(left.severity))[0]
    ?.severity ?? null;
}

function deriveRuntimeState(
  anomalies: ExecutionStateAnomaly[],
): ExecutionAnomalyRuntimeState {
  if (anomalies.length === 0) {
    return 'running';
  }
  if (anomalies.some((anomaly) => anomaly.recommendedRuntimeState === 'halted_hard')) {
    return 'halted_hard';
  }
  if (anomalies.filter((anomaly) => anomaly.severity === 'critical').length >= 2) {
    return 'halted_hard';
  }
  if (anomalies.some((anomaly) => anomaly.recommendedRuntimeState === 'cancel_only')) {
    return 'cancel_only';
  }
  if (anomalies.some((anomaly) => anomaly.recommendedRuntimeState === 'reconciliation_only')) {
    return 'reconciliation_only';
  }
  return 'degraded';
}

function severityPriority(severity: ExecutionStateAnomalySeverity): number {
  switch (severity) {
    case 'low':
      return 1;
    case 'medium':
      return 2;
    case 'high':
      return 3;
    case 'critical':
      return 4;
  }
}
