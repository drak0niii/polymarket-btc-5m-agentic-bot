export interface BetSizingInput {
  bankroll: number;
  availableCapital: number;
  cappedKellyFraction: number;
  maxPerTradeRiskPct: number;
  baseRiskOverride?: number | null;
  edgeFactor?: number | null;
  regimeFactor?: number | null;
  evidenceFactor?: number | null;
  deploymentTierFactor?: number | null;
  killSwitchFactor?: number | null;
}

export interface BetSizingResult {
  suggestedSize: number;
  riskBudget: number;
  baseRisk: number;
  edgeFactor: number;
  regimeFactor: number;
  evidenceFactor: number;
  deploymentTierFactor: number;
  killSwitchFactor: number;
  finalMultiplier: number;
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

    const baseRisk = Math.max(
      0,
      Math.min(
        riskBudget,
        input.baseRiskOverride != null && Number.isFinite(input.baseRiskOverride)
          ? input.baseRiskOverride
          : input.bankroll * input.cappedKellyFraction,
      ),
    );
    const edgeFactor = clamp(input.edgeFactor ?? 1);
    const regimeFactor = clamp(input.regimeFactor ?? 1);
    const evidenceFactor = clamp(input.evidenceFactor ?? 1);
    const deploymentTierFactor = clamp(input.deploymentTierFactor ?? 1);
    const killSwitchFactor = clamp(input.killSwitchFactor ?? 1);
    const finalMultiplier =
      edgeFactor *
      regimeFactor *
      evidenceFactor *
      deploymentTierFactor *
      killSwitchFactor;
    const suggestedSize = Math.max(
      0,
      Math.min(riskBudget, baseRisk * finalMultiplier),
    );

    return {
      suggestedSize,
      riskBudget,
      baseRisk,
      edgeFactor,
      regimeFactor,
      evidenceFactor,
      deploymentTierFactor,
      killSwitchFactor,
      finalMultiplier,
    };
  }
}

function clamp(value: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1.5) : 1;
}
