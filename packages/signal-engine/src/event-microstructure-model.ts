import type { SignalFeatures } from './feature-builder';

export interface EventMicrostructureFeatures {
  boundaryDistance: number;
  boundaryTension: number;
  expiryConvexity: number;
  liquidityClusterScore: number;
  venueMispricingScore: number;
  crowdLagScore: number;
  decayPressure: number;
  structureBucket: 'balanced' | 'boundary_stressed' | 'depth_thin' | 'expiry_convex';
  eventType: 'binary_event_contract';
  computedAt: string;
}

export class EventMicrostructureModel {
  derive(input: {
    features: SignalFeatures;
    posteriorProbability: number;
    marketImpliedProbability: number;
  }): EventMicrostructureFeatures {
    const boundaryDistance = Math.abs(
      input.posteriorProbability - input.marketImpliedProbability,
    );
    const boundaryTension = clamp01(1 - boundaryDistance / 0.12);
    const expiryConvexity =
      input.features.timeToExpirySeconds == null
        ? 0
        : clamp01(1 - input.features.timeToExpirySeconds / 300);
    const liquidityClusterScore = clamp01(
      input.features.depthConcentration * 0.7 +
        Math.max(0, 0.03 - input.features.spread) * 8,
    );
    const venueMispricingScore = clamp01(
      Math.abs(input.features.micropriceBias) * 3.2 +
        Math.abs(input.features.midpointDriftPct - input.features.lastReturnPct) * 110,
    );
    const crowdLagScore = clamp01(
      Math.abs(input.features.rollingReturnPct - input.features.midpointDriftPct) * 65 +
        Math.max(0, input.features.volumeTrend) * 0.2,
    );
    const decayPressure = clamp01(
      expiryConvexity * 0.45 +
        input.features.orderbookNoiseScore * 0.35 +
        Math.max(0, input.features.spread - 0.02) * 8,
    );

    let structureBucket: EventMicrostructureFeatures['structureBucket'] = 'balanced';
    if (expiryConvexity >= 0.75) {
      structureBucket = 'expiry_convex';
    } else if (boundaryTension >= 0.7) {
      structureBucket = 'boundary_stressed';
    } else if (input.features.topLevelDepth < 20 || input.features.spread > 0.03) {
      structureBucket = 'depth_thin';
    }

    return {
      boundaryDistance,
      boundaryTension,
      expiryConvexity,
      liquidityClusterScore,
      venueMispricingScore,
      crowdLagScore,
      decayPressure,
      structureBucket,
      eventType: 'binary_event_contract',
      computedAt: new Date().toISOString(),
    };
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}
