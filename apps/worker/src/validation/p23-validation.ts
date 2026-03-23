import fs from 'fs';
import path from 'path';
import {
  buildDatasetQualityReport,
  DatasetQualityReport,
  persistDatasetQualityReport,
} from './dataset-quality';
import {
  WalkForwardSample,
  WalkForwardValidator,
} from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { ResearchGovernancePolicy } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { RobustnessSuite } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { MultiObjectivePromotionScore } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import {
  FeatureBuilder,
  SignalFeatures,
} from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { RegimeClassifier } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { PriorModel } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { PosteriorUpdate } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { RegimeConditionedEdgeModel } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { ExecutableEvModel } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import {
  EventMicrostructureFeatures,
  EventMicrostructureModel,
} from '@polymarket-btc-5m-agentic-bot/signal-engine';

const DEFAULT_DATASET_PATH = path.resolve(
  __dirname,
  './datasets/p23-empirical-validation.dataset.json',
);
const DEFAULT_EVIDENCE_DIR = path.resolve(
  __dirname,
  '../../../../artifacts/p23-validation',
);

type ValidationMode = 'empirical' | 'synthetic_smoke';

export interface HistoricalReplayFrame {
  replayKey: string;
  slug: string;
  tokenId: string;
  outcomeLabel: string;
  observedAt: string;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number;
  bidLevels: Array<{ price: number; size: number }>;
  askLevels: Array<{ price: number; size: number }>;
  topLevelDepth: number;
  combinedDepth: number;
  makerFeeRate: number;
  takerFeeRate: number;
  orderMinSize: number;
  tradeSize: number;
  fetchLatencyMs: number;
  timeoutCancelRisk: number;
  empiricalSlippage: number;
}

