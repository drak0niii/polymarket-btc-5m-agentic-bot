export interface WalkForwardSpec {
  version: string;
  trainWindowSize: number;
  validationWindowSize: number;
  testWindowSize: number;
  stepSize: number;
  minimumSamples: number;
  anchored: boolean;
}

export type SegmentationDimension =
  | 'regime'
  | 'event_type'
  | 'liquidity'
  | 'time_of_day'
  | 'market_structure';

export interface ValidationSegmentResult {
  dimension: SegmentationDimension;
  bucket: string;
  sampleCount: number;
  expectedEvAvg: number;
  realizedEvAvg: number;
  fillRate: number;
}

export interface CalibrationBucketResult {
  bucketLabel: string;
  lowerBound: number;
  upperBound: number;
  sampleCount: number;
  averagePredicted: number;
  averageObserved: number;
  calibrationGap: number;
}

export interface ResearchGovernanceRecord {
  strategyVersionId: string | null;
  edgeDefinitionVersion: string;
  windowSpec: WalkForwardSpec;
  segmentation: ValidationSegmentResult[];
  calibration: CalibrationBucketResult[];
  costModelVersion: string;
  calibrationVersion: string;
  confidence: number;
  promotionEligible: boolean;
  failReasons: string[];
  createdAt: string;
}
