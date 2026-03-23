export interface ExpectedVsRealizedEvGuardInput {
  expectedEvSum: number;
  realizedEvSum: number;
  minimumRealizedVsExpectedRatio: number;
}

export interface ExpectedVsRealizedEvGuardResult {
  passed: boolean;
  reasonCode: string;
  reasonMessage: string | null;
  realizedVsExpectedRatio: number | null;
}

export class ExpectedVsRealizedEvGuard {
  evaluate(
    input: ExpectedVsRealizedEvGuardInput,
  ): ExpectedVsRealizedEvGuardResult {
    if (input.expectedEvSum <= 0) {
      return {
        passed: false,
        reasonCode: 'expected_ev_not_positive',
        reasonMessage: 'Expected EV sum must be positive to evaluate EV drift.',
        realizedVsExpectedRatio: null,
      };
    }

    const realizedVsExpectedRatio = input.realizedEvSum / input.expectedEvSum;

    if (realizedVsExpectedRatio < input.minimumRealizedVsExpectedRatio) {
      return {
        passed: false,
        reasonCode: 'ev_drift_guard_triggered',
        reasonMessage: `Realized/expected EV ratio ${realizedVsExpectedRatio} is below minimum ${input.minimumRealizedVsExpectedRatio}.`,
        realizedVsExpectedRatio,
      };
    }

    return {
      passed: true,
      reasonCode: 'passed',
      reasonMessage: null,
      realizedVsExpectedRatio,
    };
  }
}