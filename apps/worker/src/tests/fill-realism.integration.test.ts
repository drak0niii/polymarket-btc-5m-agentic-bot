import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  FillRealismStore,
  OrderPlanner,
  PostFillToxicityStore,
  buildFillRealismBucket,
} from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { ExecuteOrdersJob } from '../jobs/executeOrders.job';
import { ReconcileFillsJob } from '../jobs/reconcileFills.job';
import { appEnv } from '../config/env';
import { ResolvedTradeLedger } from '../runtime/resolved-trade-ledger';

async function testFillRealismStoresPersistAndSummarizeByBucket(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-realism-store-'));
  const fillRealismStore = new FillRealismStore(rootDir);
  const postFillToxicityStore = new PostFillToxicityStore(rootDir);
  const bucket = buildFillRealismBucket({
    spreadBucket: 'normal',
    liquidityBucket: 'balanced',
    orderUrgency: 'medium',
    regime: 'balanced_rotation',
    executionStyle: 'maker',
    venueUncertaintyLabel: 'healthy',
  });

  await fillRealismStore.append({
    observationId: 'obs-1',
    orderId: 'order-1',
    tradeId: 'trade-1',
    bucket,
    fillProbabilityWithin1s: 0.2,
    fillProbabilityWithin3s: 0.5,
    fillProbabilityWithin5s: 0.8,
    fillProbabilityWithin10s: 1,
    fillFraction: 1,
    queueDelayMs: 4_000,
    cancelSuccessLatencyMs: null,
    slippageBps: 12,
    capturedAt: '2026-03-27T10:00:00.000Z',
  });
  await fillRealismStore.append({
    observationId: 'obs-2',
    orderId: 'order-2',
    tradeId: 'trade-2',
    bucket,
    fillProbabilityWithin1s: 0.1,
    fillProbabilityWithin3s: 0.3,
    fillProbabilityWithin5s: 0.6,
    fillProbabilityWithin10s: 0.9,
    fillFraction: 0.9,
    queueDelayMs: 9_000,
    cancelSuccessLatencyMs: null,
    slippageBps: 20,
    capturedAt: '2026-03-27T10:02:00.000Z',
  });
  await postFillToxicityStore.append({
    observationId: 'tox-1',
    orderId: 'order-1',
    tradeId: 'trade-1',
    bucket,
    drift1sBps: 3,
    drift3sBps: 8,
    drift10sBps: 14,
    drift30sBps: 22,
    capturedAt: '2026-03-27T10:00:00.000Z',
  });

  const fillSummary = fillRealismStore.summarize({ bucket, limit: 10 });
  const toxicitySummary = postFillToxicityStore.summarize({ bucket, limit: 10 });

  assert.strictEqual(fillSummary.sampleCount, 2);
  assert.strictEqual(fillSummary.fillProbabilityWithin5s, 0.7);
  assert.strictEqual(fillSummary.averageFillFraction, 0.95);
  assert.strictEqual(fillSummary.averageSlippageBps, 16);
  assert.strictEqual(fillSummary.queueDelayProfile.p90Ms, 9_000);
  assert.strictEqual(toxicitySummary.sampleCount, 1);
  assert.strictEqual(toxicitySummary.expectedAdverseSelectionPenaltyBps, 22);
}

