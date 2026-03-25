import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BuildSignalsJob } from '../jobs/buildSignals.job';
import { DailyReviewJob } from '../jobs/dailyReview.job';
import { EvaluateTradeOpportunitiesJob } from '../jobs/evaluateTradeOpportunities.job';
import { ExecuteOrdersJob } from '../jobs/executeOrders.job';
import { LearningEventLog } from '../runtime/learning-event-log';
import { LearningStateStore } from '../runtime/learning-state-store';
import { StrategyDeploymentRegistry } from '../runtime/strategy-deployment-registry';
import { VersionLineageRegistry } from '../runtime/version-lineage-registry';
import {
  AdverseSelectionRisk,
  BookInstabilityScore,
  FlowToxicityScore,
  ToxicityPolicy,
  ToxicityTrend,
} from '@polymarket-btc-5m-agentic-bot/signal-engine';
import {
  buildExecutionLearningContextKey,
} from '@polymarket-btc-5m-agentic-bot/execution-engine';
import {
  type ExecutionPolicyVersion,
  createDefaultExecutionLearningState,
  createDefaultLearningState,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { TradeQualityHistoryStore } from '@polymarket-btc-5m-agentic-bot/risk-engine';

async function testFlowToxicityScoreRespondsToOneSidedPressure(): Promise<void> {
  const score = new FlowToxicityScore().score({
    flowImbalanceProxy: 0.72,
    flowIntensity: 0.88,
    micropriceBias: 0.07,
    btcMoveTransmission: -0.26,
    signalDecayPressure: 0.74,
  });

  assert.strictEqual(score.toxicityScore > 0.65, true);
  assert.strictEqual(score.reasons.includes('one_sided_flow_pressure'), true);
}

async function testBookInstabilityScoreRespondsToStress(): Promise<void> {
  const score = new BookInstabilityScore().score({
    bookUpdateStress: 0.86,
    orderbookNoiseScore: 0.61,
    spread: 0.037,
    spreadToDepthRatio: 0.0012,
    topLevelDepth: 8,
    timeToExpirySeconds: 70,
  });

  assert.strictEqual(score.bookInstabilityScore > 0.75, true);
  assert.strictEqual(score.reasons.includes('book_update_stress_elevated'), true);
}

async function testAdverseSelectionRiskUsesFlowAndBookSignals(): Promise<void> {
  const risk = new AdverseSelectionRisk().evaluate({
    flowToxicityScore: 0.71,
    bookInstabilityScore: 0.79,
    micropriceBias: 0.08,
    lastReturnPct: -0.0025,
    rollingReturnPct: 0.0021,
    signalDecayPressure: 0.68,
    marketStateTransition: 'stress_transition',
    timeToExpirySeconds: 65,
  });

  assert.strictEqual(risk.adverseSelectionRisk > 0.8, true);
  assert.strictEqual(risk.reasons.includes('book_instability_pressure'), true);
}

async function testToxicityTrendDetectsMomentumShockAndPersistence(): Promise<void> {
  const trend = new ToxicityTrend().evaluate({
    currentToxicityScore: 0.74,
    recentHistory: [
      { toxicityScore: 0.2, toxicityState: 'normal', capturedAt: '2026-03-25T00:00:00.000Z' },
      {
        toxicityScore: 0.36,
        toxicityState: 'elevated',
        capturedAt: '2026-03-25T00:01:00.000Z',
      },
      { toxicityScore: 0.49, toxicityState: 'elevated', capturedAt: '2026-03-25T00:02:00.000Z' },
      { toxicityScore: 0.61, toxicityState: 'high', capturedAt: '2026-03-25T00:03:00.000Z' },
    ],
  });

  assert.strictEqual(trend.toxicityMomentum > 0.55, true);
  assert.strictEqual(trend.toxicityShock > 0.55, true);
  assert.strictEqual(trend.toxicityPersistence > 0.4, true);
  assert.strictEqual(trend.reasons.includes('toxicity_shock_detected'), true);
}

async function testToxicityPolicyNoChangeAction(): Promise<void> {
  const decision = new ToxicityPolicy().evaluate({
    features: buildCalmToxicityFeatures(),
    regimeLabel: 'low_volatility_drift',
    signalAgeMs: 1_000,
  });

  assert.strictEqual(decision.recommendedAction, 'no_change');
  assert.strictEqual(decision.toxicityState, 'normal');
}

async function testToxicityPolicyWidenThresholdAction(): Promise<void> {
  const decision = new ToxicityPolicy().evaluate({
    features: {
      ...buildCalmToxicityFeatures(),
      flowImbalanceProxy: 0.4,
      flowIntensity: 0.52,
      signalDecayPressure: 0.38,
      bookUpdateStress: 0.41,
      orderbookNoiseScore: 0.33,
    },
    regimeLabel: 'low_volatility_drift',
    signalAgeMs: 8_000,
  });

  assert.strictEqual(decision.recommendedAction, 'widen_threshold');
  assert.strictEqual(decision.thresholdMultiplier > 1, true);
}

async function testToxicityPolicyReduceSizeAction(): Promise<void> {
  const decision = new ToxicityPolicy().evaluate({
    features: {
      ...buildCalmToxicityFeatures(),
      flowImbalanceProxy: 0.58,
      flowIntensity: 0.74,
      micropriceBias: 0.07,
      signalDecayPressure: 0.56,
      bookUpdateStress: 0.64,
      orderbookNoiseScore: 0.52,
      spread: 0.028,
    },
    regimeLabel: 'spike_and_revert',
    signalAgeMs: 12_000,
  });

  assert.strictEqual(decision.recommendedAction, 'reduce_size');
  assert.strictEqual(decision.sizeMultiplier < 1, true);
}

async function testToxicityPolicyDisablesAggressiveExecution(): Promise<void> {
  const decision = new ToxicityPolicy().evaluate({
    features: {
      ...buildCalmToxicityFeatures(),
      flowImbalanceProxy: -0.56,
      flowIntensity: 0.82,
      micropriceBias: -0.08,
      signalDecayPressure: 0.52,
      bookUpdateStress: 0.66,
      orderbookNoiseScore: 0.56,
      spread: 0.033,
      spreadToDepthRatio: 0.0011,
      topLevelDepth: 12,
      marketStateTransition: 'stress_transition',
    },
    regimeLabel: 'illiquid_noisy_book',
    signalAgeMs: 16_000,
  });

  assert.strictEqual(decision.recommendedAction, 'disable_aggressive_execution');
  assert.strictEqual(decision.disableAggressiveExecution, true);
  assert.strictEqual(decision.executionAggressionLock, 'passive_only');
  assert.strictEqual(decision.passiveOnly, true);
  assert.strictEqual(
    decision.aggressionReasonCodes.includes('toxicity_aggression_lock_passive_only'),
    true,
  );
}

async function testToxicityPolicyTemporarilyBlocksRegime(): Promise<void> {
  const decision = new ToxicityPolicy().evaluate({
    features: {
      ...buildCalmToxicityFeatures(),
      flowImbalanceProxy: -0.78,
      flowIntensity: 0.95,
      micropriceBias: -0.12,
      signalDecayPressure: 0.82,
      bookUpdateStress: 0.9,
      orderbookNoiseScore: 0.74,
      spread: 0.048,
      spreadToDepthRatio: 0.0015,
      topLevelDepth: 7,
      timeToExpirySeconds: 40,
      marketStateTransition: 'stress_transition',
    },
    regimeLabel: 'near_resolution_microstructure_chaos',
    signalAgeMs: 20_000,
  });

  assert.strictEqual(decision.recommendedAction, 'temporarily_block_regime');
  assert.strictEqual(decision.temporarilyBlockRegime, true);
}

async function testToxicityPolicyEscalatesPersistentTrend(): Promise<void> {
  const calmDecision = new ToxicityPolicy().evaluate({
    features: {
      ...buildCalmToxicityFeatures(),
      flowImbalanceProxy: 0.34,
      flowIntensity: 0.42,
      signalDecayPressure: 0.28,
      bookUpdateStress: 0.34,
      orderbookNoiseScore: 0.28,
    },
    regimeLabel: 'low_volatility_drift',
    signalAgeMs: 6_000,
    recentHistory: [],
  });
  const trendedDecision = new ToxicityPolicy().evaluate({
    features: {
      ...buildCalmToxicityFeatures(),
      flowImbalanceProxy: 0.34,
      flowIntensity: 0.42,
      signalDecayPressure: 0.28,
      bookUpdateStress: 0.34,
      orderbookNoiseScore: 0.28,
    },
    regimeLabel: 'low_volatility_drift',
    signalAgeMs: 6_000,
    recentHistory: [
      { toxicityScore: 0.22, toxicityState: 'normal', capturedAt: '2026-03-25T00:00:00.000Z' },
      {
        toxicityScore: 0.35,
        toxicityState: 'elevated',
        capturedAt: '2026-03-25T00:01:00.000Z',
      },
      {
        toxicityScore: 0.47,
        toxicityState: 'elevated',
        capturedAt: '2026-03-25T00:02:00.000Z',
      },
      { toxicityScore: 0.63, toxicityState: 'high', capturedAt: '2026-03-25T00:03:00.000Z' },
    ],
  });

  assert.strictEqual(calmDecision.recommendedAction, 'no_change');
  assert.strictEqual(trendedDecision.recommendedAction, 'widen_threshold');
  assert.strictEqual(trendedDecision.sizeMultiplier <= calmDecision.sizeMultiplier, true);
  assert.strictEqual(trendedDecision.thresholdMultiplier >= calmDecision.thresholdMultiplier, true);
  assert.strictEqual(trendedDecision.toxicityPersistence > 0.4, true);
}

async function testBuildSignalsRecordsToxicityAndBlocksToxicContext(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3-build-signals-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const versionLineageRegistry = new VersionLineageRegistry(
    path.join(rootDir, 'version-lineage'),
  );
  const deploymentRegistry = new StrategyDeploymentRegistry(
    path.join(rootDir, 'deployment-registry'),
  );
  const tradeQualityHistoryStore = new TradeQualityHistoryStore(
    path.join(rootDir, 'trade-quality'),
  );
  const auditEvents: Array<Record<string, unknown>> = [];
  const createdSignals: Array<Record<string, unknown>> = [];

  const prisma = {
    strategyVersion: {
      findFirst: async () => ({ id: 'strategy-live-1' }),
    },
    market: {
      findMany: async () => [
        {
          id: 'm1',
          slug: 'btc-toxic',
          title: 'Will BTC be higher in 5 minutes?',
          status: 'active',
          tokenIdYes: 'yes1',
          tokenIdNo: 'no1',
          expiresAt: new Date(Date.now() + 55_000),
          updatedAt: new Date(),
        },
      ],
    },
    orderbook: {
      findFirst: async () => ({
        ...buildOrderbook({
          spread: 0.042,
          bidLevels: [
            { price: 0.47, size: 4 },
            { price: 0.45, size: 2 },
          ],
          askLevels: [
            { price: 0.512, size: 10 },
            { price: 0.53, size: 3 },
          ],
        }),
        tickSize: 0.01,
        minOrderSize: 1,
        negRisk: false,
        observedAt: new Date(),
      }),
    },
    marketSnapshot: {
      findFirst: async () => ({
        observedAt: new Date(),
        expiresAt: new Date(Date.now() + 55_000),
        volume: 700,
      }),
    },
    signal: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdSignals.push(data);
      },
    },
    signalDecision: {
      create: async () => null,
    },
    auditEvent: {
      findMany: async () => [
        {
          marketId: 'm1',
          createdAt: new Date('2026-03-25T00:00:00.000Z'),
          metadata: {
            toxicity: {
              toxicityScore: 0.44,
              toxicityState: 'elevated',
              recommendedAction: 'widen_threshold',
            },
          },
        },
        {
          marketId: 'm1',
          createdAt: new Date('2026-03-25T00:01:00.000Z'),
          metadata: {
            toxicity: {
              toxicityScore: 0.58,
              toxicityState: 'high',
              recommendedAction: 'reduce_size',
            },
          },
        },
      ],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        auditEvents.push(data);
      },
    },
  };

  const job = new BuildSignalsJob(
    prisma as never,
    deploymentRegistry,
    learningStateStore,
    versionLineageRegistry,
  );
  const result = await job.run(buildBtcReference());

  const admissionEvent = auditEvents.find(
    (event) => event.eventType === 'signal.admission_decision',
  );
  const metadata =
    admissionEvent && typeof admissionEvent.metadata === 'object'
      ? (admissionEvent.metadata as Record<string, unknown>)
      : null;
  const toxicity =
    metadata?.toxicity && typeof metadata.toxicity === 'object'
      ? (metadata.toxicity as Record<string, unknown>)
      : null;

  assert.strictEqual(result.created, 0);
  assert.strictEqual(createdSignals[0]?.status, 'rejected');
  assert.ok(toxicity);
  assert.strictEqual(toxicity?.recommendedAction, 'temporarily_block_regime');
  assert.strictEqual(typeof toxicity?.toxicityMomentum, 'number');
  assert.strictEqual(typeof toxicity?.toxicityPersistence, 'number');
}

