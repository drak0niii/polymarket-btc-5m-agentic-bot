import type {
  RegimeProfitabilityAssessment,
  RegimeProfitabilityRank,
} from './regime-profitability-ranker';

export type RegimeCapitalTreatment =
  | 'elevated_capital'
  | 'normal_capital'
  | 'reduced_capital'
  | 'blocked_capital';

export interface RegimeCapitalPolicyDecision {
  treatment: RegimeCapitalTreatment;
  capitalMultiplier: number;
  trustCapMultiplier: number;
  blockNewTrades: boolean;
  reasons: string[];
  evidence: Record<string, unknown>;
}

export class RegimeCapitalPolicy {
  decide(input: {
    assessment: RegimeProfitabilityAssessment;
    portfolioAllocationMultiplier?: number | null;
    trustScore?: number | null;
    evidenceQualityMultiplier?: number | null;
  }): RegimeCapitalPolicyDecision {
    const treatment = treatmentForRank(input.assessment.rank, input.assessment.score);
    const baseMultiplier =
      treatment === 'elevated_capital'
        ? input.assessment.score >= 0.9
          ? 1.15
          : 1.05
        : treatment === 'normal_capital'
          ? 1
          : treatment === 'reduced_capital'
            ? 0.45
            : 0;
    const trustCapMultiplier = Math.max(
      0,
      Math.min(1, input.evidenceQualityMultiplier ?? trustCapForScore(input.trustScore ?? null)),
    );
    const capitalMultiplier = Math.max(0, Math.min(baseMultiplier, trustCapMultiplier));

    return {
      treatment,
      capitalMultiplier,
      trustCapMultiplier,
      blockNewTrades: capitalMultiplier <= 0.01,
      reasons: [
        `regime_rank_${input.assessment.rank}`,
        `regime_capital_${treatment}`,
        ...(trustCapMultiplier < baseMultiplier ? ['regime_trust_cap_applied'] : []),
        ...(input.portfolioAllocationMultiplier != null &&
        input.portfolioAllocationMultiplier < 1
          ? ['portfolio_allocation_already_reduced']
          : []),
      ],
      evidence: {
        assessment: input.assessment,
        portfolioAllocationMultiplier: input.portfolioAllocationMultiplier ?? null,
        trustScore: input.trustScore ?? null,
        evidenceQualityMultiplier: input.evidenceQualityMultiplier ?? null,
        baseMultiplier,
        trustCapMultiplier,
      },
    };
  }
}

function treatmentForRank(
  rank: RegimeProfitabilityRank,
  score: number,
): RegimeCapitalTreatment {
  if (rank === 'strong_regime') {
    return score >= 0.88 ? 'elevated_capital' : 'normal_capital';
  }
  if (rank === 'tradable_regime') {
    return 'normal_capital';
  }
  if (rank === 'marginal_regime') {
    return 'reduced_capital';
  }
  return 'blocked_capital';
}

function trustCapForScore(trustScore: number | null): number {
  if (trustScore == null) {
    return 0.5;
  }
  if (trustScore < 0.25) {
    return 0;
  }
  if (trustScore < 0.45) {
    return 0.25;
  }
  if (trustScore < 0.65) {
    return 0.5;
  }
  if (trustScore < 0.8) {
    return 0.75;
  }
  return 1;
}
