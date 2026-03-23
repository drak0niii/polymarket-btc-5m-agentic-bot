export interface PromotionScoreResult {
  score: number;
  promoted: boolean;
  components: Record<string, number>;
  reasons: string[];
}

export class MultiObjectivePromotionScore {
  evaluate(input: {
    governanceConfidence: number;
    robustnessScore: number;
    realizedVsExpected: number;
    calibrationGap: number;
    auditCoverage: number;
  }): PromotionScoreResult {
    const components = {
      governance: clamp01(input.governanceConfidence),
      robustness: clamp01(input.robustnessScore),
      realizedVsExpected: clamp01(input.realizedVsExpected),
      calibration: clamp01(1 - input.calibrationGap / 0.2),
      auditCoverage: clamp01(input.auditCoverage),
    };

    const score =
      components.governance * 0.28 +
      components.robustness * 0.27 +
      components.realizedVsExpected * 0.2 +
      components.calibration * 0.15 +
      components.auditCoverage * 0.1;

    const reasons: string[] = [];
    if (components.governance < 0.55) {
      reasons.push('governance_score_too_low');
    }
    if (components.robustness < 0.55) {
      reasons.push('robustness_score_too_low');
    }
    if (components.calibration < 0.4) {
      reasons.push('calibration_score_too_low');
    }
    if (components.auditCoverage < 0.6) {
      reasons.push('audit_coverage_too_low');
    }

    return {
      score,
      promoted: reasons.length === 0 && score >= 0.62,
      components,
      reasons,
    };
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}
