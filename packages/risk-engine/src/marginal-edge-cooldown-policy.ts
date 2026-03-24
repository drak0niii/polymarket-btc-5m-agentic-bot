import type { OpportunityClass } from './trade-frequency-governor';

export type MarginalEdgeCooldownSeverity = 'none' | 'watch' | 'active';

export interface MarginalEdgeCooldownDecision {
  severity: MarginalEdgeCooldownSeverity;
  cooldownActive: boolean;
  blockTrade: boolean;
  sizeMultiplier: number;
  reasons: string[];
  evidence: Record<string, unknown>;
}

export class MarginalEdgeCooldownPolicy {
  evaluate(input: {
    opportunityClass: OpportunityClass;
    marginAboveThreshold: number;
    recentMarginalApprovalCount: number;
    recentMarginalAttemptCount: number;
    recentLowQualityTradeShare: number;
  }): MarginalEdgeCooldownDecision {
    if (input.opportunityClass === 'strong_edge' && input.marginAboveThreshold >= 0.004) {
      return {
        severity: 'none',
        cooldownActive: false,
        blockTrade: false,
        sizeMultiplier: 1,
        reasons: ['marginal_edge_cooldown_not_applicable'],
        evidence: input,
      };
    }

    if (
      input.marginAboveThreshold <= 0.0015 &&
      input.recentMarginalApprovalCount >= 2 &&
      (input.recentMarginalAttemptCount >= 4 || input.recentLowQualityTradeShare >= 0.35)
    ) {
      return {
        severity: 'active',
        cooldownActive: true,
        blockTrade: true,
        sizeMultiplier: 0,
        reasons: ['repeated_marginal_edge_activity_detected'],
        evidence: input,
      };
    }

    if (
      input.marginAboveThreshold <= 0.003 &&
      (input.recentMarginalApprovalCount >= 1 || input.recentLowQualityTradeShare >= 0.25)
    ) {
      return {
        severity: 'watch',
        cooldownActive: true,
        blockTrade: false,
        sizeMultiplier: 0.5,
        reasons: ['marginal_edge_activity_under_cooldown_watch'],
        evidence: input,
      };
    }

    return {
      severity: 'none',
      cooldownActive: false,
      blockTrade: false,
      sizeMultiplier: 1,
      reasons: ['marginal_edge_cooldown_not_triggered'],
      evidence: input,
    };
  }
}