export interface HistoricalObservation {
  observationId: string;
  slug: string;
  question: string;
  conditionId: string;
  outcomeLabels: string[];
  marketStartAt: string;
  marketEndAt: string;
  observedAt: string;
  marketDurationMinutes: number;
  upTokenId: string;
  marketImpliedProbabilityUp: number;
  realizedOutcomeUp: number;
  quoteHistoryContext: Array<{
    observedAt: string;
    probabilityUp: number;
  }>;
  venueSnapshot: {
    bestBid: number | null;
    bestAsk: number | null;
    quotedSpreadProxy: number;
    makerFeeRate: number;
    takerFeeRate: number;
    orderMinSize: number;
  };
  timeBucket: string;
  sourceKind: string;
  candleWindow: Array<{
    timestamp: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
}

export interface HistoricalValidationDataset {
  datasetType: 'empirical' | 'synthetic';
  datasetVersion: string;
  capturedAt: string;
  staleAfterHours: number;
  provenance: Record<string, string>;
  replayFrames: HistoricalReplayFrame[];
  observations: HistoricalObservation[];
}

export interface HistoricalExecutableCase {
  observationId: string;
  slug: string;
  observedAt: string;
  strategySide: 'UP' | 'DOWN';
  marketImpliedProbability: number;
  predictedProbability: number;
  realizedOutcome: number;
  expectedEdge: number;
  executableEv: number;
  costAdjustedEv: number;
  realizedReturn: number;
  fillRate: number;
  spreadCost: number;
  slippageCost: number;
  feeCost: number;
  latencyCost: number;
  timeoutCancelCost: number;
  replayKey: string;
  regime: string;
  liquidityBucket: string;
  timeBucket: string;
  marketStructureBucket: string;
  featureSnapshot: Pick<
    SignalFeatures,
    | 'rollingReturnPct'
    | 'lastReturnPct'
    | 'realizedVolatility'
    | 'spread'
    | 'topLevelDepth'
    | 'combinedDepth'
    | 'orderbookNoiseScore'
    | 'timeToExpirySeconds'
  >;
  microstructure: EventMicrostructureFeatures;
}

export interface RegimeHoldoutResult {
  regime: string;
  sampleCount: number;
  executableEdgeAvg: number;
  realizedReturnAvg: number;
  realizedVsExpected: number;
  passed: boolean;
}

export interface ExecutableEdgeStressScenario {
  scenarioKey: string;
  averageNetEdge: number;
  admittedCount: number;
  passed: boolean;
}

export interface CalibrationAudit {
  bucketCount: number;
  maxGap: number;
  averageGap: number;
}

export interface P23ValidationPayload {
  mode: ValidationMode;
  dataset: {
    path: string;
    datasetType: HistoricalValidationDataset['datasetType'];
    datasetVersion: string;
    capturedAt: string;
    staleAfterHours: number;
    observationCount: number;
    replayFrameCount: number;
  };
  datasetQuality: Pick<
    DatasetQualityReport,
    | 'verdict'
    | 'blockingReasons'
    | 'warnings'
    | 'quality'
    | 'coverage'
    | 'counts'
    | 'timeRange'
    | 'provenance'
    | 'biasRiskFlags'
    | 'reportPath'
  >;
  validation: ReturnType<WalkForwardValidator['validate']>;
  governance: ReturnType<ResearchGovernancePolicy['evaluate']>;
  robustness: ReturnType<RobustnessSuite['evaluate']>;
  promotion: ReturnType<MultiObjectivePromotionScore['evaluate']>;
  executableEdge: {
    caseCount: number;
    admittedCount: number;
    averageCostAdjustedEv: number;
    averageRealizedReturn: number;
    scenarios: ExecutableEdgeStressScenario[];
  };
  regimeHoldouts: RegimeHoldoutResult[];
  calibrationAudit: CalibrationAudit;
  evidence: {
    syntheticAllowed: boolean;
    evidencePath: string;
    empiricalEvidenceUsed: boolean;
  };
  passed: boolean;
}

function createSyntheticSamples(): WalkForwardSample[] {
  return Array.from({ length: 40 }, (_, index) => ({
    observedAt: new Date(Date.now() - (40 - index) * 300_000).toISOString(),
    expectedEdge: 0.018 + index * 0.0001,
    executableEv: 0.009 + index * 0.00005,
    costAdjustedEv: 0.009 + index * 0.00005,
    regime: index % 3 === 0 ? 'momentum_continuation' : 'low_volatility_drift',
    realizedReturn: 0.007 + index * 0.00004,
    fillRate: 0.72,
    predictedProbability: index % 2 === 0 ? 0.65 : 0.7,
    realizedOutcome: index % 10 < 7 ? 1 : 0,
    eventType: 'binary_event_contract',
    liquidityBucket: index % 2 === 0 ? 'deep' : 'medium',
    timeBucket: index % 3 === 0 ? 'us' : index % 3 === 1 ? 'europe' : 'asia',
    marketStructureBucket: index % 4 === 0 ? 'balanced' : 'boundary_stressed',
  }));
}

export function loadHistoricalValidationDataset(
  datasetPath = DEFAULT_DATASET_PATH,
  now = new Date(),
): HistoricalValidationDataset {
  if (!fs.existsSync(datasetPath)) {
    throw new Error(`historical_validation_dataset_missing:${datasetPath}`);
  }

  const raw = JSON.parse(fs.readFileSync(datasetPath, 'utf8')) as HistoricalValidationDataset;
  if (raw.datasetType !== 'empirical') {
    throw new Error(`historical_validation_dataset_not_empirical:${raw.datasetType}`);
  }

  const capturedAtMs = new Date(raw.capturedAt).getTime();
  if (!Number.isFinite(capturedAtMs)) {
    throw new Error('historical_validation_dataset_timestamp_invalid');
  }

  const staleAfterMs = Math.max(1, raw.staleAfterHours) * 60 * 60 * 1000;
  if (now.getTime() - capturedAtMs > staleAfterMs) {
    throw new Error('historical_validation_dataset_stale');
  }

  if (!Array.isArray(raw.observations) || raw.observations.length < 24) {
    throw new Error('historical_validation_dataset_insufficient_observations');
  }

  if (!Array.isArray(raw.replayFrames) || raw.replayFrames.length === 0) {
    throw new Error('historical_validation_dataset_missing_replay_frames');
  }

  return raw;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, value));
}

function computeSpread(observation: HistoricalObservation, replay: HistoricalReplayFrame): number {
  return Math.max(
    0.001,
    observation.venueSnapshot.quotedSpreadProxy || 0,
    replay.spread || 0,
  );
}

function liquidityBucketForReplay(replay: HistoricalReplayFrame): string {
  if (replay.topLevelDepth < 25 || replay.spread > 0.03) {
    return 'thin';
  }
  if (replay.topLevelDepth < 80 || replay.spread > 0.015) {
    return 'medium';
  }
  return 'deep';
}

