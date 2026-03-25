import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BuildSignalsJob } from '../jobs/buildSignals.job';
import { LearningStateStore } from '../runtime/learning-state-store';
import { VersionLineageRegistry } from '../runtime/version-lineage-registry';
import {
  BtcPolymarketLinkage,
  BtcPolymarketTransmissionV2,
  EdgeDecayProfile,
  FeatureBuilder,
  FlowFeaturesCalculator,
  FlowPersistenceReversal,
  MarketArchetypeClassifier,
  MarketStateTransitionModel,
  PosteriorUpdate,
  PriorModel,
  RegimeClassifier,
} from '@polymarket-btc-5m-agentic-bot/signal-engine';

async function testFlowFeaturesModuleComputesProxyAndStress(): Promise<void> {
  const calculator = new FlowFeaturesCalculator();
  const result = calculator.derive({
    lastReturnPct: 0.003,
    rollingReturnPct: 0.008,
    volumeTrend: 0.65,
    topLevelImbalance: 0.22,
    micropriceBias: 0.03,
    spreadToDepthRatio: 0.0006,
    depthConcentration: 0.78,
    orderbookNoiseScore: 0.24,
  });

  assert.strictEqual(result.flowImbalanceProxy > 0, true);
  assert.strictEqual(result.flowIntensity > 0.3, true);
  assert.strictEqual(result.bookUpdateStress > 0.7, true);
}

async function testBtcPolymarketLinkageReflectsAlignment(): Promise<void> {
  const linkage = new BtcPolymarketLinkage();
  const aligned = linkage.evaluate({
    lastReturnPct: 0.002,
    rollingReturnPct: 0.007,
    midpointDriftPct: 0.004,
    topLevelImbalance: 0.12,
    micropriceBias: 0.02,
    flowImbalanceProxy: 0.4,
    bookUpdateStress: 0.2,
  });
  const divergent = linkage.evaluate({
    lastReturnPct: 0.002,
    rollingReturnPct: 0.007,
    midpointDriftPct: -0.004,
    topLevelImbalance: -0.05,
    micropriceBias: -0.03,
    flowImbalanceProxy: -0.25,
    bookUpdateStress: 0.25,
  });

  assert.strictEqual(aligned.btcMoveTransmission > 0, true);
  assert.strictEqual(divergent.btcMoveTransmission < 0, true);
  assert.strictEqual(aligned.btcLinkageConfidence >= divergent.btcLinkageConfidence, true);
}

async function testBtcPolymarketTransmissionV2CapturesLagSensitivityDivergenceAndConsistency(): Promise<void> {
  const transmission = new BtcPolymarketTransmissionV2();
  const coherent = transmission.evaluate({
    recentBtcReturns: [0.0012, 0.0018, 0.0024, 0.0031, 0.0036],
    lastReturnPct: 0.0034,
    rollingReturnPct: 0.0088,
    midpointDriftPct: 0.0048,
    micropriceBias: 0.004,
    flowImbalanceProxy: 0.04,
    bookUpdateStress: 0.18,
  });
  const divergent = transmission.evaluate({
    recentBtcReturns: [0.0022, 0.0028, 0.0031, 0.0034, 0.0037],
    lastReturnPct: 0.0035,
    rollingReturnPct: 0.0091,
    midpointDriftPct: -0.0014,
    micropriceBias: -0.012,
    flowImbalanceProxy: -0.22,
    bookUpdateStress: 0.42,
  });

  assert.strictEqual(coherent.laggedBtcMoveTransmission > 0, true);
  assert.strictEqual(coherent.nonlinearBtcMoveSensitivity > 0.35, true);
  assert.strictEqual(divergent.btcPathDivergence > coherent.btcPathDivergence, true);
  assert.strictEqual(
    coherent.transmissionConsistency > divergent.transmissionConsistency,
    true,
  );
}

