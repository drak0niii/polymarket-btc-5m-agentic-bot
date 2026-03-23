export interface BetSizingInput {
  bankroll: number;
  availableCapital: number;
  cappedKellyFraction: number;
  maxPerTradeRiskPct: number;
}

export interface BetSizingResult {
  suggestedSize: number;
  riskBudget: number;
}

export class BetSizing {
  calculate(input: BetSizingInput): BetSizingResult {
    const riskBudget = Math.max(
      0,
      Math.min(
        input.availableCapital,
        input.bankroll * (input.maxPerTradeRiskPct / 100),
      ),
    );

    const suggestedSize = Math.max(
      0,
      Math.min(riskBudget, input.bankroll * input.cappedKellyFraction),
    );

    return {
      suggestedSize,
      riskBudget,
    };
  }
}