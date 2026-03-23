export interface ExecutionDriftKillSwitchInput {
  expectedEvSum: number;
  realizedEvSum: number;
  minimumRealizedVsExpectedRatio: number;
}

export interface ExecutionDriftKillSwitchResult {
  triggered: boolean;
  reasonCode: string;
  reasonMessage: string | null;
  realizedVsExpectedRatio: number | null;
}

export class ExecutionDriftKillSwitch {
  evaluate(
    input: ExecutionDriftKillSwitchInput,
  ): ExecutionDriftKillSwitchResult {
    if (input.expectedEvSum <= 0) {
      return {
        triggered: false,
        reasonCode: 'insufficient_expected_ev_context',
        reasonMessage: 'Expected EV sum must be positive to evaluate execution drift.',
        realizedVsExpectedRatio: null,
      };
    }

    const realizedVsExpectedRatio = input.realizedEvSum / input.expectedEvSum;

    if (realizedVsExpectedRatio < input.minimumRealizedVsExpectedRatio) {
      return {
        triggered: true,
        reasonCode: 'execution_drift_kill_switch_triggered',
        reasonMessage: `Realized/expected EV ratio ${realizedVsExpectedRatio} is below minimum ${input.minimumRealizedVsExpectedRatio}.`,
        realizedVsExpectedRatio,
      };
    }

    return {
      triggered: false,
      reasonCode: 'not_triggered',
      reasonMessage: null,
      realizedVsExpectedRatio,
    };
  }
}