async function testFlowPersistenceReversalCapturesPersistenceAndReversalPressure(): Promise<void> {
  const model = new FlowPersistenceReversal();
  const persistent = model.evaluate({
    recentReturns: [0.0011, 0.0015, 0.0019, 0.0022, 0.0026],
    topLevelImbalance: 0.32,
    micropriceBias: 0.08,
    flowImbalanceProxy: 0.38,
    flowIntensity: 0.42,
    spreadToDepthRatio: 0.00018,
    depthConcentration: 0.41,
    orderbookNoiseScore: 0.16,
    bidLevels: [
      { price: 0.5, size: 22 },
      { price: 0.49, size: 15 },
      { price: 0.48, size: 11 },
    ],
    askLevels: [
      { price: 0.51, size: 13 },
      { price: 0.52, size: 8 },
      { price: 0.53, size: 5 },
    ],
  });
  const unstable = model.evaluate({
    recentReturns: [0.0021, -0.0018, 0.0024, -0.0022, 0.0016],
    topLevelImbalance: 0.05,
    micropriceBias: -0.09,
    flowImbalanceProxy: -0.12,
    flowIntensity: 0.31,
    spreadToDepthRatio: 0.0012,
    depthConcentration: 0.78,
    orderbookNoiseScore: 0.84,
    bidLevels: [
      { price: 0.5, size: 9 },
      { price: 0.49, size: 5 },
    ],
    askLevels: [
      { price: 0.51, size: 17 },
      { price: 0.52, size: 4 },
    ],
  });

  assert.strictEqual(
    persistent.imbalancePersistence > unstable.imbalancePersistence,
    true,
  );
  assert.strictEqual(
    unstable.imbalanceReversalProbability >
      persistent.imbalanceReversalProbability,
    true,
  );
  assert.strictEqual(
    unstable.quoteInstabilityBeforeMove >
      persistent.quoteInstabilityBeforeMove,
    true,
  );
  assert.strictEqual(persistent.depthDepletionAsymmetry > 0, true);
}

async function testMarketStateTransitionClassifiesAccelerationAndReversion(): Promise<void> {
  const model = new MarketStateTransitionModel();
  const acceleration = model.classify({
    lastReturnPct: 0.0035,
    rollingReturnPct: 0.005,
    realizedVolatility: 0.0014,
    flowImbalanceProxy: 0.42,
    bookUpdateStress: 0.2,
    btcMoveTransmission: 0.4,
  });
  const reversion = model.classify({
    lastReturnPct: -0.0038,
    rollingReturnPct: 0.0045,
    realizedVolatility: 0.0014,
    flowImbalanceProxy: -0.35,
    bookUpdateStress: 0.22,
    btcMoveTransmission: -0.2,
  });

  assert.strictEqual(acceleration.marketStateTransition, 'trend_acceleration');
  assert.strictEqual(reversion.marketStateTransition, 'mean_reversion');
}

async function testEdgeDecayProfileRisesUnderExpiryAndStress(): Promise<void> {
  const profile = new EdgeDecayProfile();
  const lowPressure = profile.evaluate({
    timeToExpirySeconds: 240,
    realizedVolatility: 0.0007,
    realizedRangePct: 0.0011,
    orderbookNoiseScore: 0.12,
    bookUpdateStress: 0.18,
    marketStateTransition: 'range_balance',
    flowIntensity: 0.18,
    sampleCount: 32,
  });
  const highPressure = profile.evaluate({
    timeToExpirySeconds: 70,
    realizedVolatility: 0.0019,
    realizedRangePct: 0.0032,
    orderbookNoiseScore: 0.3,
    bookUpdateStress: 0.86,
    marketStateTransition: 'stress_transition',
    flowIntensity: 0.72,
    sampleCount: 12,
  });

  assert.strictEqual(highPressure.signalDecayPressure > lowPressure.signalDecayPressure, true);
  assert.strictEqual(highPressure.signalDecayPressure > 0.65, true);
}