export function buildEmpiricalWalkForwardSamples(dataset: HistoricalValidationDataset): {
  samples: WalkForwardSample[];
  executableCases: HistoricalExecutableCase[];
} {
  const featureBuilder = new FeatureBuilder();
  const regimeClassifier = new RegimeClassifier();
  const priorModel = new PriorModel();
  const posteriorUpdate = new PosteriorUpdate();
  const edgeModel = new RegimeConditionedEdgeModel();
  const executableEvModel = new ExecutableEvModel();
  const microstructureModel = new EventMicrostructureModel();

  const executableCases: HistoricalExecutableCase[] = [];
  const samples: WalkForwardSample[] = [];

  for (const [index, observation] of dataset.observations.entries()) {
    const replay = dataset.replayFrames[index % dataset.replayFrames.length];
    if (!replay || observation.candleWindow.length < 7) {
      continue;
    }

    const spread = computeSpread(observation, replay);
    const midpoint = clamp(observation.marketImpliedProbabilityUp, 0.01, 0.99);
    const bestBid = clamp(
      replay.bestBid ?? midpoint - spread / 2,
      0.001,
      0.999,
    );
    const bestAsk = clamp(
      replay.bestAsk ?? midpoint + spread / 2,
      0.001,
      0.999,
    );
    const orderbook = {
      bidLevels:
        replay.bidLevels.length > 0
          ? replay.bidLevels
          : [{ price: bestBid, size: Math.max(10, replay.topLevelDepth || 10) }],
      askLevels:
        replay.askLevels.length > 0
          ? replay.askLevels
          : [{ price: bestAsk, size: Math.max(10, replay.topLevelDepth || 10) }],
      spread,
    };

    const features = featureBuilder.build({
      candles: {
        symbol: 'BTCUSDT',
        timeframe: '5m',
        candles: observation.candleWindow,
      },
      orderbook,
      expiresAt: observation.marketEndAt,
    });
    features.timeToExpirySeconds = Math.max(
      0,
      Math.floor(
        (new Date(observation.marketEndAt).getTime() -
          new Date(observation.observedAt).getTime()) /
          1000,
      ),
    );

    const regime = regimeClassifier.classify(features);
    const prior = priorModel.evaluate(features, regime);
    const posterior = posteriorUpdate.apply({
      priorProbability: prior.probabilityUp,
      features,
      regime,
    });
    const microstructure = microstructureModel.derive({
      features,
      posteriorProbability: posterior.posteriorProbability,
      marketImpliedProbability: observation.marketImpliedProbabilityUp,
    });

    const tradeUp = posterior.posteriorProbability >= 0.5;
    const predictedProbability = tradeUp
      ? posterior.posteriorProbability
      : 1 - posterior.posteriorProbability;
    const marketImpliedProbability = tradeUp
      ? observation.marketImpliedProbabilityUp
      : 1 - observation.marketImpliedProbabilityUp;

    const edge = edgeModel.evaluate({
      priorProbability: prior.probabilityUp,
      posteriorProbability: predictedProbability,
      marketImpliedProbability,
      features,
      regime,
    });
    const executableEv = executableEvModel.calculate({
      directionalEdge: Math.abs(edge.edge),
      rawDirectionalEdge: Math.abs(edge.rawEdge),
      marketImpliedProbability,
      features,
      regime,
      feeRate: observation.venueSnapshot.takerFeeRate,
    });

    const realizedOutcome = tradeUp
      ? observation.realizedOutcomeUp
      : 1 - observation.realizedOutcomeUp;
    const feeCost = observation.venueSnapshot.takerFeeRate;
    const slippageCost = replay.empiricalSlippage;
    const spreadCost = spread * 0.25;
    const latencyCost = Math.min(0.015, replay.fetchLatencyMs / 25_000);
    const timeoutCancelCost = replay.timeoutCancelRisk * 0.03;
    const fillRate = clamp(
      executableEv.fillProbability * (1 - replay.timeoutCancelRisk * 0.2),
      0.1,
      0.98,
    );
    const realizedReturn =
      (realizedOutcome ? 1 - marketImpliedProbability : -marketImpliedProbability) -
      feeCost -
      slippageCost -
      spreadCost -
      latencyCost -
      timeoutCancelCost;
    const expectedEdge = predictedProbability - marketImpliedProbability;
    const costAdjustedEv =
      expectedEdge * fillRate -
      feeCost -
      slippageCost -
      spreadCost -
      latencyCost -
      timeoutCancelCost;

    const executableCase: HistoricalExecutableCase = {
      observationId: observation.observationId,
      slug: observation.slug,
      observedAt: observation.observedAt,
      strategySide: tradeUp ? 'UP' : 'DOWN',
      marketImpliedProbability,
      predictedProbability,
      realizedOutcome,
      expectedEdge,
      executableEv: executableEv.expectedEv,
      costAdjustedEv,
      realizedReturn,
      fillRate,
      spreadCost,
      slippageCost,
      feeCost,
      latencyCost,
      timeoutCancelCost,
      replayKey: replay.replayKey,
      regime: regime.label,
      liquidityBucket: liquidityBucketForReplay(replay),
      timeBucket: observation.timeBucket,
      marketStructureBucket: microstructure.structureBucket,
      featureSnapshot: {
        rollingReturnPct: features.rollingReturnPct,
        lastReturnPct: features.lastReturnPct,
        realizedVolatility: features.realizedVolatility,
        spread: features.spread,
        topLevelDepth: features.topLevelDepth,
        combinedDepth: features.combinedDepth,
        orderbookNoiseScore: features.orderbookNoiseScore,
        timeToExpirySeconds: features.timeToExpirySeconds,
      },
      microstructure,
    };
    executableCases.push(executableCase);

    samples.push({
      observedAt: observation.observedAt,
      expectedEdge,
      executableEv: executableEv.expectedEv,
      costAdjustedEv,
      regime: regime.label,
      realizedReturn,
      fillRate,
      predictedProbability,
      realizedOutcome,
      eventType: microstructure.eventType,
      liquidityBucket: executableCase.liquidityBucket,
      timeBucket: observation.timeBucket,
      marketStructureBucket: microstructure.structureBucket,
    });
  }

  return { samples, executableCases };
}

