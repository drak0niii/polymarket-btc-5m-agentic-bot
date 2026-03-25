import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  LossAttributionClassifier,
  createAlphaAttribution,
} from '@polymarket-btc-5m-agentic-bot/signal-engine';
import {
  buildStrategyVariantId,
  createDefaultLearningState,
  createDefaultStrategyVariantState,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { DailyReviewJob } from '../jobs/dailyReview.job';
import { ExecuteOrdersJob } from '../jobs/executeOrders.job';
import { LearningEventLog } from '../runtime/learning-event-log';
import { LearningStateStore } from '../runtime/learning-state-store';
import { VersionLineageRegistry } from '../runtime/version-lineage-registry';

const classifier = new LossAttributionClassifier();

function buildAttribution(input?: Partial<Parameters<typeof createAlphaAttribution>[0]>) {
  return createAlphaAttribution({
    rawForecastProbability: 0.66,
    marketImpliedProbability: 0.56,
    confidenceAdjustedEdge: 0.05,
    paperEdge: 0.045,
    expectedExecutionCost: {
      feeCost: 0.003,
      slippageCost: 0.002,
      adverseSelectionCost: 0.001,
      fillDecayCost: 0.0005,
    },
    expectedNetEdge: 0.039,
    realizedExecutionCost: {
      feeCost: 0.003,
      slippageCost: 0.002,
      adverseSelectionCost: 0.001,
      fillDecayCost: 0.0005,
    },
    realizedNetEdge: 0.037,
    capturedAt: '2026-03-25T00:00:00.000Z',
    ...input,
  });
}

async function testLossAttributionClassifierAlphaWrong(): Promise<void> {
  const result = classifier.classify({
    alphaAttribution: buildAttribution({
      confidenceAdjustedEdge: -0.01,
      expectedNetEdge: -0.005,
      realizedNetEdge: -0.02,
    }),
  });

  assert.strictEqual(result.primaryLeakageDriver, 'alpha_wrong');
  assert.strictEqual(result.forecastQualityAssessment, 'failed');
}

async function testLossAttributionClassifierSlippageExcess(): Promise<void> {
  const result = classifier.classify({
    alphaAttribution: buildAttribution({
      realizedExecutionCost: {
        feeCost: 0.003,
        slippageCost: 0.014,
        adverseSelectionCost: 0.001,
        fillDecayCost: 0.0005,
      },
      realizedNetEdge: 0.021,
    }),
  });

  assert.strictEqual(result.primaryLeakageDriver, 'slippage_excess');
  assert.strictEqual(
    result.lossReasonCodes.includes('realized_slippage_exceeds_expectation'),
    true,
  );
}

async function testLossAttributionClassifierFillQualityFailure(): Promise<void> {
  const result = classifier.classify({
    alphaAttribution: buildAttribution({
      realizedNetEdge: null,
      realizedExecutionCost: null,
    }),
    fillRate: 0.42,
    expectedFillRate: 0.9,
  });

  assert.strictEqual(result.primaryLeakageDriver, 'fill_quality_failure');
  assert.strictEqual(result.executionQualityAssessment, 'failed');
}

async function testLossAttributionClassifierLatencyDecay(): Promise<void> {
  const result = classifier.classify({
    alphaAttribution: buildAttribution({
      realizedNetEdge: 0.018,
    }),
    signalAgeMs: 28_000,
    entryTimingLabel: 'late',
  });

  assert.strictEqual(result.primaryLeakageDriver, 'latency_decay');
  assert.strictEqual(result.lossReasonCodes.includes('signal_age_high'), true);
}

async function testLossAttributionClassifierToxicityDamage(): Promise<void> {
  const result = classifier.classify({
    alphaAttribution: buildAttribution({
      realizedExecutionCost: {
        feeCost: 0.003,
        slippageCost: 0.002,
        adverseSelectionCost: 0.009,
        fillDecayCost: 0.0005,
      },
      realizedNetEdge: 0.022,
    }),
    toxicityState: 'blocked',
  });

  assert.strictEqual(result.primaryLeakageDriver, 'toxicity_damage');
  assert.strictEqual(result.executionQualityAssessment, 'failed');
}

async function testLossAttributionClassifierOverSizing(): Promise<void> {
  const result = classifier.classify({
    alphaAttribution: buildAttribution({
      realizedNetEdge: 0.024,
    }),
    sizeToDepthRatio: 0.92,
    liquidityReductionRatio: 0.34,
  });

  assert.strictEqual(result.primaryLeakageDriver, 'over_sizing');
  assert.strictEqual(
    result.lossReasonCodes.includes('size_to_depth_ratio_elevated'),
    true,
  );
}

async function testLossAttributionClassifierRegimeDrift(): Promise<void> {
  const result = classifier.classify({
    alphaAttribution: buildAttribution({
      realizedNetEdge: 0.019,
    }),
    regimeHealth: 'quarantine_candidate',
  });

  assert.strictEqual(result.primaryLeakageDriver, 'regime_drift');
  assert.strictEqual(result.forecastQualityAssessment, 'degraded');
}

async function testLossAttributionClassifierMixed(): Promise<void> {
  const result = classifier.classify({
    alphaAttribution: buildAttribution({
      realizedExecutionCost: {
        feeCost: 0.003,
        slippageCost: 0.012,
        adverseSelectionCost: 0.009,
        fillDecayCost: 0.0005,
      },
      realizedNetEdge: 0.014,
    }),
    toxicityState: 'blocked',
  });

  assert.strictEqual(result.lossCategory, 'mixed');
  assert.strictEqual(result.secondaryLeakageDrivers.length > 0, true);
}

async function testExecuteOrdersEmitsLossAttributionEvidence(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'item1-execute-orders-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const versionLineageRegistry = new VersionLineageRegistry(
    path.join(rootDir, 'version-lineage'),
  );
  const learningState = createDefaultLearningState(
    new Date('2026-03-25T00:00:00.000Z'),
  );
  const strategyVariantId = buildStrategyVariantId('strategy-loss-1');
  learningState.strategyVariants[strategyVariantId] = {
    ...createDefaultStrategyVariantState(strategyVariantId),
    health: 'degraded',
    regimeSnapshots: {
      'regime:momentum_continuation': {
        key: 'regime:momentum_continuation',
        regime: 'momentum_continuation',
        liquidityBucket: 'balanced',
        spreadBucket: 'normal',
        timeToExpiryBucket: 'under_15m',
        entryTimingBucket: 'late',
        executionStyle: 'hybrid',
        side: 'buy',
        strategyVariantId,
        sampleCount: 12,
        winRate: 0.41,
        expectedEvSum: 0.18,
        realizedEvSum: 0.1,
        avgExpectedEv: 0.015,
        avgRealizedEv: 0.008,
        realizedVsExpected: 0.66,
        avgFillRate: 0.61,
        avgSlippage: 0.0042,
        health: 'degraded',
        lastObservedAt: '2026-03-25T00:00:00.000Z',
      },
    },
  };
  learningState.calibration[`strategy:${strategyVariantId}|regime:momentum_continuation`] = {
    contextKey: `strategy:${strategyVariantId}|regime:momentum_continuation`,
    strategyVariantId,
    regime: 'momentum_continuation',
    sampleCount: 18,
    brierScore: 0.22,
    logLoss: 0.6,
    shrinkageFactor: 0.81,
    overconfidenceScore: 0.14,
    health: 'degraded',
    version: 1,
    driftSignals: ['item1_test_calibration'],
    lastUpdatedAt: '2026-03-25T00:00:00.000Z',
  };
  await learningStateStore.save(learningState);

  const createdAuditEvents: Array<Record<string, unknown>> = [];
  const prisma = {
    signal: {
      findMany: async () => [buildExecutionSignal()],
      update: async () => null,
    },
    signalDecision: {
      findFirst: async () => ({
        id: 'signal-decision-1',
        signalId: 'signal-1',
        verdict: 'approved',
        positionSize: 12,
        decisionAt: new Date(),
      }),
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
          spread: 0.016,
          bidLevels: [
            { price: 0.52, size: 10 },
            { price: 0.51, size: 8 },
          ],
          askLevels: [
            { price: 0.536, size: 11 },
            { price: 0.548, size: 7 },
          ],
          observedAt: new Date(),
        }),
    },
    order: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => data,
    },
    auditEvent: {
      findMany: async () => [
        {
          eventType: 'learning.alpha_attribution_review',
          createdAt: new Date('2026-03-25T00:05:00.000Z'),
          metadata: {
            averageExpectedNetEdge: 0.02,
            averageRealizedNetEdge: 0.012,
            averageRetentionRatio: 0.58,
          },
        },
      ],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdAuditEvents.push(data);
        return data;
      },
    },
    liveConfig: {
      findUnique: async () => ({ id: 'live', noTradeWindowSeconds: 30 }),
    },
    reconciliationCheckpoint: {
      findFirst: async ({ where }: { where: { source: string } }) =>
        where.source === 'order_intent' ? null : createFreshCheckpoint(where.source),
      create: async () => null,
    },
    botRuntimeStatus: {
      findUnique: async () => createFreshRuntimeStatus(),
    },
    executionDiagnostic: {
      findMany: async () => [
        {
          strategyVersionId: 'strategy-loss-1',
          regime: 'momentum_continuation',
          evDrift: -0.018,
          expectedFee: 0.001,
          realizedFee: 0.0014,
          expectedSlippage: 0.0025,
          realizedSlippage: 0.0041,
          edgeAtSignal: 0.03,
          edgeAtFill: 0.018,
          fillRate: 0.72,
          staleOrder: false,
          capturedAt: new Date(),
        },
      ],
      create: async () => null,
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
    versionLineageRegistry,
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
  (job as any).assessExecutionReadiness = async () => ({
    ready: true,
    reasonCode: null,
  });
  (job as any).marketEligibility = {
    evaluate: () => ({
      eligible: true,
      reasonCode: null,
      reasonMessage: null,
    }),
  };
  (job as any).negativeRiskPolicy = {
    evaluate: () => ({
      allowed: true,
      reasonCode: null,
    }),
  };
  (job as any).buildExecutionToxicity = () => ({
    toxicityScore: 0.72,
    bookInstabilityScore: 0.58,
    adverseSelectionRisk: 0.63,
    toxicityState: 'high',
    recommendedAction: 'disable_aggressive_execution',
    widenThreshold: false,
    reduceSize: true,
    disableAggressiveExecution: true,
    temporarilyBlockRegime: false,
    sizeMultiplier: 0.82,
    reasonCodes: ['item1_test_toxicity'],
  });
  (job as any).executionCostCalibrator = {
    calibrate: () => ({
      feeCost: 0.001,
      slippageCost: 0.0025,
      adverseSelectionCost: 0.0018,
      expectedFillDelayMs: 9_000,
      cancelReplaceOverheadCost: 0.0004,
      missedOpportunityCost: 0,
    }),
  };
  (job as any).liveSizingFeedbackPolicy = {
    evaluate: () => ({
      sizeMultiplier: 1,
      aggressionCap: 'unchanged',
      thresholdAdjustment: 0,
      regimePermissionOverride: 'unchanged',
      reasonCodes: [],
    }),
  };
  (job as any).adaptiveMakerTakerPolicy = {
    decide: () => ({
      mode: 'maker_preferred',
      route: 'maker',
      executionStyle: 'rest',
      preferResting: true,
      policyVersionId: null,
      rationale: ['item1_test_execution_mode'],
    }),
  };
  (job as any).entryTimingEfficiencyScorer = {
    score: () => ({
      label: 'late',
      score: 0.42,
      sizeMultiplier: 1,
      blockTrade: false,
      reasonCodes: ['item1_test_entry_timing'],
    }),
  };
  (job as any).marketableLimit = {
    calculate: () => ({
      price: 0.536,
    }),
  };
  (job as any).sizeVsLiquidityPolicy = {
    evaluate: ({ desiredNotional, desiredSizeUnits }: Record<string, number>) => ({
      allowedNotional: desiredNotional,
      allowedSizeUnits: desiredSizeUnits,
      blockTrade: false,
      reasonCodes: [],
    }),
  };
  (job as any).maxLossPerOpportunityPolicy = {
    evaluate: ({ candidatePositionSize }: { candidatePositionSize: number }) => ({
      maxAllowedPositionSize: candidatePositionSize * 2,
      blockTrade: false,
      reasonCodes: [],
    }),
  };
  (job as any).slippageEstimator = {
    estimate: () => ({
      expectedSlippage: 0.0012,
      severity: 'low',
    }),
  };
  (job as any).realizedCostModel = {
    evaluate: () => ({
      breakdown: {
        feeCost: 0.001,
        slippageCost: 0.0025,
        adverseSelectionCost: 0.0018,
        fillDecayCost: 0.0004,
        cancelReplaceOverheadCost: 0.0002,
        missedOpportunityCost: 0,
        venuePenalty: 0,
        totalCost: 0.0059,
      },
    }),
  };
  (job as any).orderPlanner = {
    plan: ({ resolvedIntent, price, size }: Record<string, unknown>) => {
      const intent = resolvedIntent as Record<string, unknown>;
      return {
      tokenId: intent.tokenId,
      side: intent.venueSide,
      route: 'maker',
      executionStyle: 'rest',
      timeDiscipline: 'day',
      partialFillTolerance: 'allow_partial',
      orderType: 'GTC',
      expiration: null,
      allowedOrderTypes: ['GTC'],
      policyReasonCode: 'item1_test_order_plan',
      policyReasonMessage: 'item1 test order plan',
      price,
      size,
      };
    },
  };
  (job as any).venueOrderValidator = {
    validate: () => ({
      valid: true,
      reasonCode: null,
    }),
  };
  (job as any).venueFeeModel = {
    evaluate: () => ({
      expectedFee: 0.001,
      expectedFeePerUnit: 0.001,
      source: 'fallback',
    }),
  };
  (job as any).fundingValidator = {
    validate: () => ({
      passed: true,
      reasonCode: null,
    }),
  };
  (job as any).duplicateExposureGuard = {
    evaluate: () => ({
      allowed: true,
      reasonCode: null,
    }),
  };
  (job as any).tradingClient = {
    postOrder: async () => ({
      success: true,
      orderId: 'venue-order-1',
      status: 'filled',
    }),
  };

  await job.run({ canSubmit: () => true });

  const classificationEvent = createdAuditEvents.find(
    (event) => event.eventType === 'trade.loss_attribution_classified',
  );
  assert.ok(
    classificationEvent,
    `missing trade.loss_attribution_classified event; saw ${JSON.stringify(
      createdAuditEvents.map((event) => event.eventType),
    )}`,
  );
  const classificationMetadata =
    classificationEvent && typeof classificationEvent.metadata === 'object'
      ? (classificationEvent.metadata as Record<string, unknown>)
      : null;
  assert.ok(classificationMetadata?.lossAttribution);
  const orderEvent = createdAuditEvents.find(
    (event) => event.eventType === 'order.submitted',
  );
  assert.ok(orderEvent);
  const orderMetadata =
    orderEvent && typeof orderEvent.metadata === 'object'
      ? (orderEvent.metadata as Record<string, unknown>)
      : null;
  assert.ok(orderMetadata?.lossAttribution);

  const orderId =
    typeof classificationEvent?.orderId === 'string' ? classificationEvent.orderId : null;
  assert.ok(orderId);
  const lineageRecord = await versionLineageRegistry.getLatestForOrder(orderId!);
  assert.ok(lineageRecord);
  assert.strictEqual(lineageRecord?.tags.includes('loss_attribution'), true);
}

