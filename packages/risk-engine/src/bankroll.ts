export interface BankrollState {
  bankroll: number;
  availableCapital: number;
  openExposure: number;
  realizedPnlDay: number;
  unrealizedPnl: number;
  consecutiveLosses: number;
  capturedAt: string;
}

export class BankrollService {
  snapshot(input: {
    bankroll: number;
    availableCapital: number;
    openExposure: number;
    realizedPnlDay: number;
    unrealizedPnl: number;
    consecutiveLosses: number;
  }): BankrollState {
    return {
      bankroll: input.bankroll,
      availableCapital: input.availableCapital,
      openExposure: input.openExposure,
      realizedPnlDay: input.realizedPnlDay,
      unrealizedPnl: input.unrealizedPnl,
      consecutiveLosses: input.consecutiveLosses,
      capturedAt: new Date().toISOString(),
    };
  }
}