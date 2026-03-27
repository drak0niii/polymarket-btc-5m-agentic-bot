import {
  FillRealismStore,
  type FillRealismBucketKey,
  type FillRealismConfidence,
} from './fill-realism-store';

export interface QueuePositionEstimatorInput {
  restingSizeAhead: number;
  orderSize: number;
  recentMatchedVolume: number;
  bucket?: FillRealismBucketKey | null;
  recentWindowStart?: Date | string | null;
  recentWindowEnd?: Date | string | null;
}

export interface QueuePositionEstimatorResult {
  estimatedWaitScore: number;
  queuePressure: 'low' | 'medium' | 'high';
  centralEstimateMs: number | null;
  lowerBoundMs: number | null;
  upperBoundMs: number | null;
  evidenceCount: number;
  confidence: FillRealismConfidence;
  capturedAt: string;
}

export class QueuePositionEstimator {
  constructor(private readonly fillRealismStore = new FillRealismStore()) {}

  estimate(
    input: QueuePositionEstimatorInput,
  ): QueuePositionEstimatorResult {
    const denominator = input.recentMatchedVolume > 0 ? input.recentMatchedVolume : 1;
    const estimatedWaitScore = (input.restingSizeAhead + input.orderSize) / denominator;
    const heuristicCentralEstimateMs = Math.round(Math.max(250, estimatedWaitScore * 2_500));

    const queuePressure =
      estimatedWaitScore < 0.5
        ? 'low'
        : estimatedWaitScore < 2
          ? 'medium'
          : 'high';
    const summary = input.bucket
      ? this.fillRealismStore.summarize({
          bucket: input.bucket,
          start: input.recentWindowStart ?? null,
          end: input.recentWindowEnd ?? null,
          limit: 250,
        })
      : null;
    const empiricalWeight =
      summary?.confidence === 'high' ? 0.8 : summary?.confidence === 'medium' ? 0.5 : summary?.confidence === 'low' && summary.sampleCount > 0 ? 0.25 : 0;
    const centralEstimateMs =
      empiricalWeight > 0
        ? blendNullable(heuristicCentralEstimateMs, summary?.averageQueueDelayMs ?? null, empiricalWeight)
        : heuristicCentralEstimateMs;
    const lowerBoundMs =
      empiricalWeight > 0
        ? blendNullable(
            Math.round(heuristicCentralEstimateMs * 0.75),
            summary?.queueDelayProfile.p50Ms ?? null,
            empiricalWeight,
          )
        : Math.round(heuristicCentralEstimateMs * 0.75);
    const upperBoundMs =
      empiricalWeight > 0
        ? blendNullable(
            Math.round(heuristicCentralEstimateMs * 1.35),
            summary?.queueDelayProfile.p90Ms ?? null,
            empiricalWeight,
          )
        : Math.round(heuristicCentralEstimateMs * 1.35);

    return {
      estimatedWaitScore,
      queuePressure,
      centralEstimateMs,
      lowerBoundMs,
      upperBoundMs,
      evidenceCount: summary?.sampleCount ?? 0,
      confidence:
        summary?.sampleCount && summary.sampleCount > 0
          ? summary.confidence
          : queuePressure === 'low'
            ? 'high'
            : queuePressure === 'medium'
              ? 'medium'
              : 'low',
      capturedAt: new Date().toISOString(),
    };
  }
}

function blendNullable(base: number | null, observed: number | null, weight: number): number | null {
  if (!Number.isFinite(observed ?? Number.NaN)) {
    return base;
  }
  if (!Number.isFinite(base ?? Number.NaN)) {
    return observed;
  }
  return Math.round((base as number) * (1 - weight) + (observed as number) * weight);
}