async function testMarketArchetypeClassifierSeparatesContexts(): Promise<void> {
  const classifier = new MarketArchetypeClassifier();
  const trend = classifier.classify({
    flowImbalanceProxy: 0.45,
    flowIntensity: 0.52,
    bookUpdateStress: 0.2,
    btcMoveTransmission: 0.35,
    signalDecayPressure: 0.28,
    marketStateTransition: 'trend_acceleration',
    realizedVolatility: 0.0014,
    timeToExpirySeconds: 180,
  });
  const stressed = classifier.classify({
    flowImbalanceProxy: 0.1,
    flowIntensity: 0.3,
    bookUpdateStress: 0.9,
    btcMoveTransmission: 0.02,
    signalDecayPressure: 0.55,
    marketStateTransition: 'stress_transition',
    realizedVolatility: 0.0025,
    timeToExpirySeconds: 180,
  });

  assert.strictEqual(trend.marketArchetype, 'trend_follow_through');
  assert.strictEqual(stressed.marketArchetype, 'stressed_microstructure');
}

async function testFeatureBuilderRegressionPopulatesConsumedPhaseTwoFields(): Promise<void> {
  const builder = new FeatureBuilder();
  const features = builder.build({
    candles: buildBtcCandleSeries(),
    orderbook: buildConcentratedOrderbook(),
    expiresAt: new Date(Date.now() + 90_000).toISOString(),
  });

  assert.strictEqual(Number.isFinite(features.flowImbalanceProxy), true);
  assert.strictEqual(Number.isFinite(features.bookUpdateStress), true);
  assert.strictEqual(Number.isFinite(features.btcMoveTransmission), true);
  assert.strictEqual(Number.isFinite(features.laggedBtcMoveTransmission), true);
  assert.strictEqual(Number.isFinite(features.nonlinearBtcMoveSensitivity), true);
  assert.strictEqual(Number.isFinite(features.btcPathDivergence), true);
  assert.strictEqual(Number.isFinite(features.transmissionConsistency), true);
  assert.strictEqual(Number.isFinite(features.imbalancePersistence), true);
  assert.strictEqual(
    Number.isFinite(features.imbalanceReversalProbability),
    true,
  );
  assert.strictEqual(
    Number.isFinite(features.quoteInstabilityBeforeMove),
    true,
  );
  assert.strictEqual(Number.isFinite(features.depthDepletionAsymmetry), true);
  assert.strictEqual(Number.isFinite(features.signalDecayPressure), true);
  assert.strictEqual(typeof features.marketStateTransition, 'string');
  assert.strictEqual(typeof features.marketArchetype, 'string');
}

