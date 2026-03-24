export interface PromotionStabilityContextShare {
  contextKey: string;
  realizedContribution: number;
  sampleCount: number;
  realizedVsExpected: number | null;
}

export interface PromotionStabilityCheckInput {
  sampleCount: number;
  realizedVsExpected: number | null;
  stabilityAdjustedCapitalGrowthScore: number | null;
  contextShares: PromotionStabilityContextShare[];
  realizedReturns: number[];
}

export interface PromotionStabilityCheckDecision {
  stable: boolean;
  reasons: string[];
  evidence: Record<string, unknown>;
}

export class PromotionStabilityCheck {
  evaluate(input: PromotionStabilityCheckInput): PromotionStabilityCheckDecision {
    const reasons: string[] = [];
    const concentrationShare = maxShare(
      input.contextShares.map((context) => Math.max(0, context.realizedContribution)),
    );
    const sampleConcentrationShare = maxShare(
      input.contextShares.map((context) => Math.max(0, context.sampleCount)),
    );
    const evConsistency = consistencyScore(
      input.contextShares
        .map((context) => context.realizedVsExpected)
        .filter((value): value is number => value != null && Number.isFinite(value)),
    );
    const returnVariance = variance(input.realizedReturns);

    if (concentrationShare > 0.72 || sampleConcentrationShare > 0.75) {
      reasons.push('promotion_context_concentration_excessive');
    }
    if (concentrationShare > 0.62) {
      reasons.push('promotion_luck_cluster_concentrated');
    }
    if (evConsistency < 0.55) {
      reasons.push('promotion_ev_consistency_weak');
    }
    if (returnVariance > 0.0015 && (input.realizedVsExpected ?? 0) < 1) {
      reasons.push('promotion_variance_without_retention');
    }
    if ((input.stabilityAdjustedCapitalGrowthScore ?? 0) < 0.62) {
      reasons.push('promotion_capital_growth_fragile');
    }

    return {
      stable: reasons.length === 0,
      reasons: reasons.length > 0 ? reasons : ['promotion_stability_confirmed'],
      evidence: {
        sampleCount: input.sampleCount,
        realizedVsExpected: input.realizedVsExpected,
        stabilityAdjustedCapitalGrowthScore: input.stabilityAdjustedCapitalGrowthScore,
        concentrationShare,
        sampleConcentrationShare,
        evConsistency,
        returnVariance,
        contextShares: input.contextShares,
      },
    };
  }
}

function maxShare(weights: number[]): number {
  const total = weights.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0) {
    return 0;
  }
  return weights.reduce((max, value) => Math.max(max, Math.max(0, value) / total), 0);
}

function consistencyScore(values: number[]): number {
  if (values.length === 0) {
    return 0.4;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const stddev = Math.sqrt(
    values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length,
  );
  return clamp(1 - stddev / Math.max(0.25, Math.abs(mean)), 0, 1);
}

function variance(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
