import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createDefaultExecutionLearningState,
  createDefaultLearningState,
  createDefaultStrategyDeploymentRegistryState,
  type ResolvedTradeRecord,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { DailyReviewJob } from '../jobs/dailyReview.job';
import { LearningEventLog } from '../runtime/learning-event-log';
import { LearningStateStore } from '../runtime/learning-state-store';
import { ResolvedTradeLedger } from '../runtime/resolved-trade-ledger';
import { RollbackController } from '../runtime/rollback-controller';
import { StrategyDeploymentRegistry } from '../runtime/strategy-deployment-registry';
import { StrategyRolloutController } from '../runtime/strategy-rollout-controller';

async function testChampionChallengerPromotionRequiresLiveGateAndStartsPaperRollout(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave5-champion-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const learningEventLog = new LearningEventLog(rootDir);
  const deploymentRegistry = new StrategyDeploymentRegistry(rootDir);
  const resolvedTradeLedger = new ResolvedTradeLedger(rootDir);
  const state = createDefaultLearningState(new Date('2026-03-24T00:00:00.000Z'));

  state.strategyVariants['variant:strategy-live-1'] = {
    strategyVariantId: 'variant:strategy-live-1',
    health: 'healthy',
    lastLearningAt: '2026-03-24T00:00:00.000Z',
    regimeSnapshots: {
      incumbent: {
        key: 'incumbent',
        regime: 'trend_burst',
        liquidityBucket: 'balanced',
        spreadBucket: 'normal',
        timeToExpiryBucket: 'under_15m',
        entryTimingBucket: 'early',
        executionStyle: 'hybrid',
        side: 'buy',
        strategyVariantId: 'variant:strategy-live-1',
        sampleCount: 4,
        winRate: 0.5,
        expectedEvSum: 0.08,
        realizedEvSum: 0.08,
        avgExpectedEv: 0.01,
        avgRealizedEv: 0.01,
        realizedVsExpected: 1,
        avgFillRate: 0.9,
        avgSlippage: 0.002,
        health: 'healthy',
        lastObservedAt: '2026-03-24T00:00:00.000Z',
      },
      incumbent_follow_through: {
        key: 'incumbent_follow_through',
        regime: 'range_reversal',
        liquidityBucket: 'balanced',
        spreadBucket: 'normal',
        timeToExpiryBucket: 'under_15m',
        entryTimingBucket: 'early',
        executionStyle: 'hybrid',
        side: 'buy',
        strategyVariantId: 'variant:strategy-live-1',
        sampleCount: 4,
        winRate: 0.57,
        expectedEvSum: 0.06,
        realizedEvSum: 0.06,
        avgExpectedEv: 0.0086,
        avgRealizedEv: 0.0086,
        realizedVsExpected: 1,
        avgFillRate: 0.9,
        avgSlippage: 0.002,
        health: 'healthy',
        lastObservedAt: '2026-03-24T00:00:00.000Z',
      },
    },
    calibrationContexts: ['strategy:variant:strategy-live-1|regime:all'],
    executionLearning: {
      ...createDefaultExecutionLearningState(),
      updatedAt: '2026-03-24T00:00:00.000Z',
    },
    lastPromotionDecision: { decision: 'not_evaluated', reasons: [], evidence: {}, decidedAt: null },
    lastQuarantineDecision: { status: 'none', severity: 'none', reasons: [], scope: {}, decidedAt: null },
    lastCapitalAllocationDecision: { status: 'unchanged', targetMultiplier: 1, reasons: [], decidedAt: null },
  };
  state.strategyVariants['variant:strategy-challenger-2'] = {
    strategyVariantId: 'variant:strategy-challenger-2',
    health: 'healthy',
    lastLearningAt: '2026-03-24T00:00:00.000Z',
    regimeSnapshots: {
      challenger: {
        key: 'challenger',
        regime: 'trend_burst',
        liquidityBucket: 'balanced',
        spreadBucket: 'normal',
        timeToExpiryBucket: 'under_15m',
        entryTimingBucket: 'early',
        executionStyle: 'hybrid',
        side: 'buy',
        strategyVariantId: 'variant:strategy-challenger-2',
        sampleCount: 4,
        winRate: 0.75,
        expectedEvSum: 0.08,
        realizedEvSum: 0.1,
        avgExpectedEv: 0.01,
        avgRealizedEv: 0.0125,
        realizedVsExpected: 1.25,
        avgFillRate: 0.88,
        avgSlippage: 0.002,
        health: 'healthy',
        lastObservedAt: '2026-03-24T00:00:00.000Z',
      },
      challenger_follow_through: {
        key: 'challenger_follow_through',
        regime: 'range_reversal',
        liquidityBucket: 'balanced',
        spreadBucket: 'normal',
        timeToExpiryBucket: 'under_15m',
        entryTimingBucket: 'early',
        executionStyle: 'hybrid',
        side: 'buy',
        strategyVariantId: 'variant:strategy-challenger-2',
        sampleCount: 4,
        winRate: 0.71,
        expectedEvSum: 0.07,
        realizedEvSum: 0.08,
        avgExpectedEv: 0.01,
        avgRealizedEv: 0.0114,
        realizedVsExpected: 1.14,
        avgFillRate: 0.89,
        avgSlippage: 0.002,
        health: 'healthy',
        lastObservedAt: '2026-03-24T00:00:00.000Z',
      },
    },
    calibrationContexts: ['strategy:variant:strategy-challenger-2|regime:all'],
    executionLearning: {
      ...createDefaultExecutionLearningState(),
      updatedAt: '2026-03-24T00:00:00.000Z',
    },
    lastPromotionDecision: { decision: 'not_evaluated', reasons: [], evidence: {}, decidedAt: null },
    lastQuarantineDecision: { status: 'none', severity: 'none', reasons: [], scope: {}, decidedAt: null },
    lastCapitalAllocationDecision: { status: 'unchanged', targetMultiplier: 1, reasons: [], decidedAt: null },
  };
  state.calibration['strategy:variant:strategy-challenger-2|regime:all'] = {
    contextKey: 'strategy:variant:strategy-challenger-2|regime:all',
    strategyVariantId: 'variant:strategy-challenger-2',
    regime: null,
    sampleCount: 8,
    brierScore: 0.1,
    logLoss: 0.3,
    shrinkageFactor: 1,
    overconfidenceScore: 0.02,
    health: 'healthy',
    version: 1,
    driftSignals: ['calibration_stable'],
    lastUpdatedAt: '2026-03-24T00:00:00.000Z',
  };
  await learningStateStore.save(state);
  for (const record of buildResolvedTrades({
    count: 10,
    strategyVariantId: 'variant:strategy-challenger-2',
    strategyVersion: 'strategy-challenger-2',
    regime: 'trend_burst',
    realizedNetEdgeBps: 84,
    expectedNetEdgeBps: 68,
    benchmarkState: 'outperforming',
    lifecycleState: 'economically_resolved_with_portfolio_truth',
  })) {
    await resolvedTradeLedger.append(record);
  }
  for (const record of buildResolvedTrades({
    count: 10,
    strategyVariantId: 'variant:strategy-live-1',
    strategyVersion: 'strategy-live-1',
    regime: 'trend_burst',
    realizedNetEdgeBps: 58,
    expectedNetEdgeBps: 54,
    benchmarkState: 'outperforming',
    lifecycleState: 'economically_resolved_with_portfolio_truth',
  })) {
    await resolvedTradeLedger.append(record);
  }

  const prisma = {
    strategyVersion: {
      findMany: async () => [
        {
          id: 'strategy-live-1',
          name: 'live',
          isActive: true,
          createdAt: new Date('2026-03-20T00:00:00.000Z'),
          updatedAt: new Date('2026-03-24T00:00:00.000Z'),
        },
        {
          id: 'strategy-challenger-2',
          name: 'challenger',
          isActive: false,
          createdAt: new Date('2026-03-21T00:00:00.000Z'),
          updatedAt: new Date('2026-03-24T00:05:00.000Z'),
        },
      ],
    },
    executionDiagnostic: {
      findMany: async () => [],
    },
    order: {
      findMany: async () => [],
    },
    orderbook: {
      findFirst: async () => null,
    },
    fill: {
      findMany: async () => [],
    },
    auditEvent: {
      findMany: async () => [],
    },
  };

  const job = new DailyReviewJob(
    prisma as never,
    learningStateStore,
    learningEventLog,
    deploymentRegistry,
    undefined,
    undefined,
    resolvedTradeLedger,
  );
  await job.run({
    force: true,
    now: new Date('2026-03-24T00:10:00.000Z'),
  });

  const registryState = await deploymentRegistry.load();
  assert.strictEqual(registryState.incumbentVariantId, 'variant:strategy-live-1');
  assert.strictEqual(
    registryState.activeRollout?.challengerVariantId,
    'variant:strategy-challenger-2',
  );
  assert.strictEqual(registryState.activeRollout?.stage, 'paper');
  assert.strictEqual(
    (registryState.variants['variant:strategy-challenger-2']?.liveTrustScore ?? 0) > 0,
    true,
  );
  const reviewedState = await learningStateStore.load();
  const evidence =
    reviewedState.strategyVariants['variant:strategy-challenger-2']?.lastPromotionDecision
      .evidence ?? null;
  assert.ok(evidence);
  assert.strictEqual(
    ((evidence as { liveEvidencePacket?: { tradeCount?: number } }).liveEvidencePacket?.tradeCount ??
      0) >= 8,
    true,
  );
}

