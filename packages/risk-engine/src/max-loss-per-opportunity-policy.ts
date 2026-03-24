import type { OpportunityClass } from './trade-frequency-governor';

export interface MaxLossPerOpportunityPolicyInput {
  candidatePositionSize: number;
  bankroll: number;
  availableCapital: number;
  maxPerTradeRiskPct: number;
  opportunityClass: OpportunityClass;
  signalConfidence: number;
}

export interface MaxLossPerOpportunityPolicyDecision {
  maxAllowedPositionSize: number;
  maxLossBudget: number;
  blockTrade: boolean;
  reasons: string[];
  evidence: Record<string, unknown>;
}

export class MaxLossPerOpportunityPolicy {
  evaluate(input: MaxLossPerOpportunityPolicyInput): MaxLossPerOpportunityPolicyDecision {
    const baseRiskBudget = Math.max(
      0,
      Math.min(input.availableCapital, input.bankroll * (input.maxPerTradeRiskPct / 100)),
    );
    const opportunityFactor =
      input.opportunityClass === 'strong_edge'
        ? 1
        : input.opportunityClass === 'tradable_edge'
          ? 0.8
          : input.opportunityClass === 'marginal_edge'
            ? 0.45
            : 0.15;
    const confidenceFactor = clamp(input.signalConfidence, 0.2, 1);
    const maxAllowedPositionSize = Math.max(
      0,
      baseRiskBudget * opportunityFactor * confidenceFactor,
    );
    const reasons: string[] = [];
    if (input.opportunityClass === 'marginal_edge' || input.opportunityClass === 'weak_edge') {
      reasons.push('opportunity_quality_caps_loss_budget');
    }
    if (confidenceFactor < 0.6) {
      reasons.push('signal_confidence_caps_loss_budget');
    }
    if (maxAllowedPositionSize <= 0) {
      reasons.push('max_loss_budget_exhausted');
    } else if (input.candidatePositionSize > maxAllowedPositionSize) {
      reasons.push('candidate_size_exceeds_max_loss_budget');
    }

    return {
      maxAllowedPositionSize,
      maxLossBudget: maxAllowedPositionSize,
      blockTrade: maxAllowedPositionSize <= 0,
      reasons,
      evidence: {
        candidatePositionSize: input.candidatePositionSize,
        bankroll: input.bankroll,
        availableCapital: input.availableCapital,
        maxPerTradeRiskPct: input.maxPerTradeRiskPct,
        opportunityClass: input.opportunityClass,
        signalConfidence: input.signalConfidence,
        baseRiskBudget,
      },
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