async function testEvaluateTradeOpportunitiesReducesSizeUnderToxicity(): Promise<void> {
  const calm = await runEvaluationScenario(
    buildOrderbook({
      spread: 0.011,
      bidLevels: [
        { price: 0.54, size: 18 },
        { price: 0.53, size: 14 },
      ],
      askLevels: [
        { price: 0.551, size: 18 },
        { price: 0.56, size: 14 },
      ],
    }),
  );
  const toxic = await runEvaluationScenario(
    buildOrderbook({
      spread: 0.022,
      bidLevels: [
        { price: 0.53, size: 10 },
        { price: 0.51, size: 4 },
      ],
      askLevels: [
        { price: 0.552, size: 20 },
        { price: 0.57, size: 6 },
      ],
    }),
  );

  assert.ok(calm.toxicity);
  assert.strictEqual(calm.toxicity?.recommendedAction, 'no_change');
  assert.strictEqual(calm.result.approved === 1 || calm.result.rejected === 1, true);
  assert.strictEqual(toxic.result.approved === 1 || toxic.result.rejected === 1, true);
  assert.strictEqual(toxic.result.approved <= calm.result.approved, true);
  assert.strictEqual(
    toxic.result.approved === 0 || (toxic.positionSize ?? 0) < (calm.positionSize ?? 0),
    true,
  );
  assert.ok(toxic.toxicity);
  assert.notStrictEqual(toxic.toxicity?.recommendedAction, 'no_change');
}

