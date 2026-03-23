import type {
  CalibrationBucketResult,
  ValidationSegmentResult,
  WalkForwardSpec,
} from '@polymarket-btc-5m-agentic-bot/domain';

export interface WalkForwardSample {
  observedAt: string;
  expectedEdge: number;
  executableEv: number;
  regime: string;
  realizedReturn: number;
  fillRate: number;
  predictedProbability?: number | null;
  realizedOutcome?: number | null;
  eventType?: string;
  liquidityBucket?: string;
  timeBucket?: string;
  marketStructureBucket?: string;
  costAdjustedEv?: number | null;
}

export interface WalkForwardWindowResult {
  label: string;
  trainStartAt?: string;
  trainEndAt?: string;
  validationStartAt?: string;
  validationEndAt?: string;
  testStartAt?: string;
  testEndAt?: string;
  trainStartIndex: number;
  trainEndIndex: number;
  validationStartIndex: number;
  validationEndIndex: number;
  testStartIndex: number;
  testEndIndex: number;
  sampleCount: number;
  expectedEvSum: number;
  realizedEvSum: number;
  leakagePrevented: boolean;
}

export interface WalkForwardValidationResult {
  sufficientSamples: boolean;
  leakagePrevented: boolean;
  confidence: number;
  tradeAllowed: boolean;
  windowSpec: WalkForwardSpec;
  segmentation: ValidationSegmentResult[];
  calibration: CalibrationBucketResult[];
  costModelVersion: string;
  calibrationVersion: string;
  maxCalibrationGap: number;
  segmentCoverage: number;
  windows: WalkForwardWindowResult[];
  regimePerformance: Array<{
    regime: string;
    tradeCount: number;
    expectedEvAvg: number;
    realizedEvAvg: number;
    fillRate: number;
  }>;
  aggregate: {
    windowCount: number;
    expectedEvSum: number;
    realizedEvSum: number;
    realizedVsExpected: number;
    worstWindowEv: number;
  };
  capturedAt: string;
}

export interface WalkForwardValidationInput {
  samples: WalkForwardSample[];
  minimumSamples?: number;
  trainWindowSize?: number;
  validationWindowSize?: number;
  testWindowSize?: number;
  stepSize?: number;
  anchored?: boolean;
}

