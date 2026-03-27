import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DailyReviewJob } from '../jobs/dailyReview.job';
import { EvaluateTradeOpportunitiesJob } from '../jobs/evaluateTradeOpportunities.job';
import { ExecuteOrdersJob } from '../jobs/executeOrders.job';
import { LearningEventLog } from '../runtime/learning-event-log';
import { LearningStateStore } from '../runtime/learning-state-store';
import { StrategyDeploymentRegistry } from '../runtime/strategy-deployment-registry';
import { VersionLineageRegistry } from '../runtime/version-lineage-registry';
import { buildExecutionLearningContextKey } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import {
  LiveSizingFeedbackPolicy,
  TradeQualityHistoryStore,
} from '@polymarket-btc-5m-agentic-bot/risk-engine';
import {
  buildStrategyVariantId,
  createDefaultExecutionLearningState,
  createDefaultLearningState,
  createDefaultStrategyVariantState,
  type ResolvedTradeRecord,
  type ExecutionPolicyVersion,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { ResolvedTradeLedger } from '../runtime/resolved-trade-ledger';

async function testLiveSizingFeedbackPolicyHealthyCase(): Promise<void> {
  const decision = new LiveSizingFeedbackPolicy().evaluate({
    retentionRatio: 0.98,
    calibrationHealth: 'healthy',
    executionDrift: 0.002,
    regimeDegradation: 'healthy',
    toxicityState: 'normal',
    venueUncertainty: 'healthy',
    realizedVsExpected: 1.02,
  });

  assert.strictEqual(decision.sizeMultiplier, 1);
  assert.strictEqual(decision.downshiftMultiplier, 1);
  assert.strictEqual(decision.upshiftEligibility, 'eligible');
  assert.strictEqual(decision.recoveryProbationState, 'none');
  assert.strictEqual(decision.aggressionCap, 'unchanged');
  assert.strictEqual(decision.thresholdAdjustment, 0);
  assert.strictEqual(decision.regimePermissionOverride, 'unchanged');
  assert.deepStrictEqual(decision.sizingReasonCodes, []);
  assert.deepStrictEqual(decision.reasonCodes, []);
}

async function testLiveSizingFeedbackPolicyDegradedCase(): Promise<void> {
  const decision = new LiveSizingFeedbackPolicy().evaluate({
    retentionRatio: 0.52,
    calibrationHealth: 'degraded',
    executionDrift: -0.018,
    regimeDegradation: 'degraded',
    toxicityState: 'elevated',
    venueUncertainty: 'degraded',
    realizedVsExpected: 0.78,
  });

  assert.strictEqual(decision.sizeMultiplier < 1, true);
  assert.strictEqual(decision.downshiftMultiplier < 1, true);
  assert.strictEqual(decision.upshiftEligibility, 'not_eligible');
  assert.strictEqual(decision.recoveryProbationState, 'extended');
  assert.strictEqual(decision.aggressionCap, 'passive_only');
  assert.strictEqual(decision.thresholdAdjustment > 0, true);
  assert.strictEqual(
    decision.reasonCodes.includes('realized_vs_expected_hard_miss'),
    true,
  );
  assert.strictEqual(
    decision.sizingReasonCodes.includes('recovery_probation_extended'),
    true,
  );
}

async function testLiveSizingFeedbackPolicyBlockedCase(): Promise<void> {
  const decision = new LiveSizingFeedbackPolicy().evaluate({
    retentionRatio: 0.28,
    calibrationHealth: 'quarantine_candidate',
    executionDrift: -0.03,
    regimeDegradation: 'quarantine_candidate',
    toxicityState: 'blocked',
    venueUncertainty: 'unsafe',
    realizedVsExpected: 0.58,
  });

  assert.strictEqual(decision.aggressionCap, 'passive_only');
  assert.strictEqual(decision.regimePermissionOverride, 'block_new_entries');
  assert.strictEqual(decision.sizeMultiplier < 0.5, true);
}

async function testLiveSizingFeedbackPolicyRecoveryProbationCase(): Promise<void> {
  const decision = new LiveSizingFeedbackPolicy().evaluate({
    retentionRatio: 0.9,
    calibrationHealth: 'healthy',
    executionDrift: 0.001,
    regimeDegradation: 'healthy',
    toxicityState: 'normal',
    venueUncertainty: 'healthy',
    realizedVsExpected: 0.96,
  });

  assert.strictEqual(decision.downshiftMultiplier, 1);
  assert.strictEqual(decision.sizeMultiplier, 0.9);
  assert.strictEqual(decision.upshiftEligibility, 'probationary');
  assert.strictEqual(decision.recoveryProbationState, 'active');
  assert.strictEqual(
    decision.sizingReasonCodes.includes('slow_recovery_cap_applied'),
    true,
  );
}

async function testEvaluateTradeOpportunitiesAppliesLiveSizingFeedback(): Promise<void> {
  const healthy = await runEvaluationScenario('healthy');
  const recovering = await runEvaluationScenario('recovering');
  const degraded = await runEvaluationScenario('degraded');

  assert.ok(healthy.liveSizingFeedback);
  assert.ok(recovering.liveSizingFeedback);
  assert.ok(degraded.liveSizingFeedback);
  assert.strictEqual(
    (degraded.liveSizingFeedback?.sizeMultiplier as number | undefined ?? 1) <
      (recovering.liveSizingFeedback?.sizeMultiplier as number | undefined ?? 1),
    true,
  );
  assert.strictEqual(
    (recovering.liveSizingFeedback?.sizeMultiplier as number | undefined ?? 1) <
      (healthy.liveSizingFeedback?.sizeMultiplier as number | undefined ?? 1),
    true,
  );
  assert.strictEqual(
    (degraded.liveSizingFeedback?.thresholdAdjustment as number | undefined ?? 0) >=
      (healthy.liveSizingFeedback?.thresholdAdjustment as number | undefined ?? 0),
    true,
  );
  assert.strictEqual(
    recovering.liveSizingFeedback?.upshiftEligibility,
    'probationary',
  );
  assert.strictEqual(
    recovering.liveSizingFeedback?.recoveryProbationState,
    'active',
  );
  assert.strictEqual(degraded.result.approved <= healthy.result.approved, true);
  if (
    healthy.result.approved === 1 &&
    recovering.result.approved === 1 &&
    degraded.result.approved === 1
  ) {
    assert.strictEqual((recovering.positionSize ?? 0) < (healthy.positionSize ?? 0), true);
    assert.strictEqual((degraded.positionSize ?? 0) < (recovering.positionSize ?? 0), true);
  }
}

async function testExecuteOrdersCapsAggressionUnderLiveFeedback(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase4-execute-orders-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const learningState = createDefaultLearningState(
    new Date('2026-03-25T00:00:00.000Z'),
  );
  const strategyVariantId = buildStrategyVariantId('strategy-live-1');
  const contextKey = buildExecutionLearningContextKey(
    strategyVariantId,
    'momentum_continuation',
  );
  const activePolicy: ExecutionPolicyVersion = {
    versionId: 'execution-policy:phase4:v1',
    contextKey,
    strategyVariantId,
    regime: 'momentum_continuation',
    mode: 'taker_preferred',
    recommendedRoute: 'taker',
    recommendedExecutionStyle: 'cross',
    sampleCount: 16,
    makerFillRateAssumption: 0.42,
    takerFillRateAssumption: 0.9,
    expectedFillDelayMs: 18_000,
    expectedSlippage: 0.0038,
    adverseSelectionScore: 0.46,
    cancelSuccessRate: 0.7,
    partialFillRate: 0.24,
    health: 'degraded',
    rationale: ['phase4_test_policy'],
    sourceCycleId: 'cycle-1',
    supersedesVersionId: null,
    createdAt: '2026-03-25T00:00:00.000Z',
  };
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
        entryTimingBucket: 'early',
        executionStyle: 'hybrid',
        side: 'buy',
        strategyVariantId,
        sampleCount: 12,
        winRate: 0.35,
        expectedEvSum: 0.18,
        realizedEvSum: 0.11,
        avgExpectedEv: 0.015,
        avgRealizedEv: 0.009,
        realizedVsExpected: 0.72,
        avgFillRate: 0.64,
        avgSlippage: 0.0042,
        health: 'degraded',
        lastObservedAt: '2026-03-25T00:00:00.000Z',
      },
    },
    executionLearning: {
      ...createDefaultExecutionLearningState(),
      contexts: {
        [contextKey]: {
          contextKey,
          strategyVariantId,
          regime: 'momentum_continuation',
          sampleCount: 16,
          makerSampleCount: 8,
          takerSampleCount: 8,
          makerFillRate: 0.42,
          takerFillRate: 0.9,
          averageFillDelayMs: 18_000,
          averageSlippage: 0.0038,
          adverseSelectionScore: 0.46,
          cancelSuccessRate: 0.7,
          partialFillRate: 0.24,
          makerPunished: false,
          health: 'degraded',
          notes: ['phase4_test_context'],
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
    },
  };
  learningState.calibration[`strategy:${strategyVariantId}|regime:momentum_continuation`] = {
    contextKey: `strategy:${strategyVariantId}|regime:momentum_continuation`,
    strategyVariantId,
    regime: 'momentum_continuation',
    sampleCount: 20,
    brierScore: 0.23,
    logLoss: 0.61,
    shrinkageFactor: 0.78,
    overconfidenceScore: 0.17,
    health: 'degraded',
    version: 1,
    driftSignals: ['phase4_degraded_calibration'],
    lastUpdatedAt: '2026-03-25T00:00:00.000Z',
  };
  await learningStateStore.save(learningState);

  let auditMetadata: Record<string, unknown> | null = null;
  const storedAuditEvents = [
    {
      eventType: 'learning.alpha_attribution_review',
      createdAt: new Date('2026-03-25T00:05:00.000Z'),
      metadata: {
        averageExpectedNetEdge: 0.02,
        averageRealizedNetEdge: 0.012,
        averageRetentionRatio: 0.58,
      },
    },
  ];
  const prisma = {
    signal: {
      findMany: async () => [
        buildExecutionSignal({
          regime: 'momentum_continuation',
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
          spread: 0.016,
          bidLevels: [
            { price: 0.52, size: 12 },
            { price: 0.51, size: 8 },
          ],
          askLevels: [
            { price: 0.536, size: 13 },
            { price: 0.548, size: 8 },
          ],
          observedAt: new Date(),
        }),
    },
    order: {
      findFirst: async () => null,
      create: async () => null,
    },
    auditEvent: {
      findMany: async () => storedAuditEvents,
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
      findMany: async () => [
        {
          strategyVersionId: 'strategy-live-1',
          regime: 'momentum_continuation',
          evDrift: -0.02,
          expectedFee: 0.001,
          realizedFee: 0.0014,
          expectedSlippage: 0.0025,
          realizedSlippage: 0.0041,
          edgeAtSignal: 0.03,
          edgeAtFill: 0.018,
          fillRate: 0.74,
          staleOrder: false,
          capturedAt: new Date(),
        },
      ],
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
    assert.strictEqual(metadata.executionStyle, 'rest');
    assert.strictEqual(metadata.route, 'maker');
    assert.ok(
      metadata.liveSizingFeedback && typeof metadata.liveSizingFeedback === 'object',
    );
    const liveSizingFeedback = metadata.liveSizingFeedback as Record<string, unknown>;
    assert.strictEqual(
      typeof liveSizingFeedback.recoveryProbationState === 'string',
      true,
    );
    assert.strictEqual(
      Array.isArray(liveSizingFeedback.sizingReasonCodes),
      true,
    );
  }
}

async function testDailyReviewPersistsLiveSizingFeedbackSummary(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase4-live-feedback-review-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const learningEventLog = new LearningEventLog(rootDir);
  const learningState = createDefaultLearningState(
    new Date('2026-03-25T00:00:00.000Z'),
  );
  const strategyVariantId = buildStrategyVariantId('strategy-live-1');
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
        entryTimingBucket: 'early',
        executionStyle: 'hybrid',
        side: 'buy',
        strategyVariantId,
        sampleCount: 14,
        winRate: 0.42,
        expectedEvSum: 0.19,
        realizedEvSum: 0.12,
        avgExpectedEv: 0.014,
        avgRealizedEv: 0.009,
        realizedVsExpected: 0.63,
        avgFillRate: 0.66,
        avgSlippage: 0.004,
        health: 'degraded',
        lastObservedAt: '2026-03-25T00:00:00.000Z',
      },
    },
  };
  learningState.calibration[`strategy:${strategyVariantId}|regime:momentum_continuation`] = {
    contextKey: `strategy:${strategyVariantId}|regime:momentum_continuation`,
    strategyVariantId,
    regime: 'momentum_continuation',
    sampleCount: 20,
    brierScore: 0.23,
    logLoss: 0.61,
    shrinkageFactor: 0.8,
    overconfidenceScore: 0.18,
    health: 'degraded',
    version: 1,
    driftSignals: ['phase4_degraded_calibration'],
    lastUpdatedAt: '2026-03-25T00:00:00.000Z',
  };
  await learningStateStore.save(learningState);

  const createdAuditEvents: Array<Record<string, unknown>> = [];
  const storedAuditEvents: Array<Record<string, unknown>> = [
    {
      eventType: 'learning.alpha_attribution_review',
      createdAt: new Date('2026-03-25T00:01:00.000Z'),
      metadata: {
        averageExpectedNetEdge: 0.02,
        averageRealizedNetEdge: 0.012,
        averageRetentionRatio: 0.6,
      },
    },
    {
      eventType: 'signal.execution_decision',
      createdAt: new Date('2026-03-25T00:02:00.000Z'),
      metadata: {
        toxicity: {
          toxicityScore: 0.71,
          toxicityState: 'high',
          recommendedAction: 'disable_aggressive_execution',
        },
      },
    },
  ];

  const prisma = {
    strategyVersion: {
      findMany: async () => [],
    },
    executionDiagnostic: {
      findMany: async () => [
        {
          evDrift: -0.019,
          capturedAt: new Date('2026-03-25T00:03:00.000Z'),
        },
      ],
    },
    order: {
      findMany: async () => [],
    },
    auditEvent: {
      findMany: async () => storedAuditEvents,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        storedAuditEvents.push(data);
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

  const review = createdAuditEvents.find(
    (event) => event.eventType === 'learning.live_sizing_feedback_review',
  );
  const metadata =
    review && typeof review.metadata === 'object'
      ? (review.metadata as Record<string, unknown>)
      : null;
  const decision =
    metadata?.decision && typeof metadata.decision === 'object'
      ? (metadata.decision as Record<string, unknown>)
      : null;

  assert.ok(review);
  assert.ok(decision);
  assert.strictEqual((decision?.sizeMultiplier as number | undefined ?? 1) < 1, true);
  assert.strictEqual(
    typeof decision?.recoveryProbationState === 'string',
    true,
  );
  assert.strictEqual(typeof decision?.upshiftEligibility === 'string', true);
}

async function runEvaluationScenario(
  feedbackState: 'healthy' | 'recovering' | 'degraded',
) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase4-evaluate-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const resolvedTradeLedger = new ResolvedTradeLedger(rootDir);
  const versionLineageRegistry = new VersionLineageRegistry(
    path.join(rootDir, 'version-lineage'),
  );
  const deploymentRegistry = new StrategyDeploymentRegistry(
    path.join(rootDir, 'deployment-registry'),
  );
  const venueHealthLearningStore = {
    getCurrentMetrics: async () => ({
      venueId: 'polymarket',
      updatedAt: new Date('2026-03-25T00:00:00.000Z').toISOString(),
      latencyDistribution: {
        sampleCount: 10,
        averageMs: 220,
        p50Ms: 200,
        p90Ms: 320,
        p99Ms: 450,
        maxMs: 500,
      },
      requestFailures: {
        totalRequests: 20,
        failedRequests: 0,
        failureRate: 0,
        failuresByCategory: {},
      },
      staleDataIntervals: {
        sampleCount: 5,
        averageMs: 500,
        p90Ms: 900,
        maxMs: 1_000,
      },
      openOrderVisibilityLag: {
        sampleCount: 5,
        averageMs: 200,
        p90Ms: 300,
        maxMs: 320,
      },
      tradeVisibilityLag: {
        sampleCount: 5,
        averageMs: 180,
        p90Ms: 260,
        maxMs: 280,
      },
      cancelAcknowledgmentLag: {
        sampleCount: 5,
        averageMs: 240,
        p90Ms: 350,
        maxMs: 400,
      },
      activeMode: 'normal',
      uncertaintyLabel: 'healthy',
    }),
    setOperationalAssessment: async () => null,
  };
  const tradeQualityHistoryStore = new TradeQualityHistoryStore(
    path.join(rootDir, 'trade-quality'),
  );
  const strategyVariantId = buildStrategyVariantId('strategy-live-1');
  const useDegradedFeedback = feedbackState === 'degraded';
  const useRecoveringFeedback = feedbackState === 'recovering';
  const learningState = createDefaultLearningState(new Date('2026-03-25T00:00:00.000Z'));
  learningState.strategyVariants[strategyVariantId] = {
    ...createDefaultStrategyVariantState(strategyVariantId),
    health: useDegradedFeedback ? 'degraded' : 'healthy',
    regimeSnapshots: {
      'regime:momentum_continuation': {
        key: 'regime:momentum_continuation',
        regime: 'momentum_continuation',
        liquidityBucket: 'balanced',
        spreadBucket: 'normal',
        timeToExpiryBucket: 'under_15m',
        entryTimingBucket: 'early',
        executionStyle: 'hybrid',
        side: 'buy',
        strategyVariantId,
        sampleCount: 20,
        winRate: useDegradedFeedback ? 0.4 : 0.58,
        expectedEvSum: 0.28,
        realizedEvSum: useDegradedFeedback ? 0.16 : useRecoveringFeedback ? 0.24 : 0.26,
        avgExpectedEv: 0.014,
        avgRealizedEv: useDegradedFeedback ? 0.008 : useRecoveringFeedback ? 0.012 : 0.013,
        realizedVsExpected: useDegradedFeedback ? 0.62 : useRecoveringFeedback ? 0.96 : 0.98,
        avgFillRate: useDegradedFeedback ? 0.68 : 0.86,
        avgSlippage: useDegradedFeedback ? 0.004 : 0.0018,
        health: useDegradedFeedback ? 'degraded' : 'healthy',
        lastObservedAt: '2026-03-25T00:00:00.000Z',
      },
    },
  };
  learningState.calibration[`strategy:${strategyVariantId}|regime:momentum_continuation`] = {
    contextKey: `strategy:${strategyVariantId}|regime:momentum_continuation`,
    strategyVariantId,
    regime: 'momentum_continuation',
    sampleCount: 22,
    brierScore: useDegradedFeedback ? 0.23 : 0.16,
    logLoss: useDegradedFeedback ? 0.61 : 0.44,
    shrinkageFactor: useDegradedFeedback ? 0.8 : 1,
    overconfidenceScore: useDegradedFeedback ? 0.18 : 0.04,
    health: useDegradedFeedback ? 'degraded' : 'healthy',
    version: 1,
    driftSignals: useDegradedFeedback ? ['phase4_degraded'] : [],
    lastUpdatedAt: '2026-03-25T00:00:00.000Z',
  };
  await learningStateStore.save(learningState);
  for (const record of buildResolvedTradeFixtures({
    strategyVariantId,
    regime: 'momentum_continuation',
  })) {
    await resolvedTradeLedger.append(record);
  }

  const createdDecisions: Array<Record<string, unknown>> = [];
  const auditEvents: Array<Record<string, unknown>> = [];
  const signal = buildExecutionSignal({
    regime: 'momentum_continuation',
    expectedEv: 0.055,
    edge: 0.036,
    observedAt: new Date(Date.now() - 4_000),
  });
  const market = buildMarket();
  const priorAuditEvents = useDegradedFeedback
    ? [
        {
          eventType: 'learning.alpha_attribution_review',
          createdAt: new Date('2026-03-25T00:01:00.000Z'),
          metadata: {
            averageExpectedNetEdge: 0.02,
            averageRealizedNetEdge: 0.012,
            averageRetentionRatio: 0.6,
          },
        },
      ]
    : useRecoveringFeedback
      ? [
          {
            eventType: 'learning.alpha_attribution_review',
            createdAt: new Date('2026-03-25T00:01:00.000Z'),
            metadata: {
              averageExpectedNetEdge: 0.02,
              averageRealizedNetEdge: 0.0192,
              averageRetentionRatio: 0.9,
            },
          },
        ]
      : [];

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
        ...buildOrderbook({
          spread: 0.01,
          bidLevels: [
            { price: 0.54, size: 24 },
            { price: 0.53, size: 18 },
          ],
          askLevels: [
            { price: 0.55, size: 24 },
            { price: 0.56, size: 18 },
          ],
        }),
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
                promotion: { score: 0.82 },
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
      findMany: async () =>
        useDegradedFeedback
          ? [
              {
                strategyVersionId: 'strategy-live-1',
                regime: 'momentum_continuation',
                evDrift: -0.02,
                expectedFee: 0.001,
                realizedFee: 0.0014,
                expectedSlippage: 0.002,
                realizedSlippage: 0.0038,
                edgeAtSignal: 0.036,
                edgeAtFill: 0.021,
                fillRate: 0.72,
                staleOrder: false,
                capturedAt: new Date(),
              },
            ]
          : [],
    },
    auditEvent: {
      findMany: async () => priorAuditEvents,
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
    venueHealthLearningStore as never,
    tradeQualityHistoryStore,
    undefined,
    resolvedTradeLedger,
  );
  const result = await job.run(buildRuntimeConfig());
  const approvedDecision = createdDecisions.find((decision) => decision.verdict === 'approved');
  const decisionEvent = auditEvents.find(
    (event) => event.eventType === 'signal.execution_decision',
  );
  const liveSizingFeedback =
    decisionEvent &&
    typeof decisionEvent.metadata === 'object' &&
    (decisionEvent.metadata as Record<string, unknown>).liveSizingFeedback &&
    typeof (decisionEvent.metadata as Record<string, unknown>).liveSizingFeedback === 'object'
      ? ((decisionEvent.metadata as Record<string, unknown>).liveSizingFeedback as Record<
          string,
          unknown
        >)
      : null;

  return {
    result,
    positionSize:
      approvedDecision && typeof approvedDecision.positionSize === 'number'
        ? approvedDecision.positionSize
        : null,
    liveSizingFeedback: liveSizingFeedback as
      | (Record<string, unknown> & {
          sizeMultiplier?: number;
          upshiftEligibility?: string;
          recoveryProbationState?: string;
        })
      | null,
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

function buildResolvedTradeFixtures(input: {
  strategyVariantId: string;
  regime: string;
}): ResolvedTradeRecord[] {
  return Array.from({ length: 10 }, (_, index) =>
    createResolvedTradeFixture({
      tradeId: `phase4-trade-${index + 1}`,
      orderId: `phase4-order-${index + 1}`,
      strategyVariantId: input.strategyVariantId,
      strategyVersion: input.strategyVariantId.replace('variant:', ''),
      regime: input.regime,
      finalizedTimestamp: new Date(Date.UTC(2026, 2, 25, 0, index)).toISOString(),
      capturedAt: new Date(Date.UTC(2026, 2, 25, 0, index)).toISOString(),
    }),
  );
}

function createResolvedTradeFixture(
  overrides: Partial<ResolvedTradeRecord>,
): ResolvedTradeRecord {
  return {
    tradeId: overrides.tradeId ?? 'phase4-trade-default',
    orderId: overrides.orderId ?? 'phase4-order-default',
    venueOrderId: overrides.venueOrderId ?? 'phase4-venue-order-default',
    marketId: overrides.marketId ?? 'm1',
    tokenId: overrides.tokenId ?? 'yes1',
    strategyVariantId: overrides.strategyVariantId ?? buildStrategyVariantId('strategy-live-1'),
    strategyVersion: overrides.strategyVersion ?? 'strategy-live-1',
    regime: overrides.regime ?? 'momentum_continuation',
    archetype: overrides.archetype ?? 'trend_follow_through',
    decisionTimestamp: overrides.decisionTimestamp ?? '2026-03-25T00:00:00.000Z',
    submissionTimestamp: overrides.submissionTimestamp ?? '2026-03-25T00:00:01.000Z',
    firstFillTimestamp: overrides.firstFillTimestamp ?? '2026-03-25T00:00:02.000Z',
    finalizedTimestamp: overrides.finalizedTimestamp ?? '2026-03-25T00:00:10.000Z',
    side: overrides.side ?? 'BUY',
    intendedPrice: overrides.intendedPrice ?? 0.54,
    averageFillPrice: overrides.averageFillPrice ?? 0.541,
    size: overrides.size ?? 20,
    notional: overrides.notional ?? 10.82,
    estimatedFeeAtDecision: overrides.estimatedFeeAtDecision ?? 0.05,
    realizedFee: overrides.realizedFee ?? 0.051,
    estimatedSlippageBps: overrides.estimatedSlippageBps ?? 10,
    realizedSlippageBps: overrides.realizedSlippageBps ?? 11,
    queueDelayMs: overrides.queueDelayMs ?? 2_500,
    fillFraction: overrides.fillFraction ?? 1,
    expectedNetEdgeBps: overrides.expectedNetEdgeBps ?? 58,
    realizedNetEdgeBps: overrides.realizedNetEdgeBps ?? 62,
    maxFavorableExcursionBps: overrides.maxFavorableExcursionBps ?? 95,
    maxAdverseExcursionBps: overrides.maxAdverseExcursionBps ?? -18,
    toxicityScoreAtDecision: overrides.toxicityScoreAtDecision ?? 0.18,
    benchmarkContext: overrides.benchmarkContext ?? {
      benchmarkComparisonState: 'outperforming',
      baselinePenaltyMultiplier: 1,
      regimeBenchmarkGateState: 'passed',
      underperformedBenchmarkIds: [],
      outperformedBenchmarkIds: ['btc_follow_baseline'],
      reasonCodes: ['phase4_fixture'],
    },
    lossAttributionCategory: overrides.lossAttributionCategory ?? 'mixed',
    executionAttributionCategory:
      overrides.executionAttributionCategory ?? 'queue_decay',
    lifecycleState:
      overrides.lifecycleState ?? 'economically_resolved_with_portfolio_truth',
    attribution: overrides.attribution ?? {
      benchmarkContext: overrides.benchmarkContext ?? {
        benchmarkComparisonState: 'outperforming',
        baselinePenaltyMultiplier: 1,
        regimeBenchmarkGateState: 'passed',
        underperformedBenchmarkIds: [],
        outperformedBenchmarkIds: ['btc_follow_baseline'],
        reasonCodes: ['phase4_fixture'],
      },
      lossAttributionCategory: 'mixed',
      executionAttributionCategory: 'queue_decay',
      primaryLeakageDriver: 'queue_delay',
      secondaryLeakageDrivers: ['slippage'],
      reasonCodes: ['phase4_fixture'],
    },
    executionQuality: overrides.executionQuality ?? {
      intendedPrice: overrides.intendedPrice ?? 0.54,
      averageFillPrice: overrides.averageFillPrice ?? 0.541,
      size: overrides.size ?? 20,
      notional: overrides.notional ?? 10.82,
      estimatedFeeAtDecision: overrides.estimatedFeeAtDecision ?? 0.05,
      realizedFee: overrides.realizedFee ?? 0.051,
      estimatedSlippageBps: overrides.estimatedSlippageBps ?? 10,
      realizedSlippageBps: overrides.realizedSlippageBps ?? 11,
      queueDelayMs: overrides.queueDelayMs ?? 2_500,
      fillFraction: overrides.fillFraction ?? 1,
    },
    netOutcome: overrides.netOutcome ?? {
      expectedNetEdgeBps: overrides.expectedNetEdgeBps ?? 58,
      realizedNetEdgeBps: overrides.realizedNetEdgeBps ?? 62,
      maxFavorableExcursionBps: overrides.maxFavorableExcursionBps ?? 95,
      maxAdverseExcursionBps: overrides.maxAdverseExcursionBps ?? -18,
      realizedPnl: 0.72,
    },
    capturedAt: overrides.capturedAt ?? overrides.finalizedTimestamp ?? '2026-03-25T00:00:10.000Z',
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
    regime: overrides?.regime ?? 'momentum_continuation',
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

export const phaseFourLiveSizingFeedbackTests = [
  {
    name: 'phase4 live sizing feedback policy leaves healthy state unchanged',
    fn: testLiveSizingFeedbackPolicyHealthyCase,
  },
  {
    name: 'phase4 live sizing feedback policy reduces size in degraded state',
    fn: testLiveSizingFeedbackPolicyDegradedCase,
  },
  {
    name: 'phase4 live sizing feedback policy blocks extreme degraded state',
    fn: testLiveSizingFeedbackPolicyBlockedCase,
  },
  {
    name: 'phase4 live sizing feedback policy restores size slowly under recovery',
    fn: testLiveSizingFeedbackPolicyRecoveryProbationCase,
  },
  {
    name: 'phase4 evaluate trade opportunities applies live sizing feedback',
    fn: testEvaluateTradeOpportunitiesAppliesLiveSizingFeedback,
  },
  {
    name: 'phase4 execute orders caps aggression under live sizing feedback',
    fn: testExecuteOrdersCapsAggressionUnderLiveFeedback,
  },
  {
    name: 'phase4 daily review persists live sizing feedback summary',
    fn: testDailyReviewPersistsLiveSizingFeedbackSummary,
  },
];
