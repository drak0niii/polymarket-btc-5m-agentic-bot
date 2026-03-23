export interface ExitManagerInput {
  entryPrice: number;
  currentPrice: number;
  side: 'BUY' | 'SELL';
  takeProfitPct?: number;
  stopLossPct?: number;
}

export interface ExitManagerResult {
  shouldExit: boolean;
  reasonCode: 'take_profit' | 'stop_loss' | 'hold';
  pnlPct: number;
  capturedAt: string;
}

export class ExitManager {
  evaluate(input: ExitManagerInput): ExitManagerResult {
    const direction = input.side === 'BUY' ? 1 : -1;
    const pnlPct =
      input.entryPrice > 0
        ? ((input.currentPrice - input.entryPrice) / input.entryPrice) * direction
        : 0;

    if (
      typeof input.takeProfitPct === 'number' &&
      pnlPct >= input.takeProfitPct
    ) {
      return {
        shouldExit: true,
        reasonCode: 'take_profit',
        pnlPct,
        capturedAt: new Date().toISOString(),
      };
    }

    if (
      typeof input.stopLossPct === 'number' &&
      pnlPct <= -Math.abs(input.stopLossPct)
    ) {
      return {
        shouldExit: true,
        reasonCode: 'stop_loss',
        pnlPct,
        capturedAt: new Date().toISOString(),
      };
    }

    return {
      shouldExit: false,
      reasonCode: 'hold',
      pnlPct,
      capturedAt: new Date().toISOString(),
    };
  }
}