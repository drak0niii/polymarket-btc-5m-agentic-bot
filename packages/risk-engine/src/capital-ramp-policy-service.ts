import type { CapitalRampVerdict } from '@polymarket-btc-5m-agentic-bot/domain';

export class CapitalRampPolicyService {
  evaluate(input: {
    tierAllowsScale: boolean;
    robustnessPassed: boolean;
    chaosPassed: boolean;
    auditCoverageHealthy: boolean;
    attributionCoverage: number;
    promotionScore: number;
    capitalExposureValidated: boolean;
  }): CapitalRampVerdict {
    const reasons: string[] = [];
    if (!input.tierAllowsScale) {
      reasons.push('deployment_tier_blocks_scale');
    }
    if (!input.robustnessPassed) {
      reasons.push('robustness_evidence_missing');
    }
    if (!input.chaosPassed) {
      reasons.push('chaos_harness_not_green');
    }
    if (!input.auditCoverageHealthy) {
      reasons.push('auditability_not_sufficient');
    }
    if (input.attributionCoverage < 0.6) {
      reasons.push('post_trade_attribution_too_thin');
    }
    if (!input.capitalExposureValidated) {
      reasons.push('capital_exposure_validation_missing');
    }

    let stage: CapitalRampVerdict['stage'] = 'frozen';
    let capitalMultiplier = 0;

    if (reasons.length === 0 && input.promotionScore >= 0.8) {
      stage = 'scaled';
      capitalMultiplier = 1;
    } else if (reasons.length === 0 && input.promotionScore >= 0.68) {
      stage = 'limited';
      capitalMultiplier = 0.6;
    } else if (reasons.length === 0 && input.promotionScore >= 0.55) {
      stage = 'canary';
      capitalMultiplier = 0.25;
    }

    return {
      stage,
      allowScaling: reasons.length === 0,
      capitalMultiplier,
      reasons,
    };
  }
}
