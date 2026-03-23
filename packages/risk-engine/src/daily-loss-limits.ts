export interface DailyLossLimitsInput {
  bankroll: number;
  realizedPnlDay: number;
  maxDailyLossPct: number;
}

export interface DailyLossLimitsResult {
  passed: boolean;
  reasonCode: string;
  reasonMessage: string | null;
  dailyLossLimitValue: number;
}

export class DailyLossLimits {
  evaluate(input: DailyLossLimitsInput): DailyLossLimitsResult {
    const dailyLossLimitValue = input.bankroll * (input.maxDailyLossPct / 100);

    if (Math.abs(Math.min(input.realizedPnlDay, 0)) >= dailyLossLimitValue) {
      return {
        passed: false,
        reasonCode: 'daily_loss_limit_reached',
        reasonMessage: `Daily realized loss ${Math.abs(
          Math.min(input.realizedPnlDay, 0),
        )} reached limit ${dailyLossLimitValue}.`,
        dailyLossLimitValue,
      };
    }

    return {
      passed: true,
      reasonCode: 'passed',
      reasonMessage: null,
      dailyLossLimitValue,
    };
  }
}