async function testPriorAndPosteriorUsePhaseTwoContext(): Promise<void> {
  const builder = new FeatureBuilder();
  const priorModel = new PriorModel();
  const posteriorUpdate = new PosteriorUpdate();
  const regimeClassifier = new RegimeClassifier();

  const supportive = builder.build({
    candles: buildBtcCandleSeries(),
    orderbook: buildBalancedOrderbook(),
    expiresAt: new Date(Date.now() + 180_000).toISOString(),
  });
  const stressed = builder.build({
    candles: buildBtcCandleSeries(),
    orderbook: buildConcentratedOrderbook(),
    expiresAt: new Date(Date.now() + 90_000).toISOString(),
  });

  const supportiveRegime = regimeClassifier.classify(supportive);
  const stressedRegime = regimeClassifier.classify(stressed);
  const supportivePrior = priorModel.evaluate(supportive, supportiveRegime);
  const stressedPrior = priorModel.evaluate(stressed, stressedRegime);
  const coherentTransmissionPrior = priorModel.evaluate(
    {
      ...supportive,
      laggedBtcMoveTransmission: 0.58,
      nonlinearBtcMoveSensitivity: 0.82,
      btcPathDivergence: 0.11,
      transmissionConsistency: 0.79,
      btcMoveTransmission: 0.41,
      btcLinkageConfidence: 0.83,
      imbalancePersistence: 0.82,
      imbalanceReversalProbability: 0.14,
      quoteInstabilityBeforeMove: 0.18,
      depthDepletionAsymmetry: 0.33,
    },
    supportiveRegime,
  );
  const divergentTransmissionPrior = priorModel.evaluate(
    {
      ...supportive,
      laggedBtcMoveTransmission: -0.34,
      nonlinearBtcMoveSensitivity: 0.74,
      btcPathDivergence: 0.82,
      transmissionConsistency: 0.17,
      btcMoveTransmission: -0.19,
      btcLinkageConfidence: 0.44,
      imbalancePersistence: 0.22,
      imbalanceReversalProbability: 0.77,
      quoteInstabilityBeforeMove: 0.72,
      depthDepletionAsymmetry: -0.28,
    },
    supportiveRegime,
  );
  const supportivePosterior = posteriorUpdate.apply({
    priorProbability: supportivePrior.probabilityUp,
    features: supportive,
    regime: supportiveRegime,
  });
  const stressedPosterior = posteriorUpdate.apply({
    priorProbability: stressedPrior.probabilityUp,
    features: stressed,
    regime: stressedRegime,
  });
  const coherentTransmissionPosterior = posteriorUpdate.apply({
    priorProbability: coherentTransmissionPrior.probabilityUp,
    features: {
      ...supportive,
      laggedBtcMoveTransmission: 0.58,
      nonlinearBtcMoveSensitivity: 0.82,
      btcPathDivergence: 0.11,
      transmissionConsistency: 0.79,
      btcMoveTransmission: 0.41,
      btcLinkageConfidence: 0.83,
      imbalancePersistence: 0.82,
      imbalanceReversalProbability: 0.14,
      quoteInstabilityBeforeMove: 0.18,
      depthDepletionAsymmetry: 0.33,
    },
    regime: supportiveRegime,
  });
  const divergentTransmissionPosterior = posteriorUpdate.apply({
    priorProbability: divergentTransmissionPrior.probabilityUp,
    features: {
      ...supportive,
      laggedBtcMoveTransmission: -0.34,
      nonlinearBtcMoveSensitivity: 0.74,
      btcPathDivergence: 0.82,
      transmissionConsistency: 0.17,
      btcMoveTransmission: -0.19,
      btcLinkageConfidence: 0.44,
      imbalancePersistence: 0.22,
      imbalanceReversalProbability: 0.77,
      quoteInstabilityBeforeMove: 0.72,
      depthDepletionAsymmetry: -0.28,
    },
    regime: supportiveRegime,
  });

  assert.ok(supportivePrior.components);
  assert.ok(stressedPosterior.adjustments);
  assert.strictEqual(
    coherentTransmissionPrior.components.transmissionLagComponent >
      divergentTransmissionPrior.components.transmissionLagComponent,
    true,
  );
  assert.strictEqual(
    coherentTransmissionPrior.components.transmissionDivergencePenalty <
      divergentTransmissionPrior.components.transmissionDivergencePenalty,
    true,
  );
  assert.strictEqual(
    coherentTransmissionPrior.components.imbalancePersistenceComponent >
      divergentTransmissionPrior.components.imbalancePersistenceComponent,
    true,
  );
  assert.strictEqual(
    coherentTransmissionPrior.components.imbalanceReversalPenalty <
      divergentTransmissionPrior.components.imbalanceReversalPenalty,
    true,
  );
  assert.strictEqual(
    stressedPrior.components.decayPenalty > supportivePrior.components.decayPenalty,
    true,
  );
  assert.strictEqual(
    stressedPosterior.adjustments.instabilityPenalty >
      supportivePosterior.adjustments.instabilityPenalty,
    true,
  );
  assert.strictEqual(
    coherentTransmissionPosterior.adjustments.transmissionLagAdjustment >
      divergentTransmissionPosterior.adjustments.transmissionLagAdjustment,
    true,
  );
  assert.strictEqual(
    coherentTransmissionPosterior.adjustments.transmissionDivergencePenalty <
      divergentTransmissionPosterior.adjustments.transmissionDivergencePenalty,
    true,
  );
  assert.strictEqual(
    coherentTransmissionPosterior.adjustments.imbalancePersistenceAdjustment >
      divergentTransmissionPosterior.adjustments.imbalancePersistenceAdjustment,
    true,
  );
  assert.strictEqual(
    coherentTransmissionPosterior.adjustments.imbalanceReversalPenalty <
      divergentTransmissionPosterior.adjustments.imbalanceReversalPenalty,
    true,
  );
  assert.strictEqual(
    Math.abs(
      supportivePosterior.posteriorProbability -
        stressedPosterior.posteriorProbability,
    ) > 1e-9,
    true,
  );
}

