export interface BankrollContractionInput {
  startingBankroll: number;
  currentBankroll: number;
  baseSize: number;
  mildDrawdownPct: number;
  severeDrawdownPct: number;
  mildMultiplier: number;
  severeMultiplier: number;
}

export interface BankrollContractionResult {
  adjustedSize: number;
  drawdownPct: number;
  tier: 'none' | 'mild' | 'severe';
}

export class BankrollContraction {
  apply(input: BankrollContractionInput): BankrollContractionResult {
    if (input.startingBankroll <= 0) {
      return {
        adjustedSize: 0,
        drawdownPct: 0,
        tier: 'severe',
      };
    }

    const drawdownPct =
      ((input.startingBankroll - input.currentBankroll) /
        input.startingBankroll) *
      100;

    if (drawdownPct >= input.severeDrawdownPct) {
      return {
        adjustedSize: Math.max(0, input.baseSize * input.severeMultiplier),
        drawdownPct,
        tier: 'severe',
      };
    }

    if (drawdownPct >= input.mildDrawdownPct) {
      return {
        adjustedSize: Math.max(0, input.baseSize * input.mildMultiplier),
        drawdownPct,
        tier: 'mild',
      };
    }

    return {
      adjustedSize: Math.max(0, input.baseSize),
      drawdownPct,
      tier: 'none',
    };
  }
}