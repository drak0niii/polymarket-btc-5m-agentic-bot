export interface MispricingScoreInput {
  posteriorProbability: number;
  marketImpliedProbability: number;
  expectedFee: number;
  expectedSlippage: number;
  expectedImpact: number;
}

export interface MispricingScoreResult {
  rawEdge: number;
  netEdge: number;
  score: number;
}

export class MispricingScore {
  calculate(input: MispricingScoreInput): MispricingScoreResult {
    const rawEdge = input.posteriorProbability - input.marketImpliedProbability;
    const netEdge =
      rawEdge - input.expectedFee - input.expectedSlippage - input.expectedImpact;

    return {
      rawEdge,
      netEdge,
      score: netEdge,
    };
  }
}