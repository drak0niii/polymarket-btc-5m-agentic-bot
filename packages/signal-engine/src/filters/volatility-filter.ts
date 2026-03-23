export interface VolatilityFilterInput {
  realizedVolatility: number;
  minVolatility: number;
  maxVolatility?: number;
}

export interface VolatilityFilterResult {
  passed: boolean;
  reasonCode: string;
  reasonMessage: string | null;
}

export class VolatilityFilter {
  evaluate(input: VolatilityFilterInput): VolatilityFilterResult {
    if (input.realizedVolatility < input.minVolatility) {
      return {
        passed: false,
        reasonCode: 'volatility_too_low',
        reasonMessage: `Realized volatility ${input.realizedVolatility} is below minimum ${input.minVolatility}.`,
      };
    }

    if (
      typeof input.maxVolatility === 'number' &&
      input.realizedVolatility > input.maxVolatility
    ) {
      return {
        passed: false,
        reasonCode: 'volatility_too_high',
        reasonMessage: `Realized volatility ${input.realizedVolatility} exceeds maximum ${input.maxVolatility}.`,
      };
    }

    return {
      passed: true,
      reasonCode: 'passed',
      reasonMessage: null,
    };
  }
}