async function testOrderPlannerIncludesEmpiricalRealismFields(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-realism-planner-'));
  const fillRealismStore = new FillRealismStore(path.join(rootDir, 'fill'));
  const postFillToxicityStore = new PostFillToxicityStore(path.join(rootDir, 'toxicity'));
  const bucket = buildFillRealismBucket({
    spreadBucket: 'normal',
    liquidityBucket: 'thin',
    orderUrgency: 'high',
    regime: 'momentum_continuation',
    executionStyle: 'taker',
    venueUncertaintyLabel: 'degraded',
  });

  await fillRealismStore.append({
    observationId: 'planner-obs',
    orderId: 'planner-order',
    tradeId: 'planner-trade',
    bucket,
    fillProbabilityWithin1s: 0.45,
    fillProbabilityWithin3s: 0.7,
    fillProbabilityWithin5s: 0.82,
    fillProbabilityWithin10s: 0.9,
    fillFraction: 0.88,
    queueDelayMs: 5_500,
    cancelSuccessLatencyMs: null,
    slippageBps: 26,
    capturedAt: '2026-03-27T10:00:00.000Z',
  });
  await postFillToxicityStore.append({
    observationId: 'planner-tox',
    orderId: 'planner-order',
    tradeId: 'planner-trade',
    bucket,
    drift1sBps: 6,
    drift3sBps: 12,
    drift10sBps: 19,
    drift30sBps: 25,
    capturedAt: '2026-03-27T10:00:01.000Z',
  });

  const planner = new OrderPlanner({
    fillRealismStore,
    postFillToxicityStore,
  });
  const result = planner.plan({
    resolvedIntent: {
      tokenId: 'yes1',
      outcome: 'YES',
      intent: 'ENTER',
      venueSide: 'BUY',
      inventoryEffect: 'INCREASE',
    },
    price: 0.52,
    size: 15,
    urgency: 'high',
    expiryAt: '2026-03-27T12:00:00.000Z',
    noTradeWindowSeconds: 30,
    executionStyle: 'cross',
    venueConstraints: {
      tickSize: 0.01,
      minOrderSize: 1,
      negRisk: false,
    },
    liquidity: {
      topLevelDepth: 18,
      executableDepth: 18,
      recentMatchedVolume: 22,
      restingSizeAhead: 8,
      bestBid: 0.5,
      bestAsk: 0.52,
      spread: 0.02,
    },
    regime: 'momentum_continuation',
    venueUncertaintyLabel: 'degraded',
    feeRateBpsEstimate: 14,
  });

  assert.strictEqual(result.expectedFillProbability > 0.5, true);
  assert.strictEqual(result.expectedFillFraction != null, true);
  assert.strictEqual(result.expectedQueueDelayMs != null, true);
  assert.strictEqual(result.expectedRealizedCostBps > result.expectedAdverseSelectionPenaltyBps, true);
  assert.strictEqual(result.executionBucketContext.regime, 'momentum_continuation');
  assert.strictEqual(result.recommendedOrderStyleRationale.length >= 2, true);
  assert.strictEqual(result.postFillToxicitySummary?.expectedAdverseSelectionPenaltyBps, 25);
}

