export interface LiquidityFilterInput {
  bidDepth: number;
  askDepth: number;
  minDepth: number;
}

export interface LiquidityFilterResult {
  passed: boolean;
  reasonCode: string;
  reasonMessage: string | null;
}

export class LiquidityFilter {
  evaluate(input: LiquidityFilterInput): LiquidityFilterResult {
    const availableDepth = Math.min(input.bidDepth, input.askDepth);

    if (availableDepth < input.minDepth) {
      return {
        passed: false,
        reasonCode: 'insufficient_liquidity',
        reasonMessage: `Available depth ${availableDepth} is below minimum ${input.minDepth}.`,
      };
    }

    return {
      passed: true,
      reasonCode: 'passed',
      reasonMessage: null,
    };
  }
}