async function testBuildSignalsRecordsPhaseTwoContextAndUsesItForDecisioning(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-build-signals-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const versionLineageRegistry = new VersionLineageRegistry(rootDir);
  const auditEvents: Array<Record<string, unknown>> = [];
  const createdSignals: Array<Record<string, unknown>> = [];
  const createdSignalDecisions: Array<Record<string, unknown>> = [];

  const prisma = {
    strategyVersion: {
      findFirst: async () => ({ id: 'strategy-live-1' }),
    },
    market: {
      findMany: async () => [
        {
          id: 'm1',
          slug: 'btc-5m-higher',
          title: 'Will BTC be higher in 5 minutes?',
          status: 'active',
          tokenIdYes: 'yes1',
          tokenIdNo: 'no1',
          expiresAt: new Date(Date.now() + 90_000),
          updatedAt: new Date(),
        },
      ],
    },
    orderbook: {
      findFirst: async () => ({
        ...buildConcentratedOrderbook(),
        tickSize: 0.01,
        minOrderSize: 1,
        negRisk: false,
        observedAt: new Date(),
      }),
    },
    marketSnapshot: {
      findFirst: async () => ({
        observedAt: new Date(),
        expiresAt: new Date(Date.now() + 90_000),
        volume: 650,
      }),
    },
    signal: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdSignals.push(data);
      },
    },
    signalDecision: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdSignalDecisions.push(data);
      },
    },
    auditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        auditEvents.push(data);
      },
    },
  };

  const job = new BuildSignalsJob(
    prisma as never,
    undefined,
    learningStateStore,
    versionLineageRegistry,
  );
  const result = await job.run(buildBtcReference());

  assert.strictEqual(result.created, 0);
  assert.strictEqual(createdSignals.length, 1);
  assert.strictEqual(createdSignals[0]?.status, 'rejected');
  assert.strictEqual(createdSignalDecisions.length, 1);
  const edgeAudit = auditEvents.find(
    (event) => event.eventType === 'signal.edge_assessed',
  );
  const admissionAudit = auditEvents.find(
    (event) => event.eventType === 'signal.admission_decision',
  );
  const edgeMetadata =
    edgeAudit && typeof edgeAudit.metadata === 'object'
      ? (edgeAudit.metadata as Record<string, unknown>)
      : null;
  const admissionMetadata =
    admissionAudit && typeof admissionAudit.metadata === 'object'
      ? (admissionAudit.metadata as Record<string, unknown>)
      : null;
  const phaseTwoContext =
    edgeMetadata?.phaseTwoContext &&
    typeof edgeMetadata.phaseTwoContext === 'object'
      ? (edgeMetadata.phaseTwoContext as Record<string, unknown>)
      : null;

  assert.ok(phaseTwoContext);
  assert.strictEqual((phaseTwoContext?.bookUpdateStress as number) > 0.72, true);
  assert.strictEqual(phaseTwoContext?.marketArchetype, 'expiry_pressure');
  assert.strictEqual(
    Number.isFinite(phaseTwoContext?.laggedBtcMoveTransmission as number),
    true,
  );
  assert.strictEqual(
    Number.isFinite(phaseTwoContext?.nonlinearBtcMoveSensitivity as number),
    true,
  );
  assert.strictEqual(
    Number.isFinite(phaseTwoContext?.btcPathDivergence as number),
    true,
  );
  assert.strictEqual(
    Number.isFinite(phaseTwoContext?.transmissionConsistency as number),
    true,
  );
  assert.strictEqual(
    Number.isFinite(phaseTwoContext?.imbalancePersistence as number),
    true,
  );
  assert.strictEqual(
    Number.isFinite(phaseTwoContext?.imbalanceReversalProbability as number),
    true,
  );
  assert.strictEqual(
    Number.isFinite(phaseTwoContext?.quoteInstabilityBeforeMove as number),
    true,
  );
  assert.strictEqual(
    Number.isFinite(phaseTwoContext?.depthDepletionAsymmetry as number),
    true,
  );
  assert.strictEqual(admissionMetadata?.phaseTwoContext != null, true);
}

