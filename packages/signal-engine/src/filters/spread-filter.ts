export interface SpreadFilterInput {
  spread: number;
  maxSpread: number;
}

export interface SpreadFilterResult {
  passed: boolean;
  reasonCode: string;
  reasonMessage: string | null;
}

export class SpreadFilter {
  evaluate(input: SpreadFilterInput): SpreadFilterResult {
    if (input.spread > input.maxSpread) {
      return {
        passed: false,
        reasonCode: 'spread_too_wide',
        reasonMessage: `Spread ${input.spread} exceeds max ${input.maxSpread}.`,
      };
    }

    return {
      passed: true,
      reasonCode: 'passed',
      reasonMessage: null,
    };
  }
}