async function testExecuteOrdersWritesPlannerAssumptionsIntoMetadata(): Promise<void> {
  const originalLiveExecution = appEnv.BOT_LIVE_EXECUTION_ENABLED;
  (appEnv as { BOT_LIVE_EXECUTION_ENABLED: boolean }).BOT_LIVE_EXECUTION_ENABLED = false;
  const now = Date.now();
  const signalObservedAt = new Date(now - 5_000);
  const decisionAt = new Date(now - 4_000);
  const marketObservedAt = new Date(now - 3_000);
  const expiryAt = new Date(now + 2 * 60 * 60 * 1_000).toISOString();

  const auditEvents: Array<Record<string, unknown>> = [];
  const createdOrders: Array<Record<string, unknown>> = [];
  const reconciliationCheckpoints: Array<Record<string, unknown>> = [];
  const prisma = {
    liveConfig: { findUnique: async () => null },
    signal: {
      findMany: async () => [
        {
          id: 'signal-1',
          marketId: 'market-1',
          status: 'approved',
          observedAt: signalObservedAt,
          posteriorProbability: 0.61,
          marketImpliedProb: 0.54,
          expectedEv: 0.06,
          edge: 0.08,
          regime: 'balanced_rotation',
          strategyVersionId: 'sv-live-1',
          side: 'BUY',
        },
      ],
      update: async () => null,
    },
    signalDecision: {
      findFirst: async () => ({
        id: 'decision-1',
        positionSize: 20,
        decisionAt,
      }),
      create: async () => null,
    },
    order: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdOrders.push(data);
        return data;
      },
    },
    market: {
      findUnique: async () => ({
        id: 'market-1',
        slug: 'btc-up',
        title: 'BTC up?',
        status: 'active',
        tokenIdYes: 'yes1',
        tokenIdNo: 'no1',
        expiresAt: expiryAt,
      }),
    },
    marketSnapshot: {
      findFirst: async () => ({
        marketId: 'market-1',
        observedAt: marketObservedAt,
        expiresAt: expiryAt,
        volume: 180,
      }),
    },
    orderbook: {
      findFirst: async () => ({
        marketId: 'market-1',
        tokenId: 'yes1',
        observedAt: marketObservedAt,
        bestBid: 0.5,
        bestAsk: 0.52,
        spread: 0.02,
        bidLevels: [{ price: 0.5, size: 40 }],
        askLevels: [{ price: 0.52, size: 35 }],
        tickSize: 0.01,
        minOrderSize: 1,
        negRisk: false,
      }),
    },
    auditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        auditEvents.push(data);
        return data;
      },
      findMany: async () => [],
    },
    executionDiagnostic: {
      findMany: async () => [],
      create: async () => null,
    },
    reconciliationCheckpoint: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        reconciliationCheckpoints.push(data);
        return data;
      },
    },
  };

  const runtimeControl = {
    getLatestSafetyState: async () => ({
      haltRequested: false,
      state: 'normal',
      reasonCodes: [],
      allowNewEntries: true,
      allowAggressiveEntries: true,
      sizeMultiplier: 1,
    }),
  };
  const venueHealthLearningStore = {
    getCurrentMetrics: async () => ({
      venueId: 'polymarket',
      updatedAt: new Date().toISOString(),
      latencyDistribution: {},
      requestFailures: {},
      staleDataIntervals: {},
      openOrderVisibilityLag: {},
      tradeVisibilityLag: {},
      cancelAcknowledgmentLag: {},
      activeMode: 'normal',
      uncertaintyLabel: 'healthy',
    }),
    setOperationalAssessment: async () => null,
    recordRequest: async () => null,
    recordStaleDataInterval: async () => null,
  };

  const job = new ExecuteOrdersJob(
    prisma as never,
    runtimeControl as never,
    undefined,
    undefined,
    venueHealthLearningStore as never,
  );
  (job as any).assessExecutionReadiness = async () => ({ ready: true, reasonCode: 'passed' });
  (job as any).versionLineageRegistry = {
    getLatestForSignalDecision: async () => null,
    recordDecision: async () => null,
  };
  (job as any).decisionLogService = { record: async () => null };
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
  (job as any).liveTradeGuard = { evaluate: () => ({ passed: true, reasonCode: 'passed' }) };
  (job as any).marketEligibility = { evaluate: () => ({ eligible: true, reasonCode: 'passed' }) };
  (job as any).negativeRiskPolicy = { evaluate: () => ({ allowed: true, reasonCode: 'passed' }) };
  (job as any).venueUncertaintyDetector = { evaluate: () => ({ label: 'healthy' }) };
  (job as any).venueModePolicy = {
    decide: () => ({
      mode: 'normal',
      allowOrderSubmit: true,
      blockNewEntries: false,
      sizeMultiplier: 1,
    }),
  };
  (job as any).resolveExecutionIntent = () => ({
    tokenId: 'yes1',
    outcome: 'YES',
    venueSide: 'BUY',
    action: 'ENTER',
    inventoryEffect: 'increase',
  });
  (job as any).buildExecutionToxicity = () => ({
    toxicityScore: 0.12,
    bookInstabilityScore: 0.08,
    adverseSelectionRisk: 0.1,
    toxicityState: 'healthy',
    recommendedAction: 'no_change',
    sizeMultiplier: 1,
    widenThresholdBps: 0,
    disableAggressiveExecution: false,
    temporarilyBlockRegime: false,
    passiveOnly: false,
    executionAggressionLock: 'none',
    aggressionReasonCodes: [],
  });
  (job as any).executionCostCalibrator = {
    calibrate: () => ({
      feeCost: 0.002,
      slippageCost: 0.003,
      adverseSelectionCost: 0.001,
      expectedFillDelayMs: 2_000,
      cancelReplaceOverheadCost: 0.0001,
      missedOpportunityCost: 0.0002,
      expectedFillProbability: 0.8,
      confidence: 0.8,
      contextBucket: 'fixture',
      reasons: [],
      evidence: {},
    }),
  };
  (job as any).liveSizingFeedbackPolicy = {
    evaluate: () => ({
      sizeMultiplier: 1,
      aggressionCap: 'normal',
      thresholdAdjustment: 0,
      regimePermissionOverride: 'allow',
      reasonCodes: [],
      downshiftMultiplier: 1,
      upshiftEligibility: 'eligible',
      recoveryProbationState: 'none',
      sizingReasonCodes: [],
    }),
  };
  (job as any).adaptiveMakerTakerPolicy = {
    decide: () => ({
      policyVersionId: 'exec-pol-1',
      mode: 'maker_preferred',
      route: 'maker',
      executionStyle: 'rest',
      preferResting: true,
      rationale: ['fixture'],
    }),
  };
  (job as any).entryTimingEfficiencyScorer = {
    score: () => ({ label: 'efficient', sizeMultiplier: 1, blockTrade: false }),
  };
  (job as any).sizeVsLiquidityPolicy = {
    evaluate: () => ({
      allowedNotional: 20,
      allowedSizeUnits: 38,
      blockTrade: false,
      reasons: [],
    }),
  };
  (job as any).maxLossPerOpportunityPolicy = {
    evaluate: () => ({
      maxAllowedPositionSize: 20,
      blockTrade: false,
      reasons: [],
    }),
  };
  (job as any).orderPlanner = {
    plan: () => ({
      orderType: 'GTC',
      tokenId: 'yes1',
      outcome: 'YES',
      intent: 'ENTER',
      inventoryEffect: 'INCREASE',
      side: 'BUY',
      price: 0.52,
      size: 10,
      urgency: 'medium',
      expiration: null,
      executionStyle: 'rest',
      route: 'maker',
      timeDiscipline: 'open_ended',
      partialFillTolerance: 'allow_partial',
      policyReasonCode: 'fixture_policy',
      policyReasonMessage: 'fixture policy',
      allowedOrderTypes: ['GTC', 'GTD'],
      tickSize: 0.01,
      minOrderSize: 1,
      negRisk: false,
      expectedFillProbability: 0.74,
      expectedFillFraction: 0.81,
      expectedQueueDelayMs: 5_000,
      expectedRealizedCostBps: 33,
      expectedAdverseSelectionPenaltyBps: 11,
      recommendedOrderStyleRationale: [
        { code: 'fixture_policy', message: 'fixture policy' },
      ],
      executionBucketContext: buildFillRealismBucket({
        spreadBucket: 'normal',
        liquidityBucket: 'balanced',
        orderUrgency: 'medium',
        regime: 'balanced_rotation',
        executionStyle: 'maker',
        venueUncertaintyLabel: 'healthy',
      }),
      fillProbabilityEstimate: {
        fillProbability: 0.74,
        fillProbabilityByHorizon: {
          within1s: 0.2,
          within3s: 0.5,
          within5s: 0.74,
          within10s: 0.88,
        },
        expectedFillFraction: 0.81,
        expectedQueueDelayMs: 5_000,
        expectedQueueDelayProfile: {
          averageMs: 5_000,
          p50Ms: 4_200,
          p90Ms: 7_800,
        },
        confidence: 'medium',
        evidenceCount: 5,
        evidenceQuality: 'blended_empirical',
        empiricalSummary: null,
        capturedAt: new Date().toISOString(),
      },
      queueEstimate: {
        estimatedWaitScore: 0.8,
        queuePressure: 'medium',
        centralEstimateMs: 5_000,
        lowerBoundMs: 4_200,
        upperBoundMs: 7_800,
        evidenceCount: 5,
        confidence: 'medium',
        capturedAt: new Date().toISOString(),
      },
      slippageEstimate: {
        expectedSlippage: 0.006,
        severity: 'medium',
        geometryBasedComponent: 0.003,
        empiricalAdjustmentComponent: 0.003,
        finalExpectedSlippageBps: 22,
        evidenceStrength: 'medium',
        evidenceCount: 5,
        capturedAt: new Date().toISOString(),
      },
      postFillToxicitySummary: {
        bucket: buildFillRealismBucket({
          spreadBucket: 'normal',
          liquidityBucket: 'balanced',
          orderUrgency: 'medium',
          regime: 'balanced_rotation',
          executionStyle: 'maker',
          venueUncertaintyLabel: 'healthy',
        }),
        sampleCount: 2,
        averageDrift1sBps: 4,
        averageDrift3sBps: 7,
        averageDrift10sBps: 11,
        averageDrift30sBps: 16,
        expectedAdverseSelectionPenaltyBps: 16,
        confidence: 'medium',
        windowStart: '2026-03-27T10:00:00.000Z',
        windowEnd: '2026-03-27T10:05:00.000Z',
        capturedAt: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
    }),
  };
  (job as any).resolveVenueFeeSnapshot = async () => ({
    feeRateBps: 12,
    fetchedAt: new Date().toISOString(),
  });
  (job as any).venueFeeModel = {
    evaluate: () => ({
      tokenId: 'yes1',
      route: 'maker',
      feeRateBps: 12,
      expectedFee: 0.01,
      expectedFeePerUnit: 0.001,
      expectedRebateBps: 0,
      netFeeBps: 12,
      source: 'venue_live',
      fresh: true,
      conservative: true,
      reasonCode: 'fixture_fee',
      reasonMessage: 'fixture fee',
      fetchedAt: new Date().toISOString(),
    }),
  };

  try {
    const result = await job.run();
    const submittedAudit = auditEvents.find((event) => event.eventType === 'order.submitted');
    const metadata = submittedAudit?.metadata as Record<string, unknown> | undefined;
    const plannerAssumptions = metadata?.executionPlannerAssumptions as
      | Record<string, unknown>
      | undefined;

    assert.strictEqual(result.submitted, 1);
    assert.ok(submittedAudit);
    assert.ok(plannerAssumptions);
    assert.strictEqual(plannerAssumptions?.expectedFillProbability, 0.74);
    assert.strictEqual(plannerAssumptions?.expectedFillFraction, 0.81);
    assert.strictEqual(plannerAssumptions?.expectedQueueDelayMs, 5_000);
    assert.strictEqual(plannerAssumptions?.expectedAdverseSelectionPenaltyBps, 11);
    assert.strictEqual(
      (plannerAssumptions?.executionBucketContext as Record<string, unknown>)?.executionStyle,
      'maker',
    );
    assert.strictEqual(reconciliationCheckpoints.length > 0, true);
    assert.strictEqual(createdOrders.length, 1);
  } finally {
    (appEnv as { BOT_LIVE_EXECUTION_ENABLED: boolean }).BOT_LIVE_EXECUTION_ENABLED =
      originalLiveExecution;
  }
}