export class WalkForwardValidator {
  validate(input: WalkForwardValidationInput): WalkForwardValidationResult {
    const samples = [...input.samples].sort(
      (left, right) =>
        new Date(left.observedAt).getTime() - new Date(right.observedAt).getTime(),
    );

    const minimumSamples = input.minimumSamples ?? 24;
    const trainWindowSize = input.trainWindowSize ?? 12;
    const validationWindowSize = input.validationWindowSize ?? 6;
    const testWindowSize = input.testWindowSize ?? 6;
    const stepSize = input.stepSize ?? testWindowSize;
    const anchored = input.anchored ?? true;

    const windowSpec: WalkForwardSpec = {
      version: 'walk-forward-v2',
      trainWindowSize,
      validationWindowSize,
      testWindowSize,
      stepSize,
      minimumSamples,
      anchored,
    };

    if (
      samples.length < minimumSamples ||
      samples.length < trainWindowSize + validationWindowSize + testWindowSize
    ) {
      return this.empty(false, windowSpec);
    }

    const windows: WalkForwardWindowResult[] = [];

    for (
      let offset = 0;
      offset + trainWindowSize + validationWindowSize + testWindowSize <= samples.length;
      offset += stepSize
    ) {
      const trainStartIndex = anchored ? 0 : offset;
      const trainEndIndex = anchored
        ? offset + trainWindowSize - 1
        : trainStartIndex + trainWindowSize - 1;
      const validationStartIndex = trainEndIndex + 1;
      const validationEndIndex = validationStartIndex + validationWindowSize - 1;
      const testStartIndex = validationEndIndex + 1;
      const testEndIndex = testStartIndex + testWindowSize - 1;
      const testSamples = samples.slice(testStartIndex, testEndIndex + 1);

      const expectedEvSum = testSamples.reduce(
        (sum, sample) => sum + (sample.costAdjustedEv ?? sample.executableEv),
        0,
      );
      const realizedEvSum = testSamples.reduce(
        (sum, sample) => sum + sample.realizedReturn * sample.fillRate,
        0,
      );

      windows.push({
        label: `train_${trainStartIndex}_${trainEndIndex}__test_${testStartIndex}_${testEndIndex}`,
        trainStartAt: samples[trainStartIndex]?.observedAt,
        trainEndAt: samples[trainEndIndex]?.observedAt,
        validationStartAt: samples[validationStartIndex]?.observedAt,
        validationEndAt: samples[validationEndIndex]?.observedAt,
        testStartAt: samples[testStartIndex]?.observedAt,
        testEndAt: samples[testEndIndex]?.observedAt,
        trainStartIndex,
        trainEndIndex,
        validationStartIndex,
        validationEndIndex,
        testStartIndex,
        testEndIndex,
        sampleCount: testSamples.length,
        expectedEvSum,
        realizedEvSum,
        leakagePrevented: testStartIndex > trainEndIndex,
      });
    }

    const expectedEvSum = windows.reduce((sum, window) => sum + window.expectedEvSum, 0);
    const realizedEvSum = windows.reduce((sum, window) => sum + window.realizedEvSum, 0);
    const worstWindowEv =
      windows.length > 0
        ? windows.reduce(
            (worst, window) => Math.min(worst, window.realizedEvSum),
            Number.POSITIVE_INFINITY,
          )
        : 0;
    const realizedVsExpected =
      Math.abs(expectedEvSum) > 1e-9 ? realizedEvSum / expectedEvSum : 0;

    const regimeBuckets = samples.reduce(
      (accumulator, sample) => {
        const bucket = accumulator.get(sample.regime) ?? {
          regime: sample.regime,
          tradeCount: 0,
          expectedEvSum: 0,
          realizedEvSum: 0,
          fillRateSum: 0,
        };
        bucket.tradeCount += 1;
        bucket.expectedEvSum += sample.costAdjustedEv ?? sample.executableEv;
        bucket.realizedEvSum += sample.realizedReturn;
        bucket.fillRateSum += sample.fillRate;
        accumulator.set(sample.regime, bucket);
        return accumulator;
      },
      new Map<
        string,
        {
          regime: string;
          tradeCount: number;
          expectedEvSum: number;
          realizedEvSum: number;
          fillRateSum: number;
        }
      >(),
    );

    const regimePerformance = Array.from(regimeBuckets.values()).map((bucket) => ({
      regime: bucket.regime,
      tradeCount: bucket.tradeCount,
      expectedEvAvg: bucket.tradeCount > 0 ? bucket.expectedEvSum / bucket.tradeCount : 0,
      realizedEvAvg: bucket.tradeCount > 0 ? bucket.realizedEvSum / bucket.tradeCount : 0,
      fillRate: bucket.tradeCount > 0 ? bucket.fillRateSum / bucket.tradeCount : 0,
    }));

    const segmentation = this.buildSegmentation(samples);
    const calibration = this.buildCalibration(samples);
    const maxCalibrationGap = calibration.reduce(
      (max, bucket) => Math.max(max, Math.abs(bucket.calibrationGap)),
      0,
    );
    const segmentCoverage =
      segmentation.length > 0
        ? segmentation.filter((segment) => segment.sampleCount >= 2).length / segmentation.length
        : 0;

    const leakagePrevented = windows.every((window) => window.leakagePrevented);
    const confidence = clamp01(
      0.35 +
        Math.min(0.35, windows.length / 6) +
        Math.max(0, Math.min(0.2, realizedVsExpected * 0.2)) +
        Math.max(0, 0.1 - maxCalibrationGap * 0.3) +
        segmentCoverage * 0.1 +
        (leakagePrevented ? 0.1 : 0),
    );

    return {
      sufficientSamples: true,
      leakagePrevented,
      confidence,
      tradeAllowed:
        leakagePrevented &&
        windows.length > 0 &&
        expectedEvSum > 0 &&
        realizedEvSum > 0 &&
        worstWindowEv > -0.02 &&
        maxCalibrationGap <= 0.18,
      windowSpec,
      segmentation,
      calibration,
      costModelVersion: 'cost-adjusted-walk-forward-v2',
      calibrationVersion: 'reliability-buckets-v1',
      maxCalibrationGap,
      segmentCoverage,
      windows,
      regimePerformance,
      aggregate: {
        windowCount: windows.length,
        expectedEvSum,
        realizedEvSum,
        realizedVsExpected,
        worstWindowEv: Number.isFinite(worstWindowEv) ? worstWindowEv : 0,
      },
      capturedAt: new Date().toISOString(),
    };
  }

