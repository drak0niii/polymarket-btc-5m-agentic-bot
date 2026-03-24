import type { RegimeProfitabilityRank } from './regime-profitability-ranker';

export type OpportunityClass = 'strong_edge' | 'tradable_edge' | 'marginal_edge' | 'weak_edge';

export interface TradeFrequencyGovernorDecision {
  allowedTradesPerWindow: number;
  remainingTrades: number;
  blockTrade: boolean;
  sizeMultiplier: number;
  reasons: string[];
  evidence: Record<string, unknown>;
}

export class TradeFrequencyGovernor {
  evaluate(input: {
    regime: string | null;
    regimeRank: RegimeProfitabilityRank;
    opportunityClass: OpportunityClass;
    recentTradeCount: number;
    recentTradeQualityScore: number | null;
    recentCapitalLeakageShare: number | null;
    currentDrawdownPct: number;
    windowMinutes?: number;
  }): TradeFrequencyGovernorDecision {
    const baseAllowance = baseTradesPerWindow(input.regimeRank, input.opportunityClass);
    let allowedTradesPerWindow = baseAllowance;
    let sizeMultiplier = 1;
    const reasons = [
      `regime_rank_${input.regimeRank}`,
      `opportunity_class_${input.opportunityClass}`,
    ];

    if ((input.recentTradeQualityScore ?? 1) < 0.55) {
      allowedTradesPerWindow -= 1;
      sizeMultiplier *= 0.8;
      reasons.push('recent_trade_quality_requires_lower_frequency');
    }
    if ((input.recentTradeQualityScore ?? 1) < 0.4) {
      allowedTradesPerWindow -= 1;
      sizeMultiplier *= 0.75;
      reasons.push('recent_trade_quality_very_weak');
    }
    if ((input.recentCapitalLeakageShare ?? 0) >= 0.3) {
      allowedTradesPerWindow -= 1;
      sizeMultiplier *= 0.75;
      reasons.push('recent_capital_leakage_elevated');
    }
    if (input.currentDrawdownPct >= 0.06) {
      allowedTradesPerWindow = Math.min(allowedTradesPerWindow, 1);
      sizeMultiplier *= 0.6;
      reasons.push('drawdown_state_reduces_frequency');
    }
    if (input.currentDrawdownPct >= 0.1) {
      allowedTradesPerWindow = 0;
      sizeMultiplier = 0;
      reasons.push('drawdown_state_blocks_new_frequency');
    }

    allowedTradesPerWindow = Math.max(0, allowedTradesPerWindow);
    const remainingTrades = Math.max(0, allowedTradesPerWindow - input.recentTradeCount);

    return {
      allowedTradesPerWindow,
      remainingTrades,
      blockTrade: remainingTrades <= 0,
      sizeMultiplier: remainingTrades <= 0 ? 0 : Math.max(0, sizeMultiplier),
      reasons: remainingTrades <= 0 ? [...reasons, 'trade_frequency_budget_exhausted'] : reasons,
      evidence: {
        regime: input.regime,
        regimeRank: input.regimeRank,
        opportunityClass: input.opportunityClass,
        recentTradeCount: input.recentTradeCount,
        recentTradeQualityScore: input.recentTradeQualityScore,
        recentCapitalLeakageShare: input.recentCapitalLeakageShare,
        currentDrawdownPct: input.currentDrawdownPct,
        windowMinutes: input.windowMinutes ?? 180,
      },
    };
  }
}

function baseTradesPerWindow(
  regimeRank: RegimeProfitabilityRank,
  opportunityClass: OpportunityClass,
): number {
  if (regimeRank === 'avoid_regime' || opportunityClass === 'weak_edge') {
    return 0;
  }
  if (regimeRank === 'strong_regime' && opportunityClass === 'strong_edge') {
    return 3;
  }
  if (regimeRank === 'marginal_regime' || opportunityClass === 'marginal_edge') {
    return 1;
  }
  return 2;
}
