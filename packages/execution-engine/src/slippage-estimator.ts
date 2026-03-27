import {
  FillRealismStore,
  type FillRealismBucketKey,
  type FillRealismConfidence,
} from './fill-realism-store';

export interface SlippageEstimatorInput {
  side: 'BUY' | 'SELL';
  bestBid: number | null;
  bestAsk: number | null;
  targetSize: number;
  topLevelDepth: number;
  bucket?: FillRealismBucketKey | null;
  recentWindowStart?: Date | string | null;
  recentWindowEnd?: Date | string | null;
}

export interface SlippageEstimatorResult {
  expectedSlippage: number;
  severity: 'low' | 'medium' | 'high';
  geometryBasedComponent: number;
  empiricalAdjustmentComponent: number;
  finalExpectedSlippageBps: number;
  evidenceStrength: FillRealismConfidence;
  evidenceCount: number;
  capturedAt: string;
}

export class SlippageEstimator {
  constructor(private readonly fillRealismStore = new FillRealismStore()) {}

  estimate(input: SlippageEstimatorInput): SlippageEstimatorResult {
    const spread =
      input.bestBid !== null && input.bestAsk !== null
        ? Math.max(0, input.bestAsk - input.bestBid)
        : 0;

    const depthRatio =
      input.topLevelDepth > 0 ? input.targetSize / input.topLevelDepth : Infinity;

    const geometryBasedComponent =
      spread * 0.5 + (Number.isFinite(depthRatio) ? depthRatio * 0.01 : 1);
    const summary = input.bucket
      ? this.fillRealismStore.summarize({
          bucket: input.bucket,
          start: input.recentWindowStart ?? null,
          end: input.recentWindowEnd ?? null,
          limit: 250,
        })
      : null;
    const referencePrice =
      input.side === 'BUY'
        ? input.bestAsk ?? input.bestBid ?? null
        : input.bestBid ?? input.bestAsk ?? null;
    const empiricalAbsolute =
      summary?.averageSlippageBps != null &&
      referencePrice != null &&
      referencePrice > 0
        ? (summary.averageSlippageBps / 10_000) * referencePrice
        : null;
    const empiricalWeight =
      summary?.confidence === 'high' ? 0.8 : summary?.confidence === 'medium' ? 0.5 : summary?.sampleCount ? 0.25 : 0;
    const expectedSlippage =
      empiricalWeight > 0 && empiricalAbsolute != null
        ? geometryBasedComponent * (1 - empiricalWeight) + empiricalAbsolute * empiricalWeight
        : geometryBasedComponent;
    const empiricalAdjustmentComponent = Math.max(0, expectedSlippage - geometryBasedComponent);
    const finalExpectedSlippageBps =
      referencePrice != null && referencePrice > 0
        ? (expectedSlippage / referencePrice) * 10_000
        : 0;

    const severity =
      expectedSlippage < 0.01
        ? 'low'
        : expectedSlippage < 0.05
          ? 'medium'
          : 'high';

    return {
      expectedSlippage,
      severity,
      geometryBasedComponent,
      empiricalAdjustmentComponent,
      finalExpectedSlippageBps,
      evidenceStrength: summary?.confidence ?? 'low',
      evidenceCount: summary?.sampleCount ?? 0,
      capturedAt: new Date().toISOString(),
    };
  }
}