async function testChampionChallengerFlowBlocksPromotionWithoutLiveTruth(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase6-live-gate-block-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const learningEventLog = new LearningEventLog(rootDir);
  const deploymentRegistry = new StrategyDeploymentRegistry(rootDir);
  const resolvedTradeLedger = new ResolvedTradeLedger(rootDir);
  const state = createDefaultLearningState(new Date('2026-03-24T00:00:00.000Z'));

  state.strategyVariants['variant:strategy-live-1'] = {
    strategyVariantId: 'variant:strategy-live-1',
    health: 'healthy',
    lastLearningAt: '2026-03-24T00:00:00.000Z',
    regimeSnapshots: {},
    calibrationContexts: ['strategy:variant:strategy-live-1|regime:all'],
    executionLearning: {
      ...createDefaultExecutionLearningState(),
      updatedAt: '2026-03-24T00:00:00.000Z',
    },
    lastPromotionDecision: { decision: 'not_evaluated', reasons: [], evidence: {}, decidedAt: null },
    lastQuarantineDecision: { status: 'none', severity: 'none', reasons: [], scope: {}, decidedAt: null },
    lastCapitalAllocationDecision: { status: 'unchanged', targetMultiplier: 1, reasons: [], decidedAt: null },
  };
  state.strategyVariants['variant:strategy-challenger-2'] = {
    strategyVariantId: 'variant:strategy-challenger-2',
    health: 'healthy',
    lastLearningAt: '2026-03-24T00:00:00.000Z',
    regimeSnapshots: {},
    calibrationContexts: ['strategy:variant:strategy-challenger-2|regime:all'],
    executionLearning: {
      ...createDefaultExecutionLearningState(),
      updatedAt: '2026-03-24T00:00:00.000Z',
    },
    lastPromotionDecision: { decision: 'not_evaluated', reasons: [], evidence: {}, decidedAt: null },
    lastQuarantineDecision: { status: 'none', severity: 'none', reasons: [], scope: {}, decidedAt: null },
    lastCapitalAllocationDecision: { status: 'unchanged', targetMultiplier: 1, reasons: [], decidedAt: null },
  };
  await learningStateStore.save(state);

  const prisma = {
    strategyVersion: {
      findMany: async () => [
        {
          id: 'strategy-live-1',
          name: 'live',
          isActive: true,
          createdAt: new Date('2026-03-20T00:00:00.000Z'),
          updatedAt: new Date('2026-03-24T00:00:00.000Z'),
        },
        {
          id: 'strategy-challenger-2',
          name: 'challenger',
          isActive: false,
          createdAt: new Date('2026-03-21T00:00:00.000Z'),
          updatedAt: new Date('2026-03-24T00:05:00.000Z'),
        },
      ],
    },
    executionDiagnostic: { findMany: async () => [] },
    order: { findMany: async () => [] },
    orderbook: { findFirst: async () => null },
    fill: { findMany: async () => [] },
    auditEvent: { findMany: async () => [] },
  };

  const job = new DailyReviewJob(
    prisma as never,
    learningStateStore,
    learningEventLog,
    deploymentRegistry,
    undefined,
    undefined,
    resolvedTradeLedger,
  );
  await job.run({
    force: true,
    now: new Date('2026-03-24T00:10:00.000Z'),
  });

  const registryState = await deploymentRegistry.load();
  assert.strictEqual(registryState.activeRollout, null);
  const reviewedState = await learningStateStore.load();
  const reasons =
    reviewedState.strategyVariants['variant:strategy-challenger-2']?.lastPromotionDecision
      .reasons ?? [];
  assert.strictEqual(reasons.includes('minimum_live_trade_count_not_met'), true);
}

