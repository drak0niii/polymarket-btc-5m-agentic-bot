import type { CapitalRampVerdict } from '@polymarket-btc-5m-agentic-bot/domain';

export class CapitalRampPolicyService {
  evaluate(input: {
    tierAllowsScale: boolean;
    robustnessPassed?: boolean;
    chaosPassed?: boolean;
    auditCoverageHealthy?: boolean;
    attributionCoverage: number;
    promotionScore: number;
    capitalExposureValidated?: boolean;
    currentTrustLevel?: number | null;
    liveTradeCount?: number | null;
    benchmarkOutperformanceScore?: number | null;
    reconciliationCleanliness?: number | null;
  }): CapitalRampVerdict {
    const reasons: string[] = [];
    const evidenceThresholdsMet: string[] = [];
    const evidenceThresholdsUnmet: string[] = [];
    if (!input.tierAllowsScale) {
      reasons.push('deployment_tier_blocks_scale');
    }
    if (!(input.robustnessPassed ?? true)) {
      reasons.push('robustness_evidence_missing');
    }
    if (!(input.chaosPassed ?? true)) {
      reasons.push('chaos_harness_not_green');
    }
    if (!(input.auditCoverageHealthy ?? true)) {
      reasons.push('auditability_not_sufficient');
    }
    if (input.attributionCoverage < 0.6) {
      reasons.push('post_trade_attribution_too_thin');
    }
    if (!(input.capitalExposureValidated ?? true)) {
      reasons.push('capital_exposure_validation_missing');
    }
    if ((input.currentTrustLevel ?? 0) >= 0.65) {
      evidenceThresholdsMet.push('minimum_trust_level_for_promotion');
    } else {
      evidenceThresholdsUnmet.push('minimum_trust_level_for_promotion');
      reasons.push('live_trust_level_below_promotion_threshold');
    }
    if ((input.liveTradeCount ?? 0) >= 8) {
      evidenceThresholdsMet.push('minimum_live_trade_count_for_promotion');
    } else {
      evidenceThresholdsUnmet.push('minimum_live_trade_count_for_promotion');
      reasons.push('live_trade_count_below_promotion_threshold');
    }
    if ((input.benchmarkOutperformanceScore ?? 0) >= 0.5) {
      evidenceThresholdsMet.push('minimum_benchmark_outperformance_for_promotion');
    } else {
      evidenceThresholdsUnmet.push('minimum_benchmark_outperformance_for_promotion');
      reasons.push('benchmark_outperformance_not_sufficient_for_promotion');
    }
    if ((input.reconciliationCleanliness ?? 0) >= 0.7) {
      evidenceThresholdsMet.push('minimum_reconciliation_cleanliness_for_promotion');
    } else {
      evidenceThresholdsUnmet.push('minimum_reconciliation_cleanliness_for_promotion');
      reasons.push('reconciliation_cleanliness_not_sufficient_for_promotion');
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
      currentTrustLevel: input.currentTrustLevel ?? null,
      evidenceThresholdsMet,
      evidenceThresholdsUnmet,
      promotionAllowed: reasons.length === 0,
    };
  }
}