async function testEvaluateTradeOpportunitiesEscalatesPersistentToxicity(): Promise<void> {
  const baseOrderbook = buildOrderbook({
    spread: 0.014,
    bidLevels: [
      { price: 0.54, size: 17 },
      { price: 0.53, size: 12 },
    ],
    askLevels: [
      { price: 0.554, size: 17 },
      { price: 0.565, size: 12 },
    ],
  });
  const calm = await runEvaluationScenario(baseOrderbook, []);
  const trended = await runEvaluationScenario(baseOrderbook, [
    {
      marketId: 'm1',
      createdAt: new Date('2026-03-25T00:00:00.000Z'),
      metadata: {
        toxicity: {
          toxicityScore: 0.35,
          toxicityState: 'elevated',
          recommendedAction: 'widen_threshold',
        },
      },
    },
    {
      marketId: 'm1',
      createdAt: new Date('2026-03-25T00:01:00.000Z'),
      metadata: {
        toxicity: {
          toxicityScore: 0.48,
          toxicityState: 'elevated',
          recommendedAction: 'widen_threshold',
        },
      },
    },
    {
      marketId: 'm1',
      createdAt: new Date('2026-03-25T00:02:00.000Z'),
      metadata: {
        toxicity: {
          toxicityScore: 0.61,
          toxicityState: 'high',
          recommendedAction: 'reduce_size',
        },
      },
    },
  ]);

  assert.ok(calm.toxicity);
  assert.ok(trended.toxicity);
  assert.strictEqual((trended.toxicity?.toxicityPersistence as number) > 0, true);
  assert.strictEqual(
    (trended.toxicity?.toxicityScore as number) >= (calm.toxicity?.toxicityScore as number),
    true,
  );
  assert.strictEqual(
    trended.result.approved === 0 || (trended.positionSize ?? 0) <= (calm.positionSize ?? 0),
    true,
  );
}

