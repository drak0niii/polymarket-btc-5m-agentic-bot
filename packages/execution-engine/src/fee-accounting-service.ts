export interface FillEconomicsInput {
  side: 'BUY' | 'SELL';
  entryPrice: number;
  exitPrice: number | null;
  quantity: number;
  fees: number;
  rewards?: number | null;
  includeRewardsInAlpha?: boolean;
  feeRateUsed?: number | null;
  feeScheduleSource?: string | null;
  makerTakerAssumption?: 'maker' | 'taker' | 'hybrid' | null;
}

export interface FillEconomics {
  grossPnl: number;
  netPnl: number;
  netAlphaPnl: number;
  netEconomicPnl: number;
  feeImpact: number;
  rewards: number;
  rewardsIncludedInAlpha: boolean;
  feeRateUsed: number | null;
  feeScheduleSource: string | null;
  feeNotional: number;
  makerTakerAssumption: 'maker' | 'taker' | 'hybrid' | null;
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
  feeRateUsed?: number | null;
  feeScheduleSource?: string | null;
  makerTakerAssumption?: 'maker' | 'taker' | 'hybrid' | null;
}

export interface ExplicitFeeModelInput {
  notional: number;
  feeRateUsed: number;
  feeScheduleSource: string;
  makerTakerAssumption?: 'maker' | 'taker' | 'hybrid' | null;
}

export interface ExplicitFeeModelResult {
  feeRateUsed: number;
  feeScheduleSource: string;
  feeNotional: number;
  expectedFee: number;
  makerTakerAssumption: 'maker' | 'taker' | 'hybrid' | null;
}

export class FeeAccountingService {
  compute(input: FillEconomicsInput): FillEconomics {
    const exitPrice = input.exitPrice ?? input.entryPrice;
    const signedDelta =
      input.side === 'BUY' ? exitPrice - input.entryPrice : input.entryPrice - exitPrice;
    const grossPnl = signedDelta * input.quantity;
    const rewards = Math.max(0, input.rewards ?? 0);
    const feeImpact = Math.max(0, input.fees);
    const feeNotional = Math.max(0, input.entryPrice) * Math.max(0, input.quantity);
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
      feeRateUsed:
        typeof input.feeRateUsed === 'number' && Number.isFinite(input.feeRateUsed)
          ? input.feeRateUsed
          : null,
      feeScheduleSource: input.feeScheduleSource ?? null,
      feeNotional,
      makerTakerAssumption: input.makerTakerAssumption ?? null,
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
      feeRateUsed: input.feeRateUsed ?? null,
      feeScheduleSource: input.feeScheduleSource ?? null,
      makerTakerAssumption: input.makerTakerAssumption ?? null,
    });
  }

  modelExplicitFee(input: ExplicitFeeModelInput): ExplicitFeeModelResult {
    const feeRateUsed = Number.isFinite(input.feeRateUsed) ? Math.max(0, input.feeRateUsed) : 0;
    const feeNotional = Number.isFinite(input.notional) ? Math.max(0, input.notional) : 0;
    return {
      feeRateUsed,
      feeScheduleSource: input.feeScheduleSource,
      feeNotional,
      expectedFee: feeNotional * feeRateUsed,
      makerTakerAssumption: input.makerTakerAssumption ?? null,
    };
  }
}
