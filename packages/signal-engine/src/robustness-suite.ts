export interface RobustnessScenarioVerdict {
  scenarioKey: string;
  passed: boolean;
  score: number;
  reason: string;
}

export interface RobustnessSuiteResult {
  passed: boolean;
  score: number;
  scenarios: RobustnessScenarioVerdict[];
}

export class RobustnessSuite {
  evaluate(input: {
    realizedVsExpected: number;
    worstWindowEv: number;
    calibrationGap: number;
    segmentCoverage: number;
  }): RobustnessSuiteResult {
    const scenarios: RobustnessScenarioVerdict[] = [
      {
        scenarioKey: 'latency_decay',
        passed: input.realizedVsExpected > 0.45,
        score: clamp01(input.realizedVsExpected),
        reason:
          input.realizedVsExpected > 0.45
            ? 'latency-adjusted edge remains positive'
            : 'edge collapses under latency pressure',
      },
      {
        scenarioKey: 'execution_friction',
        passed: input.worstWindowEv > -0.02,
        score: clamp01(1 + input.worstWindowEv / 0.02),
        reason:
          input.worstWindowEv > -0.02
            ? 'worst walk-forward window stayed bounded'
            : 'worst walk-forward window breached tolerance',
      },
      {
        scenarioKey: 'calibration_stability',
        passed: input.calibrationGap <= 0.18,
        score: clamp01(1 - input.calibrationGap / 0.18),
        reason:
          input.calibrationGap <= 0.18
            ? 'probability calibration remains usable'
            : 'calibration drift is too large',
      },
      {
        scenarioKey: 'segmentation_depth',
        passed: input.segmentCoverage >= 0.2,
        score: clamp01(input.segmentCoverage),
        reason:
          input.segmentCoverage >= 0.2
            ? 'segmented evidence is broad enough'
            : 'segmented evidence is too thin',
      },
    ];

    const score =
      scenarios.reduce((sum, scenario) => sum + scenario.score, 0) / scenarios.length;

    return {
      passed: scenarios.every((scenario) => scenario.passed),
      score,
      scenarios,
    };
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}