async function testReconcileFillsFeedsRealizedExecutionBackIntoStores(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-realism-reconcile-'));
  const ledger = new ResolvedTradeLedger(rootDir);
  const fillRealismStore = new FillRealismStore(path.join(rootDir, 'fill-store'));
  const postFillToxicityStore = new PostFillToxicityStore(path.join(rootDir, 'tox-store'));
  const auditEvents: Array<Record<string, unknown>> = [
    {
      signalId: 'signal-1',
      eventType: 'signal.admission_decision',
      metadata: {
        phaseTwoContext: {
          marketArchetype: 'balanced_rotation',
        },
      },
      createdAt: new Date('2026-03-27T09:59:00.000Z'),
    },
    {
      orderId: 'order-1',
      eventType: 'order.submitted',
      metadata: {
        executionPlannerAssumptions: {
          expectedFillProbability: 0.7,
          expectedFillFraction: 0.8,
          expectedQueueDelayMs: 6_000,
          expectedRealizedCostBps: 31,
          expectedAdverseSelectionPenaltyBps: 13,
          recommendedOrderStyleRationale: [{ code: 'fixture', message: 'fixture' }],
          executionBucketContext: buildFillRealismBucket({
            spreadBucket: 'normal',
            liquidityBucket: 'balanced',
            orderUrgency: 'medium',
            regime: 'balanced_rotation',
            executionStyle: 'maker',
            venueUncertaintyLabel: 'healthy',
          }),
        },
        toxicity: {
          toxicityScore: 0.15,
        },
      },
      createdAt: new Date('2026-03-27T10:00:00.000Z'),
    },
  ];
  const fills: Array<Record<string, unknown>> = [];

  const prisma = {
    fill: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        fills.find((fill) => fill.id === where.id) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        fills.push(data);
        return data;
      },
      findMany: async () => fills,
    },
    order: {
      findFirst: async () => ({
        id: 'order-1',
        venueOrderId: 'venue-order-1',
        marketId: 'market-1',
        tokenId: 'yes1',
        signalId: 'signal-1',
        strategyVersionId: 'sv-live-1',
        side: 'BUY',
        size: 10,
        price: 0.5,
        expectedEv: 0.08,
        filledSize: 0,
        remainingSize: 10,
        avgFillPrice: null,
        lastVenueStatus: null,
        lastVenueSyncAt: null,
        createdAt: new Date('2026-03-27T10:00:00.000Z'),
        postedAt: new Date('2026-03-27T10:00:00.000Z'),
        acknowledgedAt: null,
      }),
      update: async () => null,
    },
    signal: {
      findUnique: async () => ({
        id: 'signal-1',
        regime: 'balanced_rotation',
        observedAt: new Date('2026-03-27T09:59:30.000Z'),
        createdAt: new Date('2026-03-27T09:59:35.000Z'),
      }),
    },
    auditEvent: {
      findFirst: async ({
        where,
      }: {
        where: { signalId?: string; orderId?: string; eventType: string };
      }) =>
        auditEvents
          .filter((event) => {
            if (event.eventType !== where.eventType) {
              return false;
            }
            if (where.signalId && where.signalId !== event.signalId) {
              return false;
            }
            if (where.orderId && where.orderId !== event.orderId) {
              return false;
            }
            return true;
          })
          .at(-1) ?? null,
    },
    executionDiagnostic: {
      create: async () => null,
    },
    orderbook: {
      findMany: async () => [
        {
          observedAt: new Date('2026-03-27T10:00:21.000Z'),
          bestBid: 0.5,
          bestAsk: 0.52,
        },
        {
          observedAt: new Date('2026-03-27T10:00:31.000Z'),
          bestBid: 0.49,
          bestAsk: 0.51,
        },
        {
          observedAt: new Date('2026-03-27T10:00:50.000Z'),
          bestBid: 0.48,
          bestAsk: 0.5,
        },
      ],
    },
  };

  const runtimeControl = {
    recordReconciliationCheckpoint: async () => null,
  };

  const job = new ReconcileFillsJob(prisma as never, runtimeControl as never);
  (job as any).resolvedTradeLedger = ledger;
  (job as any).fillRealismStore = fillRealismStore;
  (job as any).postFillToxicityStore = postFillToxicityStore;
  (job as any).decisionLogService = { record: async () => null };
  (job as any).fetchVenueTrades = async () => ({
    ok: true,
    trades: [
      {
        id: 'venue-trade-1',
        orderId: 'order-1',
        price: 0.51,
        size: 10,
        fee: 0.01,
        filledAt: '2026-03-27T10:00:20.000Z',
      },
    ],
    error: null,
  });

  await job.run();

  const fillSummary = fillRealismStore.summarize({
    bucket: buildFillRealismBucket({
      spreadBucket: 'normal',
      liquidityBucket: 'balanced',
      orderUrgency: 'medium',
      regime: 'balanced_rotation',
      executionStyle: 'maker',
      venueUncertaintyLabel: 'healthy',
    }),
    limit: 10,
  });
  const toxicitySummary = postFillToxicityStore.summarize({
    bucket: buildFillRealismBucket({
      spreadBucket: 'normal',
      liquidityBucket: 'balanced',
      orderUrgency: 'medium',
      regime: 'balanced_rotation',
      executionStyle: 'maker',
      venueUncertaintyLabel: 'healthy',
    }),
    limit: 10,
  });

  assert.strictEqual((await ledger.findByOrderId('order-1')) != null, true);
  assert.strictEqual(fillSummary.sampleCount, 1);
  assert.strictEqual(fillSummary.fillProbabilityWithin10s, 0);
  assert.strictEqual(fillSummary.averageFillFraction, 1);
  assert.strictEqual(toxicitySummary.sampleCount, 1);
  assert.strictEqual(toxicitySummary.expectedAdverseSelectionPenaltyBps != null, true);
}

export const phaseThreeFillRealismTests = [
  {
    name: 'phase3 fill realism stores summarize empirical buckets',
    fn: testFillRealismStoresPersistAndSummarizeByBucket,
  },
  {
    name: 'phase3 order planner includes empirical realism outputs',
    fn: testOrderPlannerIncludesEmpiricalRealismFields,
  },
  {
    name: 'phase3 execute orders writes planner assumptions into submit metadata',
    fn: testExecuteOrdersWritesPlannerAssumptionsIntoMetadata,
  },
  {
    name: 'phase3 reconcile fills feeds realized execution back into realism stores',
    fn: testReconcileFillsFeedsRealizedExecutionBackIntoStores,
  },
];
