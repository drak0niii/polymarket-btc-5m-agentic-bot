import type {
  HealthLabel,
  NetEdgeBreakdown,
  NetEdgeVenueUncertaintyLabel,
} from '@polymarket-btc-5m-agentic-bot/domain';

export interface NetEdgeThresholdDecision {
  minimumNetEdge: number;
  thresholdMultiplier: number;
  marginAboveThreshold: number;
  passed: boolean;
  reasons: string[];
}

export class NetEdgeThresholdPolicy {
  evaluate(input: {
    baseMinimumNetEdge: number;
    netEdge: NetEdgeBreakdown;
    regimeHealth: HealthLabel | null;
    venueUncertaintyLabel: NetEdgeVenueUncertaintyLabel | null;
  }): NetEdgeThresholdDecision {
    let thresholdMultiplier = 1;
    const reasons: string[] = [];

    if (input.regimeHealth === 'watch') {
      thresholdMultiplier *= 1.1;
      reasons.push('watch_regime_threshold');
    } else if (input.regimeHealth === 'degraded') {
      thresholdMultiplier *= 1.35;
      reasons.push('degraded_regime_threshold');
    } else if (input.regimeHealth === 'quarantine_candidate') {
      thresholdMultiplier *= 1.75;
      reasons.push('quarantine_candidate_regime_threshold');
    }

    if (input.venueUncertaintyLabel === 'degraded') {
      thresholdMultiplier *= 1.25;
      reasons.push('venue_instability_threshold');
    } else if (input.venueUncertaintyLabel === 'unsafe') {
      thresholdMultiplier *= 2;
      reasons.push('unsafe_venue_threshold');
    }

    const minimumNetEdge = input.baseMinimumNetEdge * thresholdMultiplier;
    const marginAboveThreshold = input.netEdge.finalNetEdge - minimumNetEdge;
    if (marginAboveThreshold < 0) {
      reasons.push('below_minimum_net_edge');
    } else if (marginAboveThreshold < Math.max(0.001, minimumNetEdge * 0.25)) {
      reasons.push('low_margin_opportunity');
    }

    return {
      minimumNetEdge,
      thresholdMultiplier,
      marginAboveThreshold,
      passed:
        marginAboveThreshold >= Math.max(0.001, minimumNetEdge * 0.25) &&
        input.netEdge.finalNetEdge > minimumNetEdge,
      reasons,
    };
  }
}