export function evaluateRegimeHoldouts(
  executableCases: HistoricalExecutableCase[],
): RegimeHoldoutResult[] {
  const buckets = new Map<
    string,
    { sampleCount: number; executableEdgeSum: number; realizedReturnSum: number }
  >();

  for (const entry of executableCases) {
    const bucket = buckets.get(entry.regime) ?? {
      sampleCount: 0,
      executableEdgeSum: 0,
      realizedReturnSum: 0,
    };
    bucket.sampleCount += 1;
    bucket.executableEdgeSum += entry.costAdjustedEv;
    bucket.realizedReturnSum += entry.realizedReturn;
    buckets.set(entry.regime, bucket);
  }

  return Array.from(buckets.entries()).map(([regime, bucket]) => {
    const executableEdgeAvg =
      bucket.sampleCount > 0 ? bucket.executableEdgeSum / bucket.sampleCount : 0;
    const realizedReturnAvg =
      bucket.sampleCount > 0 ? bucket.realizedReturnSum / bucket.sampleCount : 0;
    const realizedVsExpected =
      Math.abs(bucket.executableEdgeSum) > 1e-9
        ? bucket.realizedReturnSum / bucket.executableEdgeSum
        : 0;
    return {
      regime,
      sampleCount: bucket.sampleCount,
      executableEdgeAvg,
      realizedReturnAvg,
      realizedVsExpected,
      passed:
        bucket.sampleCount >= 2 &&
        executableEdgeAvg > -0.08 &&
        realizedReturnAvg > -0.25 &&
        realizedVsExpected > -0.75,
    };
  });
}

export function evaluateExecutableEdgeOnHistoricalCases(
  executableCases: HistoricalExecutableCase[],
): {
  caseCount: number;
  admittedCount: number;
  averageCostAdjustedEv: number;
  averageRealizedReturn: number;
  scenarios: ExecutableEdgeStressScenario[];
} {
  const admitted = executableCases.filter((entry) => entry.costAdjustedEv > 0.0025);
  const averageCostAdjustedEv =
    executableCases.length > 0
      ? executableCases.reduce((sum, entry) => sum + entry.costAdjustedEv, 0) /
        executableCases.length
      : 0;
  const averageRealizedReturn =
    executableCases.length > 0
      ? executableCases.reduce((sum, entry) => sum + entry.realizedReturn, 0) /
        executableCases.length
      : 0;

  const scenarios: ExecutableEdgeStressScenario[] = [
    {
      scenarioKey: 'historical_baseline',
      averageNetEdge: averageCostAdjustedEv,
      admittedCount: admitted.length,
      passed: executableCases.length > 0,
    },
    {
      scenarioKey: 'spread_stress',
      averageNetEdge: averageStressNetEdge(executableCases, (entry) => entry.spreadCost * 1.5),
      admittedCount: stressAdmissionCount(executableCases, (entry) => entry.spreadCost * 1.5),
      passed: executableCases.length > 0,
    },
    {
      scenarioKey: 'slippage_stress',
      averageNetEdge: averageStressNetEdge(
        executableCases,
        (entry) => entry.slippageCost * 1.75,
      ),
      admittedCount: stressAdmissionCount(
        executableCases,
        (entry) => entry.slippageCost * 1.75,
      ),
      passed: executableCases.length > 0,
    },
    {
      scenarioKey: 'fee_latency_timeout_stress',
      averageNetEdge: averageStressNetEdge(
        executableCases,
        (entry) =>
          entry.feeCost * 1.25 +
          entry.latencyCost * 1.5 +
          entry.timeoutCancelCost * 1.5,
      ),
      admittedCount: stressAdmissionCount(
        executableCases,
        (entry) =>
          entry.feeCost * 1.25 +
          entry.latencyCost * 1.5 +
          entry.timeoutCancelCost * 1.5,
      ),
      passed: executableCases.length > 0,
    },
  ];

  return {
    caseCount: executableCases.length,
    admittedCount: admitted.length,
    averageCostAdjustedEv,
    averageRealizedReturn,
    scenarios,
  };
}