async function testDailyReviewPersistsLossAttributionSummary(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'item1-loss-review-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const learningEventLog = new LearningEventLog(rootDir);
  const createdAuditEvents: Array<Record<string, unknown>> = [];

  const prisma = {
    strategyVersion: {
      findMany: async () => [],
    },
    executionDiagnostic: {
      findMany: async () => [
        {
          orderId: 'order-1',
          strategyVersionId: 'strategyA',
          expectedEv: 0.05,
          realizedEv: 0.02,
          expectedFee: 0.003,
          realizedFee: 0.003,
          expectedSlippage: 0.004,
          realizedSlippage: 0.006,
          edgeAtSignal: 0.07,
          edgeAtFill: 0.05,
          fillRate: 1,
          regime: 'trend_burst',
          capturedAt: new Date('2026-03-25T00:01:00.000Z'),
          staleOrder: false,
        },
      ],
      create: async () => null,
    },
    order: {
      findMany: async () => [
        {
          id: 'order-1',
          marketId: 'market-1',
          tokenId: 'yes-1',
          side: 'BUY',
          status: 'filled',
          strategyVersionId: 'strategyA',
          createdAt: new Date('2026-03-25T00:00:00.000Z'),
          postedAt: new Date('2026-03-25T00:00:01.000Z'),
          acknowledgedAt: new Date('2026-03-25T00:00:03.000Z'),
          filledSize: 1,
          remainingSize: 0,
          size: 1,
          price: 0.55,
          signal: {
            id: 'signal-1',
            marketId: 'market-1',
            strategyVersionId: 'strategyA',
            posteriorProbability: 0.68,
            marketImpliedProb: 0.56,
            edge: 0.07,
            expectedEv: 0.05,
            regime: 'trend_burst',
            observedAt: new Date('2026-03-25T00:00:00.000Z'),
          },
          market: {
            id: 'market-1',
            expiresAt: new Date('2026-03-25T00:10:00.000Z'),
          },
        },
      ],
    },
    orderbook: {
      findFirst: async () => ({
        spread: 0.02,
        observedAt: new Date('2026-03-25T00:00:00.000Z'),
        askLevels: [{ price: 0.56, size: 12 }],
        bidLevels: [{ price: 0.54, size: 10 }],
      }),
    },
    fill: {
      findMany: async () => [],
    },
    auditEvent: {
      findMany: async ({ where }: { where?: { eventType?: string } }) => {
        if (where?.eventType === 'trade.loss_attribution_classified') {
          return [
            {
              eventType: 'trade.loss_attribution_classified',
              orderId: 'order-1',
              signalId: 'signal-1',
              createdAt: new Date('2026-03-25T00:02:00.000Z'),
              metadata: {
                lossAttribution: {
                  lossCategory: 'slippage_excess',
                  lossReasonCodes: ['realized_slippage_exceeds_expectation'],
                  forecastQualityAssessment: 'watch',
                  executionQualityAssessment: 'degraded',
                  primaryLeakageDriver: 'slippage_excess',
                  secondaryLeakageDrivers: ['toxicity_damage'],
                },
              },
            },
          ];
        }
        return [
          {
            orderId: 'order-1',
            eventType: 'order.submitted',
            createdAt: new Date('2026-03-25T00:00:03.000Z'),
            metadata: {
              route: 'maker',
              executionStyle: 'rest',
            },
          },
        ];
      },
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

  const reviewEvent = createdAuditEvents.find(
    (event) => event.eventType === 'learning.loss_attribution_review',
  );
  assert.ok(reviewEvent);
  const metadata =
    reviewEvent && typeof reviewEvent.metadata === 'object'
      ? (reviewEvent.metadata as Record<string, unknown>)
      : null;
  assert.strictEqual(metadata?.sampleCount, 1);
  assert.strictEqual(metadata?.dominantLossCategory, 'slippage_excess');

  const finalState = await learningStateStore.load();
  const reviewOutputs =
    finalState.lastCycleSummary?.reviewOutputs &&
    typeof finalState.lastCycleSummary.reviewOutputs === 'object'
      ? (finalState.lastCycleSummary.reviewOutputs as Record<string, unknown>)
      : null;
  const lossAttribution =
    reviewOutputs?.lossAttribution && typeof reviewOutputs.lossAttribution === 'object'
      ? (reviewOutputs.lossAttribution as Record<string, unknown>)
      : null;
  assert.ok(lossAttribution);
  assert.strictEqual(lossAttribution?.dominantLossCategory, 'slippage_excess');
}

function buildExecutionSignal() {
  return {
    id: 'signal-1',
    marketId: 'm1',
    strategyVersionId: 'strategy-loss-1',
    side: 'BUY',
    tokenId: 'yes1',
    outcome: 'YES',
    intent: 'ENTER',
    inventoryEffect: 'INCREASE',
    priorProbability: 0.58,
    posteriorProbability: 0.69,
    marketImpliedProb: 0.55,
    edge: 0.03,
    expectedEv: 0.045,
    regime: 'momentum_continuation',
    status: 'approved',
    observedAt: new Date(Date.now() - 3_000),
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
  return {
    bestBid: input?.bidLevels?.[0]?.price ?? 0.54,
    bestAsk: input?.askLevels?.[0]?.price ?? 0.55,
    spread: input?.spread ?? 0.01,
    bidLevels:
      input?.bidLevels ?? [
        { price: 0.54, size: 18 },
        { price: 0.53, size: 14 },
      ],
    askLevels:
      input?.askLevels ?? [
        { price: 0.55, size: 18 },
        { price: 0.56, size: 14 },
      ],
    tickSize: 0.01,
    minOrderSize: 1,
    negRisk: false,
    observedAt: input?.observedAt ?? new Date(),
  };
}

function createFreshCheckpoint(source: string) {
  return {
    source,
    processedAt: new Date(),
    status: 'completed',
  };
}

function createFreshRuntimeStatus() {
  return {
    id: 'live',
    state: 'running',
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

export const itemOneLossAttributionClassifierTests = [
  {
    name: 'item1 loss attribution classifier detects alpha wrong',
    fn: testLossAttributionClassifierAlphaWrong,
  },
  {
    name: 'item1 loss attribution classifier detects slippage excess',
    fn: testLossAttributionClassifierSlippageExcess,
  },
  {
    name: 'item1 loss attribution classifier detects fill quality failure',
    fn: testLossAttributionClassifierFillQualityFailure,
  },
  {
    name: 'item1 loss attribution classifier detects latency decay',
    fn: testLossAttributionClassifierLatencyDecay,
  },
  {
    name: 'item1 loss attribution classifier detects toxicity damage',
    fn: testLossAttributionClassifierToxicityDamage,
  },
  {
    name: 'item1 loss attribution classifier detects over sizing',
    fn: testLossAttributionClassifierOverSizing,
  },
  {
    name: 'item1 loss attribution classifier detects regime drift',
    fn: testLossAttributionClassifierRegimeDrift,
  },
  {
    name: 'item1 loss attribution classifier detects mixed leakage',
    fn: testLossAttributionClassifierMixed,
  },
  {
    name: 'item1 execute orders emits loss attribution evidence',
    fn: testExecuteOrdersEmitsLossAttributionEvidence,
  },
  {
    name: 'item1 daily review persists loss attribution summary',
    fn: testDailyReviewPersistsLossAttributionSummary,
  },
];
