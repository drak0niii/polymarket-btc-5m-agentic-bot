export interface EdgeCalculationInput {
  posteriorProbability: number;
  marketImpliedProbability: number;
}

export interface EdgeCalculationOutput {
  edge: number;
  capturedAt: string;
}

export class EdgeCalculator {
  calculate(input: EdgeCalculationInput): EdgeCalculationOutput {
    return {
      edge: input.posteriorProbability - input.marketImpliedProbability,
      capturedAt: new Date().toISOString(),
    };
  }
}