function averageStressNetEdge(
  executableCases: HistoricalExecutableCase[],
  stressCost: (entry: HistoricalExecutableCase) => number,
): number {
  if (executableCases.length === 0) {
    return 0;
  }

  return (
    executableCases.reduce(
      (sum, entry) =>
        sum +
        (entry.expectedEdge * entry.fillRate -
          stressCost(entry) -
          entry.feeCost -
          entry.latencyCost),
      0,
    ) / executableCases.length
  );
}

function stressAdmissionCount(
  executableCases: HistoricalExecutableCase[],
  stressCost: (entry: HistoricalExecutableCase) => number,
): number {
  return executableCases.filter(
    (entry) =>
      entry.expectedEdge * entry.fillRate -
        stressCost(entry) -
        entry.feeCost -
        entry.latencyCost >
      0.0025,
  ).length;
}

export function buildCalibrationAudit(
  validation: ReturnType<WalkForwardValidator['validate']>,
): CalibrationAudit {
  const averageGap =
    validation.calibration.length > 0
      ? validation.calibration.reduce(
          (sum, bucket) => sum + Math.abs(bucket.calibrationGap),
          0,
        ) / validation.calibration.length
      : 0;

  return {
    bucketCount: validation.calibration.length,
    maxGap: validation.maxCalibrationGap,
    averageGap,
  };
}

function persistValidationEvidence(
  evidenceDir: string,
  payload: P23ValidationPayload,
): string {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const filePath = path.join(evidenceDir, 'latest.json');
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}

