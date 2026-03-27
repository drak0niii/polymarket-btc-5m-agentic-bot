import {
  FillRealismStore,
  type FillRealismBucketKey,
  type FillRealismConfidence,
  type FillRealismSummary,
} from './fill-realism-store';

export interface FillProbabilityEstimatorInput {
  orderSize: number;
  topLevelDepth: number;
  recentMatchedVolume: number;
  queuePressureScore: number;
  bucket?: FillRealismBucketKey | null;
  recentWindowStart?: Date | string | null;
  recentWindowEnd?: Date | string | null;
}

export interface FillProbabilityByHorizon {
  within1s: number;
  within3s: number;
  within5s: number;
  within10s: number;
}

export interface QueueDelayProfile {
  averageMs: number | null;
  p50Ms: number | null;
  p90Ms: number | null;
}

export interface FillProbabilityEstimatorResult {
  fillProbability: number;
  fillProbabilityByHorizon: FillProbabilityByHorizon;
  expectedFillFraction: number | null;
  expectedQueueDelayMs: number | null;
  expectedQueueDelayProfile: QueueDelayProfile;
  confidence: FillRealismConfidence;
  evidenceCount: number;
  evidenceQuality: 'fallback_heuristic' | 'blended_empirical' | 'bucket_empirical';
  empiricalSummary: FillRealismSummary | null;
  capturedAt: string;
}

export class FillProbabilityEstimator {
  constructor(private readonly fillRealismStore = new FillRealismStore()) {}

  estimate(
    input: FillProbabilityEstimatorInput,
  ): FillProbabilityEstimatorResult {
    const depthFactor =
      input.topLevelDepth > 0
        ? Math.min(1, input.topLevelDepth / Math.max(input.orderSize, 1e-9))
        : 0;

    const volumeFactor =
      input.recentMatchedVolume > 0
        ? Math.min(1, input.recentMatchedVolume / Math.max(input.orderSize, 1e-9))
        : 0;

    const queuePenalty = Math.min(1, Math.max(0, input.queuePressureScore / 5));

    const heuristicFillProbability = Math.max(
      0,
      Math.min(1, depthFactor * 0.45 + volumeFactor * 0.45 - queuePenalty * 0.25 + 0.2),
    );

    const heuristicByHorizon: FillProbabilityByHorizon = {
      within1s: clamp01(heuristicFillProbability * 0.52),
      within3s: clamp01(heuristicFillProbability * 0.78),
      within5s: clamp01(heuristicFillProbability),
      within10s: clamp01(heuristicFillProbability * 1.12),
    };
    const empiricalSummary = input.bucket
      ? this.fillRealismStore.summarize({
          bucket: input.bucket,
          start: input.recentWindowStart ?? null,
          end: input.recentWindowEnd ?? null,
          limit: 250,
        })
      : null;
    const empiricalAvailable = Boolean(empiricalSummary && empiricalSummary.sampleCount > 0);
    const empiricalWeight = empiricalAvailable
      ? empiricalSummary!.confidence === 'high'
        ? 0.8
        : empiricalSummary!.confidence === 'medium'
          ? 0.5
          : 0.25
      : 0;
    const fillProbabilityByHorizon: FillProbabilityByHorizon = empiricalAvailable
      ? {
          within1s: blend(heuristicByHorizon.within1s, empiricalSummary!.fillProbabilityWithin1s, empiricalWeight),
          within3s: blend(heuristicByHorizon.within3s, empiricalSummary!.fillProbabilityWithin3s, empiricalWeight),
          within5s: blend(heuristicByHorizon.within5s, empiricalSummary!.fillProbabilityWithin5s, empiricalWeight),
          within10s: blend(heuristicByHorizon.within10s, empiricalSummary!.fillProbabilityWithin10s, empiricalWeight),
        }
      : heuristicByHorizon;
    const fillProbability = fillProbabilityByHorizon.within5s;
    const confidence = empiricalAvailable
      ? empiricalSummary!.confidence
      : heuristicFillProbability >= 0.75
        ? 'high'
        : heuristicFillProbability >= 0.4
          ? 'medium'
          : 'low';

    return {
      fillProbability,
      fillProbabilityByHorizon,
      expectedFillFraction: empiricalAvailable
        ? blend(depthFactor, empiricalSummary!.averageFillFraction, empiricalWeight)
        : depthFactor,
      expectedQueueDelayMs: empiricalAvailable
        ? blendNullable(
            queueDelayFromPressure(input.queuePressureScore),
            empiricalSummary!.averageQueueDelayMs,
            empiricalWeight,
          )
        : queueDelayFromPressure(input.queuePressureScore),
      expectedQueueDelayProfile: empiricalAvailable
        ? {
            averageMs: blendNullable(
              queueDelayFromPressure(input.queuePressureScore),
              empiricalSummary!.queueDelayProfile.averageMs,
              empiricalWeight,
            ),
            p50Ms: empiricalSummary!.queueDelayProfile.p50Ms,
            p90Ms: empiricalSummary!.queueDelayProfile.p90Ms,
          }
        : {
            averageMs: queueDelayFromPressure(input.queuePressureScore),
            p50Ms: queueDelayFromPressure(input.queuePressureScore) != null
              ? Math.round(queueDelayFromPressure(input.queuePressureScore)! * 0.8)
              : null,
            p90Ms: queueDelayFromPressure(input.queuePressureScore) != null
              ? Math.round(queueDelayFromPressure(input.queuePressureScore)! * 1.4)
              : null,
          },
      confidence,
      evidenceCount: empiricalSummary?.sampleCount ?? 0,
      evidenceQuality: empiricalAvailable
        ? empiricalWeight >= 0.8
          ? 'bucket_empirical'
          : 'blended_empirical'
        : 'fallback_heuristic',
      empiricalSummary,
      capturedAt: new Date().toISOString(),
    };
  }
}

function queueDelayFromPressure(queuePressureScore: number): number | null {
  if (!Number.isFinite(queuePressureScore)) {
    return null;
  }
  return Math.round(Math.max(250, queuePressureScore * 2_500));
}

function blend(base: number, observed: number | null, weight: number): number {
  if (!Number.isFinite(observed ?? Number.NaN)) {
    return clamp01(base);
  }
  return clamp01(base * (1 - weight) + (observed as number) * weight);
}

function blendNullable(base: number | null, observed: number | null, weight: number): number | null {
  if (!Number.isFinite(observed ?? Number.NaN)) {
    return base;
  }
  if (!Number.isFinite(base ?? Number.NaN)) {
    return observed;
  }
  return (base as number) * (1 - weight) + (observed as number) * weight;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