async function testEvaluateTradeOpportunitiesRecordsPassiveOnlyLockUnderToxicity(): Promise<void> {
  const locked = await runEvaluationScenario(
    buildOrderbook({
      spread: 0.036,
      bidLevels: [
        { price: 0.52, size: 5 },
        { price: 0.5, size: 3 },
      ],
      askLevels: [
        { price: 0.556, size: 11 },
        { price: 0.57, size: 4 },
      ],
    }),
    [
      {
        marketId: 'm1',
        createdAt: new Date('2026-03-25T00:00:00.000Z'),
        metadata: {
          toxicity: {
            toxicityScore: 0.58,
            toxicityState: 'high',
            recommendedAction: 'disable_aggressive_execution',
          },
        },
      },
      {
        marketId: 'm1',
        createdAt: new Date('2026-03-25T00:01:00.000Z'),
        metadata: {
          toxicity: {
            toxicityScore: 0.66,
            toxicityState: 'high',
            recommendedAction: 'disable_aggressive_execution',
          },
        },
      },
      {
        marketId: 'm1',
        createdAt: new Date('2026-03-25T00:02:00.000Z'),
        metadata: {
          toxicity: {
            toxicityScore: 0.84,
            toxicityState: 'blocked',
            recommendedAction: 'temporarily_block_regime',
          },
        },
      },
    ],
  );

  assert.ok(locked.toxicity);
  assert.strictEqual(locked.toxicity?.executionAggressionLock, 'passive_only');
  assert.strictEqual(locked.toxicity?.passiveOnly, true);
  assert.strictEqual(
    Array.isArray(locked.toxicity?.aggressionReasonCodes) &&
      (locked.toxicity?.aggressionReasonCodes as unknown[]).includes(
        'toxicity_aggression_lock_passive_only',
      ),
    true,
  );
}

