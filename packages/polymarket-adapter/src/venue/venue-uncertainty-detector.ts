import type { VenueUncertaintyLabel } from '@polymarket-btc-5m-agentic-bot/domain';
import type { VenueHealthMetrics } from './venue-health-learning-store';

export interface VenueUncertaintyAssessment {
  label: VenueUncertaintyLabel;
  reasons: string[];
  evidence: Record<string, unknown>;
}

export class VenueUncertaintyDetector {
  evaluate(metrics: VenueHealthMetrics): VenueUncertaintyAssessment {
    const reasons: string[] = [];
    const failureRate = metrics.requestFailures.failureRate;
    const p90LatencyMs = metrics.latencyDistribution.p90Ms ?? 0;
    const staleAverageMs = metrics.staleDataIntervals.averageMs ?? 0;
    const openOrderVisibilityLagMs = metrics.openOrderVisibilityLag.p90Ms ?? 0;
    const tradeVisibilityLagMs = metrics.tradeVisibilityLag.p90Ms ?? 0;
    const cancelAcknowledgmentLagMs = metrics.cancelAcknowledgmentLag.p90Ms ?? 0;

    let label: VenueUncertaintyLabel = 'healthy';

    if (
      failureRate >= 0.2 ||
      staleAverageMs >= 30_000 ||
      openOrderVisibilityLagMs >= 20_000 ||
      tradeVisibilityLagMs >= 15_000
    ) {
      label = 'unsafe';
    } else if (
      failureRate >= 0.08 ||
      p90LatencyMs >= 4_000 ||
      staleAverageMs >= 8_000 ||
      openOrderVisibilityLagMs >= 8_000 ||
      tradeVisibilityLagMs >= 5_000 ||
      cancelAcknowledgmentLagMs >= 10_000
    ) {
      label = 'degraded';
    }

    if (failureRate >= 0.2) {
      reasons.push('request_failure_rate_unsafe');
    } else if (failureRate >= 0.08) {
      reasons.push('request_failure_rate_elevated');
    }
    if (p90LatencyMs >= 4_000) {
      reasons.push('latency_distribution_elevated');
    }
    if (staleAverageMs >= 30_000) {
      reasons.push('stale_data_interval_unsafe');
    } else if (staleAverageMs >= 8_000) {
      reasons.push('stale_data_interval_elevated');
    }
    if (openOrderVisibilityLagMs >= 20_000) {
      reasons.push('open_order_visibility_lag_unsafe');
    } else if (openOrderVisibilityLagMs >= 8_000) {
      reasons.push('open_order_visibility_lag_elevated');
    }
    if (tradeVisibilityLagMs >= 15_000) {
      reasons.push('trade_visibility_lag_unsafe');
    } else if (tradeVisibilityLagMs >= 5_000) {
      reasons.push('trade_visibility_lag_elevated');
    }
    if (cancelAcknowledgmentLagMs >= 10_000) {
      reasons.push('cancel_acknowledgment_lag_elevated');
    }
    if (reasons.length === 0) {
      reasons.push('venue_metrics_within_limits');
    }

    return {
      label,
      reasons,
      evidence: {
        failureRate,
        p90LatencyMs,
        staleAverageMs,
        openOrderVisibilityLagMs,
        tradeVisibilityLagMs,
        cancelAcknowledgmentLagMs,
      },
    };
  }
}