function buildBtcReference() {
  return {
    symbol: 'BTCUSD',
    spotPrice: 105_000,
    candles: buildBtcCandleSeries().candles,
    observedAt: new Date().toISOString(),
  };
}

function buildBtcCandleSeries() {
  const candles: Array<{
    timestamp: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }> = [];
  let price = 100;

  for (let index = 0; index < 24; index += 1) {
    const open = price;
    const close = open + 0.8 + index * 0.06;
    candles.push({
      timestamp: new Date(Date.now() - (24 - index) * 5 * 60_000).toISOString(),
      open,
      high: close + 0.12,
      low: open - 0.08,
      close,
      volume: 70 + index * 5,
    });
    price = close;
  }

  return {
    symbol: 'BTCUSD',
    timeframe: '5m',
    candles,
  };
}

function buildBalancedOrderbook() {
  return {
    bestBid: 0.5,
    bestAsk: 0.51,
    spread: 0.01,
    bidLevels: [
      { price: 0.5, size: 18 },
      { price: 0.49, size: 14 },
      { price: 0.48, size: 10 },
    ],
    askLevels: [
      { price: 0.51, size: 17 },
      { price: 0.52, size: 14 },
      { price: 0.53, size: 11 },
    ],
  };
}

function buildConcentratedOrderbook() {
  return {
    bestBid: 0.5,
    bestAsk: 0.51,
    spread: 0.01,
    bidLevels: [
      { price: 0.5, size: 20 },
      { price: 0.49, size: 5 },
    ],
    askLevels: [
      { price: 0.51, size: 20 },
      { price: 0.52, size: 5 },
    ],
  };
}

export const phaseTwoFeatureEnrichmentTests = [
  {
    name: 'phase2 flow features compute imbalance proxy and book stress',
    fn: testFlowFeaturesModuleComputesProxyAndStress,
  },
  {
    name: 'phase2 btc linkage reflects alignment and divergence',
    fn: testBtcPolymarketLinkageReflectsAlignment,
  },
  {
    name: 'item10 btc polymarket transmission v2 captures richer transmission context',
    fn: testBtcPolymarketTransmissionV2CapturesLagSensitivityDivergenceAndConsistency,
  },
  {
    name: 'item11 flow persistence reversal captures richer short horizon flow context',
    fn: testFlowPersistenceReversalCapturesPersistenceAndReversalPressure,
  },
  {
    name: 'phase2 market state transition classifies acceleration and reversion',
    fn: testMarketStateTransitionClassifiesAccelerationAndReversion,
  },
  {
    name: 'phase2 edge decay profile rises under expiry and stress',
    fn: testEdgeDecayProfileRisesUnderExpiryAndStress,
  },
  {
    name: 'phase2 market archetype classifier separates contexts',
    fn: testMarketArchetypeClassifierSeparatesContexts,
  },
  {
    name: 'phase2 feature builder populates consumed enrichment fields',
    fn: testFeatureBuilderRegressionPopulatesConsumedPhaseTwoFields,
  },
  {
    name: 'phase2 prior and posterior consume enriched context',
    fn: testPriorAndPosteriorUsePhaseTwoContext,
  },
  {
    name: 'phase2 build signals records phase2 context and uses it for decisioning',
    fn: testBuildSignalsRecordsPhaseTwoContextAndUsesItForDecisioning,
  },
];