async function testExecuteOrdersDisablesAggressiveExecutionUnderToxicity(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3-execute-orders-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const learningState = createDefaultLearningState(
    new Date('2026-03-25T00:00:00.000Z'),
  );
  const contextKey = buildExecutionLearningContextKey(
    'variant:strategy-live-1',
    'illiquid_noisy_book',
  );
  const activePolicy: ExecutionPolicyVersion = {
    versionId: 'execution-policy:phase3:v1',
    contextKey,
    strategyVariantId: 'variant:strategy-live-1',
    regime: 'illiquid_noisy_book',
    mode: 'taker_preferred',
    recommendedRoute: 'taker',
    recommendedExecutionStyle: 'cross',
    sampleCount: 12,
    makerFillRateAssumption: 0.3,
    takerFillRateAssumption: 0.92,
    expectedFillDelayMs: 22_000,
    expectedSlippage: 0.004,
    adverseSelectionScore: 0.58,
    cancelSuccessRate: 0.62,
    partialFillRate: 0.2,
    health: 'degraded',
    rationale: ['phase3_test_policy'],
    sourceCycleId: 'cycle-1',
    supersedesVersionId: null,
    createdAt: '2026-03-25T00:00:00.000Z',
  };
  learningState.executionLearning = {
    ...createDefaultExecutionLearningState(),
    updatedAt: '2026-03-25T00:00:00.000Z',
    lastPolicyChangeAt: '2026-03-25T00:00:00.000Z',
    contexts: {
      [contextKey]: {
        contextKey,
        strategyVariantId: 'variant:strategy-live-1',
        regime: 'illiquid_noisy_book',
        sampleCount: 12,
        makerSampleCount: 6,
        takerSampleCount: 6,
        makerFillRate: 0.3,
        takerFillRate: 0.92,
        averageFillDelayMs: 22_000,
        averageSlippage: 0.004,
        adverseSelectionScore: 0.58,
        cancelSuccessRate: 0.62,
        partialFillRate: 0.2,
        makerPunished: true,
        health: 'degraded',
        notes: ['phase3_test_context'],
        activePolicyVersionId: activePolicy.versionId,
        lastUpdatedAt: '2026-03-25T00:00:00.000Z',
      },
    },
    policyVersions: {
      [activePolicy.versionId]: activePolicy,
    },
    activePolicyVersionIds: {
      [contextKey]: activePolicy.versionId,
    },
  };
  await learningStateStore.save(learningState);

  let auditMetadata: Record<string, unknown> | null = null;
  const prisma = {
    signal: {
      findMany: async () => [
        buildExecutionSignal({
          regime: 'illiquid_noisy_book',
          observedAt: new Date(Date.now() - 5_000),
          expectedEv: 0.06,
        }),
      ],
      update: async () => null,
    },
    signalDecision: {
      findFirst: async () => ({ positionSize: 12, verdict: 'approved' }),
      create: async () => null,
    },
    market: {
      findUnique: async () => buildMarket(),
    },
    marketSnapshot: {
      findFirst: async () => buildSnapshot(300),
    },
    orderbook: {
      findFirst: async () =>
        buildOrderbook({
          spread: 0.036,
          bidLevels: [
            { price: 0.52, size: 5 },
            { price: 0.5, size: 3 },
          ],
          askLevels: [
            { price: 0.556, size: 11 },
            { price: 0.57, size: 4 },
          ],
          observedAt: new Date(),
        }),
    },
    order: {
      findFirst: async () => null,
      create: async () => null,
    },
    auditEvent: {
      create: async ({ data }: { data: { metadata: Record<string, unknown> } }) => {
        auditMetadata = data.metadata;
      },
    },
    reconciliationCheckpoint: {
      findFirst: async ({ where }: { where: { source: string } }) =>
        where.source === 'order_intent' ? null : createFreshCheckpoint(where.source),
      create: async () => null,
    },
    botRuntimeStatus: {
      findUnique: async () => createFreshRuntimeStatus(),
    },
    liveConfig: {
      findUnique: async () => ({ id: 'live', noTradeWindowSeconds: 30 }),
    },
    executionDiagnostic: {
      findMany: async () => [],
    },
  };
  const runtimeControl = {
    assessOperationalFreshness: async () => ({
      healthy: true,
      reasonCode: null,
    }),
    getLatestSafetyState: async () => ({
      state: 'normal',
      enteredAt: new Date(0).toISOString(),
      reasonCodes: [],
      sizeMultiplier: 1,
      evaluationCadenceMultiplier: 1,
      allowAggressiveEntries: true,
      allowNewEntries: true,
      haltRequested: false,
      maxNewSignalsPerTick: 4,
      evidence: {},
    }),
    updateRuntimeStatus: async () => null,
  };

  const job = new ExecuteOrdersJob(
    prisma as never,
    runtimeControl as never,
    learningStateStore,
  );
  (job as any).signerHealth = {
    check: () => ({
      checks: {
        privateKey: true,
        apiKey: true,
        apiSecret: true,
        apiPassphrase: true,
      },
    }),
  };
  (job as any).liveTradeGuard = {
    evaluate: () => ({
      passed: true,
      reasonCode: 'passed',
      reasonMessage: null,
    }),
  };
  (job as any).externalPortfolioService = {
    capture: async () => createExternalPortfolioSnapshot(),
  };
  (job as any).accountStateService = {
    capture: async () => ({
      deployableRiskNow: 10_000,
    }),
  };
  (job as any).tradingClient = {
    postOrder: async () => ({
      success: true,
      orderId: 'venue-order-1',
      status: 'acknowledged',
    }),
  };

  const result = await job.run({ canSubmit: () => true });

  const metadata = auditMetadata as Record<string, unknown> | null;
  assert.strictEqual(result.submitted === 1 || result.rejected >= 1, true);
  if (metadata) {
    const toxicity =
      metadata.toxicity && typeof metadata.toxicity === 'object'
        ? (metadata.toxicity as Record<string, unknown>)
        : null;
    assert.ok(toxicity);
    assert.strictEqual(toxicity?.recommendedAction, 'disable_aggressive_execution');
    assert.strictEqual(toxicity?.executionAggressionLock, 'passive_only');
    assert.strictEqual(toxicity?.passiveOnly, true);
  }
  if (result.submitted === 1) {
    assert.strictEqual(metadata?.executionStyle, 'rest');
    assert.strictEqual(metadata?.route, 'maker');
  }
}

