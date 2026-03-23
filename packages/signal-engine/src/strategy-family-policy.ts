import type { EventMicrostructureFeatures } from './event-microstructure-model';
import type { SignalFeatures } from './feature-builder';
import type { RegimeClassification } from './regime-classifier';

export type StrategyFamily =
  | 'momentum_continuation'
  | 'mean_reversion_after_overshoot'
  | 'volatility_expansion'
  | 'expiry_window_behavior'
  | 'spread_liquidity_opportunism';

export interface StrategyFamilyVerdict {
  family: StrategyFamily;
  version: string;
  confidence: number;
  allowed: boolean;
  reasons: string[];
}

export class StrategyFamilyPolicy {
  classify(input: {
    regime: RegimeClassification;
    features: SignalFeatures;
    microstructure: EventMicrostructureFeatures;
  }): StrategyFamilyVerdict {
    if (input.microstructure.expiryConvexity >= 0.65) {
      return {
        family: 'expiry_window_behavior',
        version: 'expiry-window-v1',
        confidence: clamp01(0.62 + input.microstructure.expiryConvexity * 0.25),
        allowed: input.regime.tradingAllowed,
        reasons: ['expiry_convexity_dominates'],
      };
    }

    if (
      input.features.realizedVolatility >= 0.003 ||
      input.microstructure.venueMispricingScore >= 0.55
    ) {
      return {
        family: 'volatility_expansion',
        version: 'vol-expansion-v1',
        confidence: clamp01(0.58 + input.features.realizedVolatility * 40),
        allowed: input.regime.tradingAllowed,
        reasons: ['volatility_regime'],
      };
    }

    if (
      input.features.spread <= 0.02 &&
      input.features.topLevelDepth >= 40 &&
      input.microstructure.liquidityClusterScore >= 0.45
    ) {
      return {
        family: 'spread_liquidity_opportunism',
        version: 'spread-liquidity-v1',
        confidence: clamp01(0.55 + input.microstructure.liquidityClusterScore * 0.25),
        allowed: input.regime.tradingAllowed,
        reasons: ['depth_supportive'],
      };
    }

    if (
      Math.abs(input.features.lastReturnPct) > 0.003 &&
      Math.sign(input.features.lastReturnPct) !==
        Math.sign(input.features.rollingReturnPct || 0)
    ) {
      return {
        family: 'mean_reversion_after_overshoot',
        version: 'overshoot-revert-v1',
        confidence: clamp01(0.56 + Math.abs(input.features.lastReturnPct) * 20),
        allowed: input.regime.tradingAllowed,
        reasons: ['overshoot_detected'],
      };
    }

    return {
      family: 'momentum_continuation',
      version: 'momentum-v1',
      confidence: clamp01(0.55 + Math.abs(input.features.rollingReturnPct) * 25),
      allowed: input.regime.tradingAllowed,
      reasons: ['trend_following_base_case'],
    };
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}
