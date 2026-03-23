export interface FillProbabilityEstimatorInput {
  orderSize: number;
  topLevelDepth: number;
  recentMatchedVolume: number;
  queuePressureScore: number;
}

export interface FillProbabilityEstimatorResult {
  fillProbability: number;
  confidence: 'low' | 'medium' | 'high';
  capturedAt: string;
}

export class FillProbabilityEstimator {
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

    const fillProbability = Math.max(
      0,
      Math.min(1, depthFactor * 0.45 + volumeFactor * 0.45 - queuePenalty * 0.25 + 0.2),
    );

    const confidence =
      fillProbability >= 0.75
        ? 'high'
        : fillProbability >= 0.4
          ? 'medium'
          : 'low';

    return {
      fillProbability,
      confidence,
      capturedAt: new Date().toISOString(),
    };
  }
}