async function testDailyReviewPersistsToxicitySummary(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3-toxicity-review-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const learningEventLog = new LearningEventLog(rootDir);
  const createdAuditEvents: Array<Record<string, unknown>> = [];

  const prisma = {
    strategyVersion: {
      findMany: async () => [],
    },
    executionDiagnostic: {
      findMany: async () => [],
    },
    order: {
      findMany: async () => [],
    },
    auditEvent: {
      findMany: async () => [
        {
          eventType: 'signal.execution_decision',
          createdAt: new Date('2026-03-25T00:01:00.000Z'),
          metadata: {
            toxicity: {
              toxicityScore: 0.73,
              toxicityState: 'high',
              recommendedAction: 'disable_aggressive_execution',
              toxicityMomentum: 0.66,
              toxicityShock: 0.52,
              toxicityPersistence: 0.71,
            },
          },
        },
      ],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdAuditEvents.push(data);
        return data;
      },
    },
  };

  const job = new DailyReviewJob(
    prisma as never,
    learningStateStore,
    learningEventLog,
  );
  await job.run({
    force: true,
    now: new Date('2026-03-25T00:10:00.000Z'),
  });

  const toxicityReview = createdAuditEvents.find(
    (event) => event.eventType === 'learning.toxicity_review',
  );
  const metadata =
    toxicityReview && typeof toxicityReview.metadata === 'object'
      ? (toxicityReview.metadata as Record<string, unknown>)
      : null;

  assert.ok(toxicityReview);
  assert.strictEqual(metadata?.sampleCount, 1);
  assert.strictEqual(metadata?.aggressiveExecutionDisabledCount, 1);
  assert.strictEqual(typeof metadata?.averageToxicityMomentum, 'number');
  assert.strictEqual(typeof metadata?.averageToxicityPersistence, 'number');
}

