import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createDefaultExecutionLearningState,
  createDefaultLearningState,
  createDefaultStrategyDeploymentRegistryState,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { DailyReviewJob } from '../jobs/dailyReview.job';
import { LearningEventLog } from '../runtime/learning-event-log';
import { LearningStateStore } from '../runtime/learning-state-store';
import { RollbackController } from '../runtime/rollback-controller';
import { StrategyDeploymentRegistry } from '../runtime/strategy-deployment-registry';
import { StrategyRolloutController } from '../runtime/strategy-rollout-controller';

async function testChampionChallengerPromotionStartsBoundedCanary(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave5-champion-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const learningEventLog = new LearningEventLog(rootDir);
  const deploymentRegistry = new StrategyDeploymentRegistry(rootDir);
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
  assert.strictEqual(
    registryState.activeRollout?.stage === 'canary_5pct' ||
      registryState.activeRollout?.stage === 'canary_1pct',
    true,
  );
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
    name: 'wave5 champion challenger starts bounded canary rollout',
    fn: testChampionChallengerPromotionStartsBoundedCanary,
  },
  {
    name: 'wave5 rollback controller reverses unsafe challenger rollout',
    fn: testRollbackControllerReversesUnsafeChallenger,
  },
];