async function testRollbackControllerReversesUnsafeChallenger(): Promise<void> {
  const now = new Date('2026-03-26T00:00:00.000Z');
  const registry = createDefaultStrategyDeploymentRegistryState(now);
  registry.incumbentVariantId = 'variant:strategy-live-1';
  registry.variants['variant:strategy-live-1'] = {
    variantId: 'variant:strategy-live-1',
    strategyVersionId: 'strategy-live-1',
    status: 'incumbent',
    evaluationMode: 'full',
    rolloutStage: 'full',
    health: 'healthy',
    lineage: {
      variantId: 'variant:strategy-live-1',
      strategyVersionId: 'strategy-live-1',
      parentVariantId: null,
      createdAt: now.toISOString(),
      createdReason: 'test',
    },
    capitalAllocationPct: 1,
    lastShadowEvaluatedAt: now.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  registry.variants['variant:strategy-challenger-2'] = {
    variantId: 'variant:strategy-challenger-2',
    strategyVersionId: 'strategy-challenger-2',
    status: 'canary',
    evaluationMode: 'canary',
    rolloutStage: 'canary_5pct',
    health: 'degraded',
    lineage: {
      variantId: 'variant:strategy-challenger-2',
      strategyVersionId: 'strategy-challenger-2',
      parentVariantId: 'variant:strategy-live-1',
      createdAt: now.toISOString(),
      createdReason: 'test',
    },
    capitalAllocationPct: 0.05,
    lastShadowEvaluatedAt: now.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  registry.activeRollout = {
    incumbentVariantId: 'variant:strategy-live-1',
    challengerVariantId: 'variant:strategy-challenger-2',
    stage: 'canary_5pct',
    challengerAllocationPct: 0.05,
    rolloutSalt: 'salt',
    appliedReason: 'test',
    appliedAt: now.toISOString(),
  };

  const learningState = createDefaultLearningState(now);
  learningState.strategyVariants['variant:strategy-challenger-2'] = {
    strategyVariantId: 'variant:strategy-challenger-2',
    health: 'quarantine_candidate',
    lastLearningAt: now.toISOString(),
    regimeSnapshots: {
      challenger: {
        key: 'challenger',
        regime: 'trend_burst',
        liquidityBucket: 'balanced',
        spreadBucket: 'normal',
        timeToExpiryBucket: 'under_15m',
        entryTimingBucket: 'early',
        executionStyle: 'maker',
        side: 'buy',
        strategyVariantId: 'variant:strategy-challenger-2',
        sampleCount: 10,
        winRate: 0.2,
        expectedEvSum: 0.1,
        realizedEvSum: -0.08,
        avgExpectedEv: 0.01,
        avgRealizedEv: -0.008,
        realizedVsExpected: -0.8,
        avgFillRate: 0.5,
        avgSlippage: 0.01,
        health: 'quarantine_candidate',
        lastObservedAt: now.toISOString(),
      },
    },
    calibrationContexts: [],
    executionLearning: createDefaultExecutionLearningState(),
    lastPromotionDecision: { decision: 'canary', reasons: [], evidence: {}, decidedAt: now.toISOString() },
    lastQuarantineDecision: { status: 'quarantined', severity: 'high', reasons: [], scope: { strategyVariantId: 'variant:strategy-challenger-2' }, decidedAt: now.toISOString() },
    lastCapitalAllocationDecision: { status: 'hold', targetMultiplier: 1, reasons: [], decidedAt: now.toISOString() },
  };
  registry.quarantines['q1'] = {
    quarantineId: 'q1',
    scope: {
      variantId: 'variant:strategy-challenger-2',
      regime: 'trend_burst',
      marketContext: 'execution',
    },
    severity: 'high',
    reasonCode: 'execution_deterioration',
    details: {},
    createdAt: now.toISOString(),
  };

  const rollback = new RollbackController().evaluate({
    registry,
    learningState,
    now,
  });
  assert.ok(rollback);

  const updated = new StrategyRolloutController().applyRollback({
    registry,
    rollback: rollback!,
    cycleId: 'cycle-rollback',
    now,
  });

  assert.strictEqual(updated.registry.activeRollout, null);
  assert.strictEqual(updated.registry.incumbentVariantId, 'variant:strategy-live-1');
  assert.strictEqual(updated.registry.variants['variant:strategy-challenger-2']?.status, 'shadow');
}

export const waveFiveChampionChallengerIntegrationTests = [
  {
    name: 'phase6 champion challenger promotion requires live gate and starts paper rollout',
    fn: testChampionChallengerPromotionRequiresLiveGateAndStartsPaperRollout,
  },
  {
    name: 'phase6 champion challenger flow blocks promotion without live truth',
    fn: testChampionChallengerFlowBlocksPromotionWithoutLiveTruth,
  },
  {
    name: 'wave5 rollback controller reverses unsafe challenger rollout',
    fn: testRollbackControllerReversesUnsafeChallenger,
  },
];

function buildResolvedTrades(input: {
  count: number;
  strategyVariantId: string;
  strategyVersion: string;
  regime: string;
  realizedNetEdgeBps: number;
  expectedNetEdgeBps: number;
  benchmarkState: 'outperforming' | 'neutral' | 'underperforming' | 'context_missing';
  lifecycleState:
    | 'economically_resolved'
    | 'economically_resolved_with_portfolio_truth';
}): ResolvedTradeRecord[] {
  return Array.from({ length: input.count }, (_, index) => ({
    tradeId: `${input.strategyVariantId}:trade:${index + 1}`,
    orderId: `${input.strategyVariantId}:order:${index + 1}`,
    venueOrderId: `${input.strategyVariantId}:venue:${index + 1}`,
    marketId: 'market-btc',
    tokenId: 'token-up',
    strategyVariantId: input.strategyVariantId,
    strategyVersion: input.strategyVersion,
    regime: input.regime,
    archetype: 'trend_follow_through',
    decisionTimestamp: new Date(Date.UTC(2026, 2, 20, 0, index)).toISOString(),
    submissionTimestamp: new Date(Date.UTC(2026, 2, 20, 0, index, 1)).toISOString(),
    firstFillTimestamp: new Date(Date.UTC(2026, 2, 20, 0, index, 2)).toISOString(),
    finalizedTimestamp: new Date(Date.UTC(2026, 2, 20, 0, index, 10)).toISOString(),
    side: 'BUY',
    intendedPrice: 0.51,
    averageFillPrice: 0.512,
    size: 20,
    notional: 10.24,
    estimatedFeeAtDecision: 0.05,
    realizedFee: 0.051,
    estimatedSlippageBps: 14,
    realizedSlippageBps: 16,
    queueDelayMs: 4_000,
    fillFraction: 1,
    expectedNetEdgeBps: input.expectedNetEdgeBps,
    realizedNetEdgeBps: input.realizedNetEdgeBps - index,
    maxFavorableExcursionBps: 105,
    maxAdverseExcursionBps: -22,
    toxicityScoreAtDecision: 0.14,
    benchmarkContext: {
      benchmarkComparisonState: input.benchmarkState,
      baselinePenaltyMultiplier: input.benchmarkState === 'outperforming' ? 1 : 0.8,
      regimeBenchmarkGateState: input.benchmarkState === 'outperforming' ? 'passed' : 'blocked',
      underperformedBenchmarkIds:
        input.benchmarkState === 'underperforming' ? ['btc_follow_baseline'] : [],
      outperformedBenchmarkIds:
        input.benchmarkState === 'outperforming' ? ['btc_follow_baseline'] : [],
      reasonCodes: ['fixture'],
    },
    lossAttributionCategory: 'mixed',
    executionAttributionCategory: 'queue_decay',
    lifecycleState: input.lifecycleState,
    attribution: {
      benchmarkContext: {
        benchmarkComparisonState: input.benchmarkState,
        baselinePenaltyMultiplier: input.benchmarkState === 'outperforming' ? 1 : 0.8,
        regimeBenchmarkGateState: input.benchmarkState === 'outperforming' ? 'passed' : 'blocked',
        underperformedBenchmarkIds:
          input.benchmarkState === 'underperforming' ? ['btc_follow_baseline'] : [],
        outperformedBenchmarkIds:
          input.benchmarkState === 'outperforming' ? ['btc_follow_baseline'] : [],
        reasonCodes: ['fixture'],
      },
      lossAttributionCategory: 'mixed',
      executionAttributionCategory: 'queue_decay',
      primaryLeakageDriver: 'queue_delay',
      secondaryLeakageDrivers: ['slippage'],
      reasonCodes: ['fixture'],
    },
    executionQuality: {
      intendedPrice: 0.51,
      averageFillPrice: 0.512,
      size: 20,
      notional: 10.24,
      estimatedFeeAtDecision: 0.05,
      realizedFee: 0.051,
      estimatedSlippageBps: 14,
      realizedSlippageBps: 16,
      queueDelayMs: 4_000,
      fillFraction: 1,
    },
    netOutcome: {
      expectedNetEdgeBps: input.expectedNetEdgeBps,
      realizedNetEdgeBps: input.realizedNetEdgeBps - index,
      maxFavorableExcursionBps: 105,
      maxAdverseExcursionBps: -22,
      realizedPnl: 0.9,
    },
    capturedAt: new Date(Date.UTC(2026, 2, 20, 0, index, 10)).toISOString(),
  }));
}