async function runEvaluationScenario(
  orderbook: ReturnType<typeof buildOrderbook>,
  recentAuditEvents: Array<Record<string, unknown>> = [],
) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3-evaluate-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const versionLineageRegistry = new VersionLineageRegistry(
    path.join(rootDir, 'version-lineage'),
  );
  const deploymentRegistry = new StrategyDeploymentRegistry(
    path.join(rootDir, 'deployment-registry'),
  );
  const tradeQualityHistoryStore = new TradeQualityHistoryStore(
    path.join(rootDir, 'trade-quality'),
  );
  const createdDecisions: Array<Record<string, unknown>> = [];
  const auditEvents: Array<Record<string, unknown>> = [];
  const signal = buildExecutionSignal({
    regime: 'low_volatility_drift',
    expectedEv: 0.05,
    edge: 0.035,
    observedAt: new Date(Date.now() - 4_000),
  });
  const market = buildMarket();

  const prisma = {
    signal: {
      findMany: async () => [signal],
      update: async () => null,
    },
    portfolioSnapshot: {
      findFirst: async () => ({
        bankroll: 1_000,
        availableCapital: 500,
        realizedPnlDay: 0,
        consecutiveLosses: 0,
        capturedAt: new Date(),
      }),
    },
    position: {
      findMany: async () => [],
    },
    order: {
      findMany: async () => [],
    },
    signalDecision: {
      findFirst: async () => null,
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdDecisions.push(data);
      },
    },
    market: {
      findMany: async () => [market],
    },
    orderbook: {
      findFirst: async () => ({
        ...orderbook,
        observedAt: new Date(),
      }),
    },
    marketSnapshot: {
      findFirst: async () => buildSnapshot(300),
    },
    reconciliationCheckpoint: {
      findFirst: async ({ where }: { where: { source: string } }) =>
        where.source === 'research_governance_validation'
          ? {
              ...createFreshCheckpoint(where.source),
              status: 'passed',
              details: {
                robustness: { passed: true },
                promotion: { score: 0.8 },
              },
            }
          : createFreshCheckpoint(where.source),
    },
    botRuntimeStatus: {
      findUnique: async () => createFreshRuntimeStatus(),
    },
    stressTestRun: {
      findFirst: async () => ({
        family: 'chaos_harness',
        verdict: 'passed',
        status: 'passed',
        startedAt: new Date(),
      }),
    },
    executionDiagnostic: {
      findMany: async () => [],
    },
    auditEvent: {
      findMany: async () => recentAuditEvents,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        auditEvents.push(data);
      },
    },
  };
  const runtimeControl = {
    getLatestSafetyState: async () => ({
      state: 'normal',
      enteredAt: new Date(0).toISOString(),
      reasonCodes: [],
      sizeMultiplier: 1,
      evaluationCadenceMultiplier: 1,
      allowAggressiveEntries: true,
      allowNewEntries: true,
      haltRequested: false,
      maxNewSignalsPerTick: 4,
      evidence: {},
    }),
    recordSafetyStateTransition: async () => null,
  };

  const job = new EvaluateTradeOpportunitiesJob(
    prisma as never,
    runtimeControl as never,
    deploymentRegistry,
    learningStateStore,
    versionLineageRegistry,
    undefined,
    tradeQualityHistoryStore,
  );
  const result = await job.run(buildRuntimeConfig());
  const approvedDecision = createdDecisions.find((decision) => decision.verdict === 'approved');
  const decisionEvent = auditEvents.find(
    (event) => event.eventType === 'signal.execution_decision',
  );
  const toxicity =
    decisionEvent &&
    typeof decisionEvent.metadata === 'object' &&
    (decisionEvent.metadata as Record<string, unknown>).toxicity &&
    typeof (decisionEvent.metadata as Record<string, unknown>).toxicity === 'object'
      ? ((decisionEvent.metadata as Record<string, unknown>).toxicity as Record<string, unknown>)
      : null;

  return {
    result,
    positionSize:
      approvedDecision && typeof approvedDecision.positionSize === 'number'
        ? approvedDecision.positionSize
        : null,
    toxicity,
  };
}

function buildCalmToxicityFeatures() {
  return {
    flowImbalanceProxy: 0.08,
    flowIntensity: 0.14,
    micropriceBias: 0.01,
    btcMoveTransmission: 0.12,
    signalDecayPressure: 0.08,
    bookUpdateStress: 0.12,
    orderbookNoiseScore: 0.1,
    spread: 0.01,
    spreadToDepthRatio: 0.0003,
    topLevelDepth: 28,
    timeToExpirySeconds: 240,
    lastReturnPct: 0.0012,
    rollingReturnPct: 0.0018,
    marketStateTransition: 'range_balance' as const,
  };
}

function buildRuntimeConfig() {
  return {
    maxOpenPositions: 2,
    maxDailyLossPct: 5,
    maxPerTradeRiskPct: 1,
    maxKellyFraction: 0.05,
    maxConsecutiveLosses: 2,
    noTradeWindowSeconds: 30,
    evaluationIntervalMs: 1_000,
    orderReconcileIntervalMs: 2_000,
    portfolioRefreshIntervalMs: 5_000,
  };
}

function buildExecutionSignal(
  overrides?: Partial<{
    regime: string;
    expectedEv: number;
    edge: number;
    observedAt: Date;
  }>,
) {
  return {
    id: 'signal-1',
    marketId: 'm1',
    strategyVersionId: 'strategy-live-1',
    side: 'BUY',
    tokenId: 'yes1',
    outcome: 'YES',
    intent: 'ENTER',
    inventoryEffect: 'INCREASE',
    priorProbability: 0.58,
    posteriorProbability: 0.69,
    marketImpliedProb: 0.55,
    edge: overrides?.edge ?? 0.03,
    expectedEv: overrides?.expectedEv ?? 0.045,
    regime: overrides?.regime ?? 'low_volatility_drift',
    status: 'approved',
    observedAt: overrides?.observedAt ?? new Date(Date.now() - 3_000),
  };
}

function buildMarket() {
  return {
    id: 'm1',
    slug: 'btc-5m',
    title: 'Will BTC be higher in 5 minutes?',
    status: 'active',
    tokenIdYes: 'yes1',
    tokenIdNo: 'no1',
    expiresAt: new Date(Date.now() + 300_000),
  };
}

function buildSnapshot(expirySeconds: number) {
  return {
    observedAt: new Date(),
    expiresAt: new Date(Date.now() + expirySeconds * 1_000),
    volume: 500,
    marketPrice: 0.55,
  };
}

