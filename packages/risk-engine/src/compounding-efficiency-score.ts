import type { HealthLabel } from '@polymarket-btc-5m-agentic-bot/domain';

export type CompoundingEfficiencyLabel =
  | 'efficient'
  | 'stable'
  | 'fragile'
  | 'inefficient';

export interface CompoundingEfficiencyScoreInput {
  netReturn: number;
  drawdownAdjustedGrowth: number;
  evRetention: number | null;
  costLeakageRatio: number | null;
  profitFactorAfterCosts: number | null;
  regimeAdjustedExpectancy: number | null;
  calibrationHealth: HealthLabel | null;
  executionHealth: HealthLabel | null;
}

export interface CompoundingEfficiencyAssessment {
  score: number;
  label: CompoundingEfficiencyLabel;
  reasons: string[];
  evidence: Record<string, unknown>;
}

export class CompoundingEfficiencyScore {
  evaluate(input: CompoundingEfficiencyScoreInput): CompoundingEfficiencyAssessment {
    const reasons: string[] = [];
    const score = clamp(
      normalizedNetReturn(input.netReturn) * 0.16 +
        normalizedNetReturn(input.drawdownAdjustedGrowth) * 0.2 +
        normalizedRetention(input.evRetention) * 0.17 +
        normalizedLeakage(input.costLeakageRatio) * 0.12 +
        normalizedProfitFactor(input.profitFactorAfterCosts) * 0.12 +
        normalizedNetReturn(input.regimeAdjustedExpectancy ?? 0) * 0.11 +
        healthScore(input.calibrationHealth) * 0.06 +
        healthScore(input.executionHealth) * 0.06,
      0,
      1,
    );

    if (input.netReturn <= 0) {
      reasons.push('net_return_non_positive');
    }
    if ((input.evRetention ?? 0) < 0.9) {
      reasons.push('ev_retention_not_stable');
    }
    if ((input.costLeakageRatio ?? 1) > 0.35) {
      reasons.push('cost_leakage_elevated');
    }
    if ((input.profitFactorAfterCosts ?? 0) < 1.05) {
      reasons.push('profit_factor_after_costs_weak');
    }
    if ((input.regimeAdjustedExpectancy ?? 0) <= 0) {
      reasons.push('regime_adjusted_expectancy_non_positive');
    }
    if ((input.calibrationHealth ?? 'healthy') !== 'healthy') {
      reasons.push(`calibration_health_${input.calibrationHealth}`);
    }
    if ((input.executionHealth ?? 'healthy') !== 'healthy') {
      reasons.push(`execution_health_${input.executionHealth}`);
    }

    return {
      score,
      label:
        score >= 0.78
          ? 'efficient'
          : score >= 0.62
            ? 'stable'
            : score >= 0.42
              ? 'fragile'
              : 'inefficient',
      reasons: reasons.length > 0 ? reasons : ['compounding_efficiency_supportive'],
      evidence: {
        netReturn: input.netReturn,
        drawdownAdjustedGrowth: input.drawdownAdjustedGrowth,
        evRetention: input.evRetention,
        costLeakageRatio: input.costLeakageRatio,
        profitFactorAfterCosts: input.profitFactorAfterCosts,
        regimeAdjustedExpectancy: input.regimeAdjustedExpectancy,
        calibrationHealth: input.calibrationHealth,
        executionHealth: input.executionHealth,
      },
    };
  }
}

function normalizedNetReturn(value: number): number {
  if (value <= 0) {
    return 0;
  }
  return clamp(value / 0.05, 0, 1);
}

function normalizedRetention(value: number | null): number {
  return clamp((value ?? 0.4) / 1.2, 0, 1);
}

function normalizedLeakage(value: number | null): number {
  return 1 - clamp(value ?? 0.5, 0, 1);
}

function normalizedProfitFactor(value: number | null): number {
  if (value == null || !Number.isFinite(value)) {
    return 0.4;
  }
  if (value <= 1) {
    return 0;
  }
  return clamp((value - 1) / 1.5, 0, 1);
}

function healthScore(health: HealthLabel | null): number {
  if (health === 'quarantine_candidate') {
    return 0.1;
  }
  if (health === 'degraded') {
    return 0.4;
  }
  if (health === 'watch') {
    return 0.7;
  }
  return 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
