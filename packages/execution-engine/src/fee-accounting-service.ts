export interface FillEconomicsInput {
  side: 'BUY' | 'SELL';
  entryPrice: number;
  exitPrice: number | null;
  quantity: number;
  fees: number;
  rewards?: number | null;
  includeRewardsInAlpha?: boolean;
}

export interface FillEconomics {
  grossPnl: number;
  netPnl: number;
  netAlphaPnl: number;
  netEconomicPnl: number;
  feeImpact: number;
  rewards: number;
  rewardsIncludedInAlpha: boolean;
}

export interface MarkToMarketInput {
  side: 'BUY' | 'SELL';
  entryPrice: number;
  markPrice: number;
  quantity: number;
  realizedFees?: number;
  estimatedExitFee?: number;
  rewards?: number | null;
  includeRewardsInAlpha?: boolean;
}

export class FeeAccountingService {
  compute(input: FillEconomicsInput): FillEconomics {
    const exitPrice = input.exitPrice ?? input.entryPrice;
    const signedDelta =
      input.side === 'BUY' ? exitPrice - input.entryPrice : input.entryPrice - exitPrice;
    const grossPnl = signedDelta * input.quantity;
    const rewards = Math.max(0, input.rewards ?? 0);
    const feeImpact = Math.max(0, input.fees);
    const netAlphaPnl = grossPnl - feeImpact;
    const rewardsIncludedInAlpha = input.includeRewardsInAlpha === true;
    return {
      grossPnl,
      netPnl: rewardsIncludedInAlpha ? netAlphaPnl + rewards : netAlphaPnl,
      netAlphaPnl,
      netEconomicPnl: netAlphaPnl + rewards,
      feeImpact,
      rewards,
      rewardsIncludedInAlpha,
    };
  }

  computeMarkToMarket(input: MarkToMarketInput): FillEconomics {
    return this.compute({
      side: input.side,
      entryPrice: input.entryPrice,
      exitPrice: input.markPrice,
      quantity: input.quantity,
      fees: Math.max(0, input.realizedFees ?? 0) + Math.max(0, input.estimatedExitFee ?? 0),
      rewards: input.rewards ?? 0,
      includeRewardsInAlpha: input.includeRewardsInAlpha,
    });
  }
}
