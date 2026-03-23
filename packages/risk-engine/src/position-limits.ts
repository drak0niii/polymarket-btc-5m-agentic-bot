export interface PositionLimitsInput {
  openPositions: number;
  maxOpenPositions: number;
}

export interface PositionLimitsResult {
  passed: boolean;
  reasonCode: string;
  reasonMessage: string | null;
}

export class PositionLimits {
  evaluate(input: PositionLimitsInput): PositionLimitsResult {
    if (input.openPositions >= input.maxOpenPositions) {
      return {
        passed: false,
        reasonCode: 'max_open_positions_reached',
        reasonMessage: `Open positions ${input.openPositions} reached limit ${input.maxOpenPositions}.`,
      };
    }

    return {
      passed: true,
      reasonCode: 'passed',
      reasonMessage: null,
    };
  }
}