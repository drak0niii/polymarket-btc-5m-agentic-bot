import type { HealthLabel } from '@polymarket-btc-5m-agentic-bot/domain';

export interface CapitalGrowthPromotionGateInput {
  sampleCount: number;
  calibrationHealth: HealthLabel;
  executionHealth: HealthLabel;
  netEdgeQuality: number | null;
  maxDrawdownPct: number | null;
  capitalLeakageRatio: number | null;
  executionEvRetention: number | null;
  regimeStabilityScore: number | null;
  stabilityAdjustedCapitalGrowthScore: number | null;
}

export interface CapitalGrowthPromotionGateDecision {
  passed: boolean;
  reasons: string[];
  evidence: Record<string, unknown>;
}

export class CapitalGrowthPromotionGate {
  evaluate(input: CapitalGrowthPromotionGateInput): CapitalGrowthPromotionGateDecision {
    const reasons: string[] = [];

    if (input.sampleCount < 5) {
      reasons.push('capital_growth_sample_insufficient');
    }
    if ((input.netEdgeQuality ?? 0) <= 0) {
      reasons.push('net_edge_quality_non_positive');
    }
    if ((input.maxDrawdownPct ?? 0) > 0.08) {
      reasons.push('drawdown_exceeds_promotion_limit');
    }
    if (
      input.calibrationHealth === 'degraded' ||
      input.calibrationHealth === 'quarantine_candidate'
    ) {
      reasons.push(`calibration_health_${input.calibrationHealth}`);
    }
    if (
      input.executionHealth === 'degraded' ||
      input.executionHealth === 'quarantine_candidate'
    ) {
      reasons.push(`execution_health_${input.executionHealth}`);
    }
    if ((input.executionEvRetention ?? 0) < 0.9) {
      reasons.push('execution_retention_below_threshold');
    }
    if ((input.capitalLeakageRatio ?? 0) > 0.35) {
      reasons.push('capital_leakage_ratio_excessive');
    }
    if ((input.regimeStabilityScore ?? 0) < 0.55) {
      reasons.push('regime_profitability_unstable');
    }
    if ((input.stabilityAdjustedCapitalGrowthScore ?? 0) < 0.62) {
      reasons.push('capital_growth_quality_insufficient');
    }

    return {
      passed: reasons.length === 0,
      reasons: reasons.length > 0 ? reasons : ['capital_growth_promotion_gate_passed'],
      evidence: {
        sampleCount: input.sampleCount,
        calibrationHealth: input.calibrationHealth,
        executionHealth: input.executionHealth,
        netEdgeQuality: input.netEdgeQuality,
        maxDrawdownPct: input.maxDrawdownPct,
        capitalLeakageRatio: input.capitalLeakageRatio,
        executionEvRetention: input.executionEvRetention,
        regimeStabilityScore: input.regimeStabilityScore,
        stabilityAdjustedCapitalGrowthScore: input.stabilityAdjustedCapitalGrowthScore,
      },
    };
  }
}
