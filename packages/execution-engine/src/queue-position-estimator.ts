export interface QueuePositionEstimatorInput {
  restingSizeAhead: number;
  orderSize: number;
  recentMatchedVolume: number;
}

export interface QueuePositionEstimatorResult {
  estimatedWaitScore: number;
  queuePressure: 'low' | 'medium' | 'high';
  capturedAt: string;
}

export class QueuePositionEstimator {
  estimate(
    input: QueuePositionEstimatorInput,
  ): QueuePositionEstimatorResult {
    const denominator = input.recentMatchedVolume > 0 ? input.recentMatchedVolume : 1;
    const estimatedWaitScore = (input.restingSizeAhead + input.orderSize) / denominator;

    const queuePressure =
      estimatedWaitScore < 0.5
        ? 'low'
        : estimatedWaitScore < 2
          ? 'medium'
          : 'high';

    return {
      estimatedWaitScore,
      queuePressure,
      capturedAt: new Date().toISOString(),
    };
  }
}