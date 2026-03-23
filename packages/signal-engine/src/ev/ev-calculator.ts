export interface EvCalculationInput {
  edge: number;
  expectedFee: number;
  expectedSlippage: number;
  expectedImpact: number;
}

export interface EvCalculationOutput {
  expectedEv: number;
  capturedAt: string;
}

export class EvCalculator {
  calculate(input: EvCalculationInput): EvCalculationOutput {
    return {
      expectedEv:
        input.edge - input.expectedFee - input.expectedSlippage - input.expectedImpact,
      capturedAt: new Date().toISOString(),
    };
  }
}