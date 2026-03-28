import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ExecuteOrdersJob } from '../jobs/executeOrders.job';
import { LearningStateStore } from '../runtime/learning-state-store';
import { SentinelStateStore } from '../runtime/sentinel-state-store';

async function testSentinelModeSimulatesTradeWithoutLiveSubmit(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-sim-execution-'));
  const learningStateStore = new LearningStateStore(path.join(rootDir, 'learning'));
  const sentinelStateStore = new SentinelStateStore(path.join(rootDir, 'learning/sentinel'));
  const now = new Date();
  let signalStatus = 'approved';
  let liveSubmitCalls = 0;
  let orderCreates = 0;
  const auditEvents: string[] = [];
  const rejectReasons: string[] = [];

  const prisma = {
    signal: {
      findMany: async () => [
        {
          id: 'signal-1',
          marketId: 'market-1',
          strategyVersionId: 'strategy-1',
          observedAt: now,
          side: 'BUY',
          expectedEv: 0.03,
          edge: 0.02,
          posteriorProbability: 0.66,
          marketImpliedProb: 0.52,
          regime: 'balanced_rotation',
          status: signalStatus,
        },
      ].filter((signal) => signal.status === 'approved'),
      update: async ({ data }: { data: { status: string } }) => {
        signalStatus = data.status;
        return null;
      },
    },
    signalDecision: {
      findFirst: async () => ({
        id: 'decision-1',
        signalId: 'signal-1',
        verdict: 'approved',
        positionSize: 10,
      }),
      create: async ({ data }: { data: { reasonCode?: string } }) => {
        if (typeof data.reasonCode === 'string') {
          rejectReasons.push(data.reasonCode);
        }
        return null;
      },
    },
    market: {
      findUnique: async () => ({
        id: 'market-1',
        tokenIdYes: 'token-yes-1',
        tokenIdNo: 'token-no-1',
        status: 'active',
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      }),
    },
    marketSnapshot: {
      findFirst: async () => ({
        observedAt: now,
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
        volume: 250,
      }),
    },
    orderbook: {
      findFirst: async () => ({
        observedAt: now,
        tickSize: 0.01,
        minOrderSize: 1,
        negRisk: false,
        bestBid: 0.49,
        bestAsk: 0.51,
        spread: 0.02,
        askLevels: [{ price: 0.51, size: 20 }],
        bidLevels: [{ price: 0.49, size: 18 }],
      }),
    },
    order: {
      findFirst: async () => null,
      create: async () => {
        orderCreates += 1;
        return null;
      },
    },
    auditEvent: {
      findMany: async () => [],
      create: async ({ data }: { data: { eventType: string } }) => {
        auditEvents.push(data.eventType);
        return data;
      },
    },
    liveConfig: {
      findUnique: async () => ({ id: 'live', noTradeWindowSeconds: 30 }),
    },
  };

  const runtimeControl = {
    getLatestSafetyState: async () => ({
      state: 'running',
      reasonCodes: [],
      sizeMultiplier: 1,
      evaluationCadenceMultiplier: 1,
      allowAggressiveEntries: true,
      allowNewEntries: true,
      haltRequested: false,
      maxNewSignalsPerTick: 10,
    }),
  };

  const venueHealthLearningStore = {
    getCurrentMetrics: async () => ({}),
    setOperationalAssessment: async () => undefined,
    recordStaleDataInterval: async () => undefined,
    recordRequest: async () => undefined,
  };

  const job = new ExecuteOrdersJob(
    prisma as never,
    runtimeControl as never,
    learningStateStore,
    undefined,
    venueHealthLearningStore as never,
    sentinelStateStore,
  );
  (job as any).assessExecutionReadiness = async () => ({
    ready: true,
    reasonCode: null,
  });
  (job as any).versionLineageRegistry = {
    getLatestForSignalDecision: async () => null,
    recordDecision: async () => undefined,
  };
  (job as any).resolveExecutionIntent = () => ({
    tokenId: 'token-yes-1',
    outcome: 'YES',
    venueSide: 'BUY',
    action: 'ENTER',
    inventoryEffect: 'increase',
  });
  (job as any).buildExecutionToxicity = () => ({
    toxicityState: 'normal',
    passiveOnly: false,
    temporarilyBlockRegime: false,
    aggressionReasonCodes: [],
    sizeMultiplier: 1,
    executionAggressionLock: 'none',
  });
  (job as any).venueUncertaintyDetector = {
    evaluate: () => ({
      label: 'healthy',
      reasonCodes: [],
    }),
  };
  (job as any).venueModePolicy = {
    decide: () => ({
      mode: 'normal',
      allowOrderSubmit: true,
      blockNewEntries: false,
      sizeMultiplier: 1,
    }),
  };
  (job as any).signerHealth = {
    check: () => ({
      checks: {
        privateKey: false,
        apiKey: false,
        apiSecret: false,
        apiPassphrase: false,
      },
    }),
  };
  (job as any).liveTradeGuard = {
    evaluate: () => ({
      passed: true,
      reasonCode: null,
    }),
  };
  (job as any).marketEligibility = {
    evaluate: () => ({ eligible: true }),
  };
  (job as any).negativeRiskPolicy = {
    evaluate: () => ({ allowed: true }),
  };
  (job as any).executionCostCalibrator = {
    calibrate: () => ({
      feeCost: 0.0005,
      slippageCost: 0.0005,
      adverseSelectionCost: 0.0001,
      expectedFillDelayMs: 500,
      cancelReplaceOverheadCost: 0,
      missedOpportunityCost: 0,
    }),
  };
  (job as any).liveSizingFeedbackPolicy = {
    evaluate: () => ({
      sizeMultiplier: 1,
      thresholdAdjustment: 0,
      aggressionCap: 'normal',
      regimePermissionOverride: 'allow',
      recoveryProbationState: 'none',
      upshiftEligibility: 'eligible',
      sizingReasonCodes: [],
    }),
  };
  (job as any).adaptiveMakerTakerPolicy = {
    decide: () => ({
      policyVersionId: null,
      mode: 'balanced',
      route: 'maker',
      executionStyle: 'rest',
      preferResting: true,
      rationale: ['sentinel_test'],
    }),
  };
  (job as any).entryTimingEfficiencyScorer = {
    score: () => ({
      sizeMultiplier: 1,
      blockTrade: false,
      label: 'early',
    }),
  };
  (job as any).marketableLimit = {
    calculate: () => ({
      price: 0.5,
    }),
  };
  (job as any).sizeVsLiquidityPolicy = {
    evaluate: () => ({
      allowedNotional: 10,
      allowedSizeUnits: 20,
      blockTrade: false,
    }),
  };
  (job as any).maxLossPerOpportunityPolicy = {
    evaluate: () => ({
      maxAllowedPositionSize: 10,
      blockTrade: false,
    }),
  };
  (job as any).slippageEstimator = {
    estimate: () => ({
      expectedSlippage: 0.0004,
      severity: 'low',
    }),
  };
  (job as any).realizedCostModel = {
    evaluate: () => ({
      breakdown: {
        totalCost: 0.001,
      },
    }),
  };
  (job as any).orderPlanner = {
    plan: () => ({
      tokenId: 'token-yes-1',
      side: 'BUY',
      price: 0.5,
      size: 10,
      orderType: 'GTC',
      route: 'maker',
      executionStyle: 'rest',
      timeDiscipline: 'rest_until_edge_fades',
      partialFillTolerance: 'allow_partial',
      expiration: new Date('2026-03-27T00:10:00.000Z').toISOString(),
      expectedFillProbability: 0.84,
      expectedFillFraction: 0.95,
      expectedQueueDelayMs: 400,
      expectedRealizedCostBps: 24,
      expectedAdverseSelectionPenaltyBps: 3,
      recommendedOrderStyleRationale: ['rest_for_queue_priority'],
      executionBucketContext: {},
      allowedOrderTypes: ['GTC'],
      policyReasonCode: 'ok',
      policyReasonMessage: 'ok',
    }),
  };
  (job as any).venueOrderValidator = {
    validate: () => ({ valid: true }),
  };
  (job as any).venueFeeModel = {
    evaluate: () => ({
      netFeeBps: 20,
      expectedFee: 0.001,
      expectedFeePerUnit: 0.001,
    }),
  };
  (job as any).makerQualityPolicy = {
    evaluate: () => ({ quality: 'good' }),
  };
  (job as any).resolveVenueFeeSnapshot = async () => ({
    feeRateBps: 20,
    fetchedAt: new Date().toISOString(),
  });
  (job as any).resolveVenueRewardsMarkets = async () => [];
  (job as any).tradingClient = {
    postOrder: async () => {
      liveSubmitCalls += 1;
      throw new Error('live submit should not be called in sentinel mode');
    },
  };

  const result = await job.run({
    canSubmit: () => true,
    runtimeState: 'running',
    operatingMode: 'sentinel_simulation',
  });

  assert.strictEqual(
    result.submitted,
    1,
    JSON.stringify({ result, signalStatus, rejectReasons, auditEvents }),
  );
  assert.strictEqual(liveSubmitCalls, 0);
  assert.strictEqual(orderCreates, 0);
  assert.strictEqual(signalStatus, 'sentinel_simulated');
  assert.strictEqual(fs.existsSync(sentinelStateStore.getPaths().baselinePath), true);
  assert.strictEqual(await sentinelStateStore.countCompletedTrades(), 1);
  assert.strictEqual(auditEvents.includes('sentinel.trade_simulated'), true);
}