export async function runP23Validation(options?: {
  datasetPath?: string;
  evidenceDir?: string;
  mode?: ValidationMode;
  allowSyntheticSmoke?: boolean;
  now?: Date;
}): Promise<P23ValidationPayload> {
  const validator = new WalkForwardValidator();
  const governancePolicy = new ResearchGovernancePolicy();
  const robustnessSuite = new RobustnessSuite();
  const promotionScore = new MultiObjectivePromotionScore();
  const mode = options?.mode ?? 'empirical';

  if (mode === 'synthetic_smoke' && !options?.allowSyntheticSmoke) {
    throw new Error('synthetic_validation_requires_explicit_allowance');
  }

  let datasetSummary: P23ValidationPayload['dataset'];
  let datasetQuality: P23ValidationPayload['datasetQuality'];
  let samples: WalkForwardSample[];
  let executableCases: HistoricalExecutableCase[];

  if (mode === 'synthetic_smoke') {
    samples = createSyntheticSamples();
    executableCases = [];
    datasetSummary = {
      path: options?.datasetPath ?? 'in-memory-synthetic-smoke',
      datasetType: 'synthetic',
      datasetVersion: 'synthetic-smoke-v1',
      capturedAt: new Date().toISOString(),
      staleAfterHours: 0,
      observationCount: samples.length,
      replayFrameCount: 0,
    };
    datasetQuality = {
      verdict: 'accepted_with_warnings',
      blockingReasons: [],
      warnings: ['synthetic_smoke_dataset_not_eligible_for_promotion'],
      quality: {
        missingCriticalFieldRate: 0,
        duplicateObservationRate: 0,
        duplicateReplayRate: 0,
        staleFeatureRate: 0,
      },
      coverage: {
        regimes: [],
        timeBuckets: [],
        sourceKinds: [],
        liquidityBuckets: [],
        marketStructureBuckets: [],
      },
      counts: {
        observations: samples.length,
        replayFrames: 0,
        executableCases: 0,
        distinctMarkets: 0,
      },
      timeRange: {
        startAt: null,
        endAt: null,
        coveredHours: 0,
      },
      provenance: {
        sources: {},
        sourceCount: 0,
        collectionMethod: ['synthetic_smoke_fixture'],
      },
      biasRiskFlags: ['synthetic_dataset'],
      reportPath: path.join(options?.evidenceDir ?? DEFAULT_EVIDENCE_DIR, 'dataset-quality.latest.json'),
    };
  } else {
    const dataset = loadHistoricalValidationDataset(
      options?.datasetPath ?? DEFAULT_DATASET_PATH,
      options?.now,
    );
    const built = buildEmpiricalWalkForwardSamples(dataset);
    samples = built.samples;
    executableCases = built.executableCases;
    datasetSummary = {
      path: options?.datasetPath ?? DEFAULT_DATASET_PATH,
      datasetType: dataset.datasetType,
      datasetVersion: dataset.datasetVersion,
      capturedAt: dataset.capturedAt,
      staleAfterHours: dataset.staleAfterHours,
      observationCount: dataset.observations.length,
      replayFrameCount: dataset.replayFrames.length,
    };

    if (samples.length < 24) {
      throw new Error('historical_validation_dataset_failed_to_build_samples');
    }

    const datasetQualityReportPath = path.join(
      options?.evidenceDir ?? DEFAULT_EVIDENCE_DIR,
      'dataset-quality.latest.json',
    );
    datasetQuality = persistDatasetQualityReport(
      datasetQualityReportPath,
      buildDatasetQualityReport({
        dataset,
        datasetPath: options?.datasetPath ?? DEFAULT_DATASET_PATH,
        executableCases,
        reportPath: datasetQualityReportPath,
        now: options?.now,
      }),
    );
  }

  const validation = validator.validate({
    samples,
    minimumSamples: mode === 'empirical' ? 24 : 24,
    trainWindowSize: mode === 'empirical' ? 12 : 12,
    validationWindowSize: 6,
    testWindowSize: 6,
    stepSize: 6,
  });
  const governance = governancePolicy.evaluate({
    strategyVersionId: 'validation-strategy',
    edgeDefinitionVersion: 'btc-5m-polymarket-edge-v1',
    validation,
  });
  const robustness = robustnessSuite.evaluate({
    realizedVsExpected: validation.aggregate.realizedVsExpected,
    worstWindowEv: validation.aggregate.worstWindowEv,
    calibrationGap: validation.maxCalibrationGap,
    segmentCoverage: validation.segmentCoverage,
  });
  const promotion = promotionScore.evaluate({
    governanceConfidence: governance.confidence,
    robustnessScore: robustness.score,
    realizedVsExpected: validation.aggregate.realizedVsExpected,
    calibrationGap: validation.maxCalibrationGap,
    auditCoverage: mode === 'empirical' ? 1 : 0,
  });
  const executableEdge = evaluateExecutableEdgeOnHistoricalCases(executableCases);
  const regimeHoldouts = evaluateRegimeHoldouts(executableCases);
  const calibrationAudit = buildCalibrationAudit(validation);

  const provisionalPayload: P23ValidationPayload = {
    mode,
    dataset: datasetSummary,
    datasetQuality,
    validation,
    governance,
    robustness,
    promotion,
    executableEdge,
    regimeHoldouts,
    calibrationAudit,
    evidence: {
      syntheticAllowed: options?.allowSyntheticSmoke === true,
      evidencePath: '',
      empiricalEvidenceUsed: mode === 'empirical',
    },
    passed:
      mode === 'empirical' &&
      datasetQuality.verdict === 'accepted' &&
      validation.tradeAllowed &&
      governance.promotionEligible &&
      robustness.passed &&
      promotion.promoted,
  };

  const evidencePath = persistValidationEvidence(
    options?.evidenceDir ?? DEFAULT_EVIDENCE_DIR,
    provisionalPayload,
  );

  const finalPayload = {
    ...provisionalPayload,
    evidence: {
      ...provisionalPayload.evidence,
      evidencePath,
    },
  };
  fs.writeFileSync(evidencePath, JSON.stringify(finalPayload, null, 2));

  return finalPayload;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const syntheticMode = args.includes('--smoke=synthetic');
  const payload = await runP23Validation({
    mode: syntheticMode ? 'synthetic_smoke' : 'empirical',
    allowSyntheticSmoke: syntheticMode,
  });

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (!payload.passed) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
