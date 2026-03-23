export interface SlippageEstimatorInput {
  side: 'BUY' | 'SELL';
  bestBid: number | null;
  bestAsk: number | null;
  targetSize: number;
  topLevelDepth: number;
}

export interface SlippageEstimatorResult {
  expectedSlippage: number;
  severity: 'low' | 'medium' | 'high';
  capturedAt: string;
}

export class SlippageEstimator {
  estimate(input: SlippageEstimatorInput): SlippageEstimatorResult {
    const spread =
      input.bestBid !== null && input.bestAsk !== null
        ? Math.max(0, input.bestAsk - input.bestBid)
        : 0;

    const depthRatio =
      input.topLevelDepth > 0 ? input.targetSize / input.topLevelDepth : Infinity;

    const expectedSlippage =
      spread * 0.5 + (Number.isFinite(depthRatio) ? depthRatio * 0.01 : 1);

    const severity =
      expectedSlippage < 0.01
        ? 'low'
        : expectedSlippage < 0.05
          ? 'medium'
          : 'high';

    return {
      expectedSlippage,
      severity,
      capturedAt: new Date().toISOString(),
    };
  }
}