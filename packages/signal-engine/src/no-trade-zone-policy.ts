import type { EventMicrostructureFeatures } from './event-microstructure-model';

export type NoTradeZoneReason =
  | 'near_expiry'
  | 'stale_reference'
  | 'stale_orderbook'
  | 'spread_blowout'
  | 'thin_depth'
  | 'microstructure_chaos'
  | 'governance_failed'
  | 'edge_half_life_expired';

export interface NoTradeZoneVerdict {
  blocked: boolean;
  reasons: NoTradeZoneReason[];
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
  }): NoTradeZoneVerdict {
    const reasons: NoTradeZoneReason[] = [];

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

    return {
      blocked: reasons.length > 0,
      reasons,
    };
  }
}
