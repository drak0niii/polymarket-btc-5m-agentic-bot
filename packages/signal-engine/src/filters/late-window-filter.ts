export interface LateWindowFilterInput {
  timeToExpirySeconds: number | null;
  minimumRequiredSeconds: number;
}

export interface LateWindowFilterResult {
  passed: boolean;
  reasonCode: string;
  reasonMessage: string | null;
}

export class LateWindowFilter {
  evaluate(input: LateWindowFilterInput): LateWindowFilterResult {
    if (input.timeToExpirySeconds === null) {
      return {
        passed: false,
        reasonCode: 'expiry_unknown',
        reasonMessage: 'Time to expiry is unknown.',
      };
    }

    if (input.timeToExpirySeconds < input.minimumRequiredSeconds) {
      return {
        passed: false,
        reasonCode: 'late_window_blocked',
        reasonMessage: `Time to expiry ${input.timeToExpirySeconds}s is below required minimum ${input.minimumRequiredSeconds}s.`,
      };
    }

    return {
      passed: true,
      reasonCode: 'passed',
      reasonMessage: null,
    };
  }
}