  private empty(
    leakagePrevented: boolean,
    windowSpec: WalkForwardSpec,
  ): WalkForwardValidationResult {
    return {
      sufficientSamples: false,
      leakagePrevented,
      confidence: 0,
      tradeAllowed: false,
      windowSpec,
      segmentation: [],
      calibration: [],
      costModelVersion: 'cost-adjusted-walk-forward-v2',
      calibrationVersion: 'reliability-buckets-v1',
      maxCalibrationGap: 1,
      segmentCoverage: 0,
      windows: [],
      regimePerformance: [],
      aggregate: {
        windowCount: 0,
        expectedEvSum: 0,
        realizedEvSum: 0,
        realizedVsExpected: 0,
        worstWindowEv: 0,
      },
      capturedAt: new Date().toISOString(),
    };
  }

  private buildSegmentation(samples: WalkForwardSample[]): ValidationSegmentResult[] {
    const dimensions: Array<{
      dimension: ValidationSegmentResult['dimension'];
      getter: (sample: WalkForwardSample) => string;
    }> = [
      { dimension: 'regime', getter: (sample) => sample.regime ?? 'unknown' },
      { dimension: 'event_type', getter: (sample) => sample.eventType ?? 'unknown' },
      { dimension: 'liquidity', getter: (sample) => sample.liquidityBucket ?? 'unknown' },
      { dimension: 'time_of_day', getter: (sample) => sample.timeBucket ?? 'unknown' },
      {
        dimension: 'market_structure',
        getter: (sample) => sample.marketStructureBucket ?? 'unknown',
      },
    ];

    const segments: ValidationSegmentResult[] = [];
    for (const dimension of dimensions) {
      const buckets = new Map<
        string,
        { sampleCount: number; expectedEvSum: number; realizedEvSum: number; fillRateSum: number }
      >();

      for (const sample of samples) {
        const key = dimension.getter(sample);
        const bucket = buckets.get(key) ?? {
          sampleCount: 0,
          expectedEvSum: 0,
          realizedEvSum: 0,
          fillRateSum: 0,
        };
        bucket.sampleCount += 1;
        bucket.expectedEvSum += sample.costAdjustedEv ?? sample.executableEv;
        bucket.realizedEvSum += sample.realizedReturn;
        bucket.fillRateSum += sample.fillRate;
        buckets.set(key, bucket);
      }

      for (const [bucket, metrics] of buckets) {
        segments.push({
          dimension: dimension.dimension,
          bucket,
          sampleCount: metrics.sampleCount,
          expectedEvAvg:
            metrics.sampleCount > 0 ? metrics.expectedEvSum / metrics.sampleCount : 0,
          realizedEvAvg:
            metrics.sampleCount > 0 ? metrics.realizedEvSum / metrics.sampleCount : 0,
          fillRate: metrics.sampleCount > 0 ? metrics.fillRateSum / metrics.sampleCount : 0,
        });
      }
    }

    return segments;
  }

  private buildCalibration(samples: WalkForwardSample[]): CalibrationBucketResult[] {
    const buckets = Array.from({ length: 5 }, (_, index) => ({
      bucketLabel: `${index * 20}-${(index + 1) * 20}%`,
      lowerBound: index * 0.2,
      upperBound: index === 4 ? 1 : (index + 1) * 0.2,
      sampleCount: 0,
      predictedSum: 0,
      observedSum: 0,
    }));

    for (const sample of samples) {
      if (sample.predictedProbability == null || sample.realizedOutcome == null) {
        continue;
      }
      const probability = clamp01(sample.predictedProbability);
      const index = Math.min(4, Math.floor(probability / 0.2));
      const bucket = buckets[index];
      bucket.sampleCount += 1;
      bucket.predictedSum += probability;
      bucket.observedSum += clamp01(sample.realizedOutcome);
    }

    return buckets.map((bucket) => {
      const averagePredicted =
        bucket.sampleCount > 0 ? bucket.predictedSum / bucket.sampleCount : 0;
      const averageObserved =
        bucket.sampleCount > 0 ? bucket.observedSum / bucket.sampleCount : 0;
      return {
        bucketLabel: bucket.bucketLabel,
        lowerBound: bucket.lowerBound,
        upperBound: bucket.upperBound,
        sampleCount: bucket.sampleCount,
        averagePredicted,
        averageObserved,
        calibrationGap: averageObserved - averagePredicted,
      };
    });
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}