function buildOrderbook(input?: {
  spread?: number;
  bidLevels?: Array<{ price: number; size: number }>;
  askLevels?: Array<{ price: number; size: number }>;
  observedAt?: Date;
}) {
  const spread = input?.spread ?? 0.01;
  const bidLevels = input?.bidLevels ?? [
    { price: 0.54, size: 18 },
    { price: 0.53, size: 12 },
  ];
  const askLevels = input?.askLevels ?? [
    { price: 0.54 + spread, size: 18 },
    { price: 0.55 + spread, size: 12 },
  ];

  return {
    bestBid: bidLevels[0]?.price ?? 0.54,
    bestAsk: askLevels[0]?.price ?? 0.54 + spread,
    spread,
    bidLevels,
    askLevels,
    observedAt: input?.observedAt ?? new Date(),
  };
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
    const close = open + 0.7 + index * 0.05;
    candles.push({
      timestamp: new Date(Date.now() - (24 - index) * 5 * 60_000).toISOString(),
      open,
      high: close + 0.12,
      low: open - 0.08,
      close,
      volume: 65 + index * 4,
    });
    price = close;
  }

  return {
    symbol: 'BTCUSD',
    timeframe: '5m',
    candles,
  };
}

function createFreshCheckpoint(source: string) {
  return {
    source,
    processedAt: new Date(),
    status: 'completed',
    details: {},
  };
}

function createFreshRuntimeStatus() {
  return {
    id: 'live',
    lastHeartbeatAt: new Date(),
  };
}

function createExternalPortfolioSnapshot() {
  return {
    snapshotId: 'external-1',
    capturedAt: new Date().toISOString(),
    freshnessState: 'fresh',
    freshnessVerdict: 'healthy',
    reconciliationHealth: 'healthy',
    tradingPermissions: {
      allowNewEntries: true,
      allowPositionManagement: true,
      reasonCodes: [],
    },
    cashBalance: 10_000,
    cashAllowance: 10_000,
    reservedCash: 0,
    freeCashBeforeAllowance: 10_000,
    freeCashAfterAllowance: 10_000,
    tradableBuyHeadroom: 10_000,
    availableCapital: 10_000,
    openOrders: [],
    inventories: [],
  };
}

export const phaseThreeToxicityTests = [
  {
    name: 'phase3 flow toxicity score reacts to one-sided pressure',
    fn: testFlowToxicityScoreRespondsToOneSidedPressure,
  },
  {
    name: 'item3 toxicity trend detects momentum shock and persistence',
    fn: testToxicityTrendDetectsMomentumShockAndPersistence,
  },
  {
    name: 'phase3 book instability score reacts to stressed book context',
    fn: testBookInstabilityScoreRespondsToStress,
  },
  {
    name: 'phase3 adverse selection risk combines flow and book signals',
    fn: testAdverseSelectionRiskUsesFlowAndBookSignals,
  },
  {
    name: 'phase3 toxicity policy supports no-change action',
    fn: testToxicityPolicyNoChangeAction,
  },
  {
    name: 'phase3 toxicity policy supports widen-threshold action',
    fn: testToxicityPolicyWidenThresholdAction,
  },
  {
    name: 'phase3 toxicity policy supports reduce-size action',
    fn: testToxicityPolicyReduceSizeAction,
  },
  {
    name: 'phase3 toxicity policy supports disable-aggressive-execution action',
    fn: testToxicityPolicyDisablesAggressiveExecution,
  },
  {
    name: 'phase3 toxicity policy supports temporary regime block action',
    fn: testToxicityPolicyTemporarilyBlocksRegime,
  },
  {
    name: 'item3 toxicity policy escalates persistent toxicity trend',
    fn: testToxicityPolicyEscalatesPersistentTrend,
  },
  {
    name: 'phase3 build signals records toxicity and blocks toxic admission',
    fn: testBuildSignalsRecordsToxicityAndBlocksToxicContext,
  },
  {
    name: 'phase3 evaluate trade opportunities reduces size under toxicity',
    fn: testEvaluateTradeOpportunitiesReducesSizeUnderToxicity,
  },
  {
    name: 'item3 evaluate trade opportunities escalates persistent toxicity',
    fn: testEvaluateTradeOpportunitiesEscalatesPersistentToxicity,
  },
  {
    name: 'item4 evaluate trade opportunities records passive-only lock under toxic flow',
    fn: testEvaluateTradeOpportunitiesRecordsPassiveOnlyLockUnderToxicity,
  },
  {
    name: 'phase3 execute orders disables aggressive execution under toxicity',
    fn: testExecuteOrdersDisablesAggressiveExecutionUnderToxicity,
  },
  {
    name: 'phase3 daily review persists toxicity summary',
    fn: testDailyReviewPersistsToxicitySummary,
  },
];
