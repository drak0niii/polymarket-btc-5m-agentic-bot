import type {
  HealthLabel,
  NetEdgeBreakdown,
  NetEdgeVenueUncertaintyLabel,
} from '@polymarket-btc-5m-agentic-bot/domain';
import type { EventMicrostructureFeatures } from './event-microstructure-model';
import type { NetEdgeThresholdDecision } from './net-edge-threshold-policy';
import type { NoTradeReasonCode } from './no-trade/no-trade-classifier';

export type NoTradeZoneReason =
  | 'near_expiry'
  | 'stale_reference'
  | 'stale_orderbook'
  | 'spread_blowout'
  | 'thin_depth'
  | 'microstructure_chaos'
  | 'governance_failed'
  | 'edge_half_life_expired'
  | 'weak_net_edge'
  | 'high_uncertainty'
  | 'poor_calibration'
  | 'poor_regime_health'
  | 'poor_execution_context'
  | 'venue_instability';

export interface NoTradeZoneVerdict {
  blocked: boolean;
  reasons: NoTradeZoneReason[];
  evidenceSummary: {
    empiricalBlockRate: number | null;
    empiricalSampleCount: number | null;
    dominantReasonCodes: NoTradeReasonCode[];
  };
}

export class NoTradeZonePolicy {
  evaluate(input: {
    timeToExpirySeconds: number | null;
    noTradeWindowSeconds: number;
    btcFresh: boolean;
    orderbookFresh: boolean;
    spread: number;
    topLevelDepth: number;
    microstructure: EventMicrostructureFeatures;
    governanceHealthy: boolean;
    edgeHalfLifeHealthy: boolean;
    netEdge?: NetEdgeBreakdown | null;
    thresholdDecision?: NetEdgeThresholdDecision | null;
    calibrationHealth?: HealthLabel | null;
    regimeHealth?: HealthLabel | null;
    executionContextHealthy?: boolean;
    venueUncertaintyLabel?: NetEdgeVenueUncertaintyLabel | null;
    regimeTransitionRisk?: number | null;
    empiricalEvidence?: {
      blockRate?: number | null;
      sampleCount?: number | null;
      dominantReasonCodes?: NoTradeReasonCode[];
    } | null;
  }): NoTradeZoneVerdict {
    const reasons: NoTradeZoneReason[] = [];
    const empiricalBlockRate = finiteOrNull(input.empiricalEvidence?.blockRate);
    const empiricalSampleCount = finiteOrNull(input.empiricalEvidence?.sampleCount);
    const dominantReasonCodes = [
      ...new Set(input.empiricalEvidence?.dominantReasonCodes ?? []),
    ];

    if (
      input.timeToExpirySeconds != null &&
      input.timeToExpirySeconds <= input.noTradeWindowSeconds
    ) {
      reasons.push('near_expiry');
    }

    if (!input.btcFresh) {
      reasons.push('stale_reference');
    }

    if (!input.orderbookFresh) {
      reasons.push('stale_orderbook');
    }

    if (input.spread > 0.05) {
      reasons.push('spread_blowout');
    }

    if (input.topLevelDepth < 20) {
      reasons.push('thin_depth');
    }

    if (
      input.microstructure.decayPressure >= 0.8 ||
      input.microstructure.structureBucket === 'expiry_convex'
    ) {
      reasons.push('microstructure_chaos');
    }

    if (!input.governanceHealthy) {
      reasons.push('governance_failed');
    }

    if (!input.edgeHalfLifeHealthy) {
      reasons.push('edge_half_life_expired');
    }

    if (input.thresholdDecision && !input.thresholdDecision.passed) {
      reasons.push('weak_net_edge');
    }

    if (
      input.netEdge &&
      input.netEdge.uncertaintyPenalty.totalPenalty >=
        Math.max(0.002, input.netEdge.grossForecastEdge * 0.35)
    ) {
      reasons.push('high_uncertainty');
    }

    if (
      input.calibrationHealth === 'quarantine_candidate' ||
      (input.calibrationHealth === 'degraded' &&
        (input.thresholdDecision?.marginAboveThreshold ?? -1) < 0.002)
    ) {
      reasons.push('poor_calibration');
    }

    if (
      input.regimeHealth === 'quarantine_candidate' ||
      (input.regimeHealth === 'degraded' &&
        (input.thresholdDecision?.marginAboveThreshold ?? -1) < 0.002) ||
      ((input.regimeTransitionRisk ?? 0) >= 0.62 &&
        (empiricalBlockRate == null || empiricalBlockRate >= 0.45))
    ) {
      reasons.push('poor_regime_health');
    }

    if (input.executionContextHealthy === false) {
      reasons.push('poor_execution_context');
    }

    if (
      input.venueUncertaintyLabel === 'unsafe' ||
      (input.venueUncertaintyLabel === 'degraded' &&
        (input.thresholdDecision?.marginAboveThreshold ?? 0) < 0.0015)
    ) {
      reasons.push('venue_instability');
    }

    if (
      empiricalSampleCount != null &&
      empiricalSampleCount >= 6 &&
      empiricalBlockRate != null &&
      empiricalBlockRate >= 0.6
    ) {
      if (
        dominantReasonCodes.includes('spread_too_wide') &&
        input.spread > 0.04
      ) {
        reasons.push('spread_blowout');
      }
      if (
        dominantReasonCodes.includes('low_depth') &&
        input.topLevelDepth < 28
      ) {
        reasons.push('thin_depth');
      }
      if (
        dominantReasonCodes.includes('high_toxicity') &&
        input.microstructure.decayPressure >= 0.6
      ) {
        reasons.push('microstructure_chaos');
      }
      if (
        dominantReasonCodes.includes('venue_uncertainty_elevated') &&
        input.venueUncertaintyLabel === 'degraded'
      ) {
        reasons.push('venue_instability');
      }
    }

    return {
      blocked: reasons.length > 0,
      reasons: [...new Set(reasons)],
      evidenceSummary: {
        empiricalBlockRate,
        empiricalSampleCount,
        dominantReasonCodes,
      },
    };
  }
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
