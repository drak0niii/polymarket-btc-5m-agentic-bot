export type OpportunitySaturationLabel = 'normal' | 'watch' | 'saturated';

export interface OpportunitySaturationDecision {
  label: OpportunitySaturationLabel;
  blockTrade: boolean;
  sizeMultiplier: number;
  reasons: string[];
  evidence: Record<string, unknown>;
}

export class OpportunitySaturationDetector {
  evaluate(input: {
    recentApprovedCount: number;
    recentStrongApprovalCount: number;
    recentMarginalApprovalCount: number;
    recentWeakRejectCount: number;
    recentAverageMarginAboveThreshold: number | null;
    recentTradeQualityScore: number | null;
    recentCapitalLeakageShare: number | null;
  }): OpportunitySaturationDecision {
    const forcingActivity =
      input.recentMarginalApprovalCount > input.recentStrongApprovalCount &&
      input.recentWeakRejectCount >= 3;
    const weakEconomics =
      (input.recentAverageMarginAboveThreshold ?? 0) < 0.002 &&
      ((input.recentTradeQualityScore ?? 1) < 0.55 ||
        (input.recentCapitalLeakageShare ?? 0) >= 0.3);

    if (forcingActivity && weakEconomics && input.recentApprovedCount >= 3) {
      return {
        label: 'saturated',
        blockTrade: true,
        sizeMultiplier: 0,
        reasons: ['opportunity_flow_looks_forced_not_selective'],
        evidence: input,
      };
    }

    if (forcingActivity || weakEconomics) {
      return {
        label: 'watch',
        blockTrade: false,
        sizeMultiplier: 0.65,
        reasons: ['opportunity_flow_showing_saturation_pressure'],
        evidence: input,
      };
    }

    return {
      label: 'normal',
      blockTrade: false,
      sizeMultiplier: 1,
      reasons: ['opportunity_flow_selective'],
      evidence: input,
    };
  }
}