async function testSentinelTradeCountersRemainAccurate(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-sim-counters-'));
  const sentinelStateStore = new SentinelStateStore(rootDir);
  await sentinelStateStore.ensureBaselineKnowledge('sentinel_simulation');

  await sentinelStateStore.appendSimulatedTrade(buildTradeRecord('trade-1'));
  await sentinelStateStore.appendSimulatedTrade(buildTradeRecord('trade-2'));
  await sentinelStateStore.appendLearningUpdate(buildLearningUpdate('trade-1'));
  await sentinelStateStore.appendLearningUpdate(buildLearningUpdate('trade-1'));

  assert.strictEqual(await sentinelStateStore.countCompletedTrades(), 2);
  assert.strictEqual(await sentinelStateStore.countLearnedTrades(), 1);
}

function buildTradeRecord(simulationTradeId: string) {
  return {
    simulationTradeId,
    signalId: simulationTradeId,
    marketId: 'market-1',
    tokenId: 'token-1',
    strategyVersionId: 'strategy-1',
    strategyVariantId: 'variant:strategy-1',
    regime: 'balanced_rotation',
    simulatedAt: '2026-03-27T00:00:00.000Z',
    side: 'BUY' as const,
    operatingMode: 'sentinel_simulation' as const,
    expectedFillProbability: 0.8,
    realizedFillProbability: 0.82,
    expectedFillFraction: 0.95,
    realizedFillFraction: 0.94,
    expectedQueueDelayMs: 400,
    realizedQueueDelayMs: 420,
    expectedFeeBps: 20,
    realizedFeeBps: 20,
    expectedSlippageBps: 4,
    realizedSlippageBps: 5,
    expectedNetEdgeAfterCostsBps: 18,
    realizedNetEdgeAfterCostsBps: 15,
    expectedVsRealizedEdgeGapBps: 3,
    fillQualityPassed: true,
    noTradeDisciplinePassed: true,
    unresolvedAnomalyCount: 0,
    rationale: [],
    evidenceRefs: [],
  };
}

function buildLearningUpdate(simulationTradeId: string) {
  return {
    learningUpdateId: `update:${simulationTradeId}`,
    simulationTradeId,
    learnedAt: '2026-03-27T00:05:00.000Z',
    parameterChanges: [],
    evidenceRefs: [],
    reason: 'test',
    rollbackCriteria: [],
  };
}

export const sentinelSimulationIntegrationTests = [
  {
    name: 'sentinel mode simulates a trade without live submit',
    fn: testSentinelModeSimulatesTradeWithoutLiveSubmit,
  },
  {
    name: 'sentinel counters stay accurate across trades and learning updates',
    fn: testSentinelTradeCountersRemainAccurate,
  },
];
