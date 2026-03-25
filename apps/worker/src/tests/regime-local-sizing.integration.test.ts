import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  RegimeLocalSizing,
  buildRegimeLocalSizingSummary,
  type RegimeLocalSizingSummary,
} from '@polymarket-btc-5m-agentic-bot/risk-engine';
import {
  buildStrategyVariantId,
  createDefaultLearningState,
  createDefaultStrategyVariantState,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { DailyReviewJob } from '../jobs/dailyReview.job';
import { EvaluateTradeOpportunitiesJob } from '../jobs/evaluateTradeOpportunities.job';
import { LearningEventLog } from '../runtime/learning-event-log';
import { LearningStateStore } from '../runtime/learning-state-store';
import { StrategyDeploymentRegistry } from '../runtime/strategy-deployment-registry';
import { VersionLineageRegistry } from '../runtime/version-lineage-registry';
import { TradeQualityHistoryStore } from '@polymarket-btc-5m-agentic-bot/risk-engine';

async function testRegimeLocalSizingReducesWeakRegimeAndArchetype(): Promise<void> {
  const decision = new RegimeLocalSizing().evaluate({
    regime: 'near_resolution_microstructure_chaos',
    archetype: 'stressed_microstructure',
    regimeSnapshotHealth: 'degraded',
    regimeSnapshotSampleCount: 12,
    regimeSnapshotRealizedVsExpected: 0.62,
    retentionByRegime: [
      {
        contextType: 'regime',
        contextValue: 'near_resolution_microstructure_chaos',
        sampleCount: 9,
        retentionRatio: 0.48,
        realizedVsExpectedGap: -0.05,
        rankScore: -0.08,
      },
    ],
    retentionByArchetype: [
      {
        contextType: 'archetype',
        contextValue: 'stressed_microstructure',
        sampleCount: 10,
        retentionRatio: 0.58,
        realizedVsExpectedGap: -0.03,
        rankScore: -0.06,
      },
    ],
  });

  assert.strictEqual(decision.regimeSizeMultiplier < 1, true);
  assert.strictEqual(decision.archetypeSizeMultiplier < 1, true);
  assert.strictEqual(decision.combinedSizeMultiplier < decision.regimeSizeMultiplier, true);
  assert.strictEqual(
    decision.regimeSizingReasonCodes.includes('regime_local_retention_critical'),
    true,
  );
  assert.strictEqual(
    decision.regimeSizingReasonCodes.includes('archetype_local_retention_hard'),
    true,
  );
}

async function testRegimeLocalSizingSummaryRanksConstrainedContexts(): Promise<void> {
  const summary = buildRegimeLocalSizingSummary({
    now: new Date('2026-03-25T00:00:00.000Z'),
    retentionByRegime: [
      {
        contextType: 'regime',
        contextValue: 'trend_burst',
        sampleCount: 12,
        retentionRatio: 0.96,
        realizedVsExpectedGap: 0.002,
        rankScore: 0.01,
      },
      {
        contextType: 'regime',
        contextValue: 'near_resolution_microstructure_chaos',
        sampleCount: 8,
        retentionRatio: 0.42,
        realizedVsExpectedGap: -0.05,
        rankScore: -0.08,
      },
    ],
    retentionByArchetype: [
      {
        contextType: 'archetype',
        contextValue: 'trend_follow_through',
        sampleCount: 11,
        retentionRatio: 0.94,
        realizedVsExpectedGap: 0.003,
        rankScore: 0.01,
      },
      {
        contextType: 'archetype',
        contextValue: 'stressed_microstructure',
        sampleCount: 7,
        retentionRatio: 0.53,
        realizedVsExpectedGap: -0.04,
        rankScore: -0.07,
      },
    ],
  });

  assert.strictEqual(summary.byRegime.length, 2);
  assert.strictEqual(summary.byArchetype.length, 2);
  assert.strictEqual(summary.mostConstrainedContexts.length > 0, true);
  assert.strictEqual(
    summary.mostConstrainedContexts[0]?.contextValue ===
      'near_resolution_microstructure_chaos' ||
      summary.mostConstrainedContexts[0]?.contextValue === 'stressed_microstructure',
    true,
  );
}

async function testEvaluateTradeOpportunitiesAppliesRegimeLocalSizing(): Promise<void> {
  const strong = await runEvaluationScenario({
    regime: 'trend_burst',
    marketArchetype: 'trend_follow_through',
    reviewSummary: {
      generatedAt: '2026-03-25T00:00:00.000Z',
      sampleCount: 2,
      byRegime: [
        {
          contextType: 'regime',
          contextValue: 'trend_burst',
          sampleCount: 12,
          retentionRatio: 0.96,
          realizedVsExpectedGap: 0.002,
          recommendedSizeMultiplier: 1,
          reasonCodes: [],
        },
      ],
      byArchetype: [
        {
          contextType: 'archetype',
          contextValue: 'trend_follow_through',
          sampleCount: 12,
          retentionRatio: 0.95,
          realizedVsExpectedGap: 0.002,
          recommendedSizeMultiplier: 1,
          reasonCodes: [],
        },
      ],
      mostConstrainedContexts: [],
    },
  });
  const weak = await runEvaluationScenario({
    regime: 'near_resolution_microstructure_chaos',
    marketArchetype: 'stressed_microstructure',
    reviewSummary: {
      generatedAt: '2026-03-25T00:00:00.000Z',
      sampleCount: 2,
      byRegime: [
        {
          contextType: 'regime',
          contextValue: 'near_resolution_microstructure_chaos',
          sampleCount: 8,
          retentionRatio: 0.45,
          realizedVsExpectedGap: -0.05,
          recommendedSizeMultiplier: 0.5,
          reasonCodes: ['regime_local_retention_critical'],
        },
      ],
      byArchetype: [
        {
          contextType: 'archetype',
          contextValue: 'stressed_microstructure',
          sampleCount: 7,
          retentionRatio: 0.55,
          realizedVsExpectedGap: -0.04,
          recommendedSizeMultiplier: 0.72,
          reasonCodes: ['archetype_local_retention_hard'],
        },
      ],
      mostConstrainedContexts: [],
    },
  });

  assert.ok(strong.liveSizing);
  assert.ok(weak.liveSizing);
  assert.strictEqual(
    (weak.liveSizing?.combinedSizeMultiplier as number | undefined ?? 1) <
      (strong.liveSizing?.combinedSizeMultiplier as number | undefined ?? 1),
    true,
  );
  if (strong.result.approved === 1 && weak.result.approved === 1) {
    assert.strictEqual((weak.positionSize ?? 0) < (strong.positionSize ?? 0), true);
  }
}

async function testDailyReviewPersistsRegimeLocalSizingSummary(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'item6-daily-review-'));
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
          regime: 'trend_burst',
          capturedAt: new Date('2026-03-25T00:01:00.000Z'),
          staleOrder: false,
          evDrift: -0.01,
        },
        {
          orderId: 'order-2',
          strategyVersionId: 'strategyA',
          expectedEv: 0.04,
          realizedEv: -0.01,
          regime: 'near_resolution_microstructure_chaos',
          capturedAt: new Date('2026-03-25T00:02:00.000Z'),
          staleOrder: false,
          evDrift: -0.02,
        },
      ],
      create: async () => null,
    },
    order: {
      findMany: async () => [
        {
          id: 'order-1',
          strategyVersionId: 'strategyA',
          signal: {
            id: 'signal-1',
            strategyVersionId: 'strategyA',
            regime: 'trend_burst',
            posteriorProbability: 0.68,
            marketImpliedProb: 0.56,
            edge: 0.07,
            expectedEv: 0.05,
            observedAt: new Date('2026-03-25T00:00:00.000Z'),
          },
        },
        {
          id: 'order-2',
          strategyVersionId: 'strategyA',
          signal: {
            id: 'signal-2',
            strategyVersionId: 'strategyA',
            regime: 'near_resolution_microstructure_chaos',
            posteriorProbability: 0.62,
            marketImpliedProb: 0.55,
            edge: 0.04,
            expectedEv: 0.04,
            observedAt: new Date('2026-03-25T00:00:30.000Z'),
          },
        },
      ],
    },
    auditEvent: {
      findMany: async ({ where }: { where?: Record<string, unknown> }) => {
        const eventFilter = where?.eventType;
        const requested =
          eventFilter && typeof eventFilter === 'object' && 'in' in eventFilter
            ? ((eventFilter as { in?: unknown }).in as string[] | undefined) ?? []
            : [];
        if (requested.includes('order.submitted')) {
          return [
            {
              orderId: 'order-1',
              eventType: 'order.submitted',
              createdAt: new Date('2026-03-25T00:00:03.000Z'),
              metadata: {
                retainedEdgeExpectation: {
                  marketArchetype: 'trend_follow_through',
                  toxicityState: 'normal',
                },
              },
            },
            {
              orderId: 'order-2',
              eventType: 'order.submitted',
              createdAt: new Date('2026-03-25T00:00:33.000Z'),
              metadata: {
                retainedEdgeExpectation: {
                  marketArchetype: 'stressed_microstructure',
                  toxicityState: 'blocked',
                },
              },
            },
          ];
        }
        return [];
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdAuditEvents.push(data);
        return data;
      },
    },
  };

  const job = new DailyReviewJob(prisma as never, learningStateStore, learningEventLog);
  await job.run({
    force: true,
    now: new Date('2026-03-25T00:10:00.000Z'),
  });

  const sizingReview = createdAuditEvents.find(
    (event) => event.eventType === 'learning.regime_local_sizing_review',
  );
  assert.ok(sizingReview);
  const metadata =
    sizingReview && typeof sizingReview.metadata === 'object'
      ? (sizingReview.metadata as Record<string, unknown>)
      : null;
  assert.strictEqual(Array.isArray(metadata?.byRegime), true);
  assert.strictEqual(Array.isArray(metadata?.byArchetype), true);

  const savedState = await learningStateStore.load();
  const reviewOutputs =
    savedState.lastCycleSummary?.reviewOutputs &&
    typeof savedState.lastCycleSummary.reviewOutputs === 'object'
      ? (savedState.lastCycleSummary.reviewOutputs as Record<string, unknown>)
      : null;
  const regimeLocalSizing =
    reviewOutputs?.regimeLocalSizing && typeof reviewOutputs.regimeLocalSizing === 'object'
      ? (reviewOutputs.regimeLocalSizing as Record<string, unknown>)
      : null;
  assert.ok(regimeLocalSizing);
  assert.strictEqual(Array.isArray(regimeLocalSizing?.mostConstrainedContexts), true);
}

async function testLearningStateStoreCompactsRegimeLocalSizingSummary(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'item6-learning-state-'));
  const store = new LearningStateStore(rootDir);
  const state = createDefaultLearningState(new Date('2026-03-25T00:00:00.000Z'));
  state.lastCycleSummary = {
    cycleId: 'cycle-1',
    startedAt: '2026-03-25T00:00:00.000Z',
    completedAt: '2026-03-25T00:10:00.000Z',
    status: 'completed',
    analyzedWindow: {
      from: '2026-03-25T00:00:00.000Z',
      to: '2026-03-25T00:10:00.000Z',
    },
    realizedOutcomeCount: 1,
    attributionSliceCount: 1,
    calibrationUpdates: 0,
    shrinkageActions: 0,
    degradedContexts: [],
    warnings: [],
    errors: [],
    reviewOutputs: {
      regimeLocalSizing: {
        generatedAt: '2026-03-25T00:10:00.000Z',
        sampleCount: 30,
        byRegime: Array.from({ length: 20 }, (_, index) => ({
          contextType: 'regime',
          contextValue: `regime-${index}`,
          sampleCount: 10,
          retentionRatio: 0.7,
          realizedVsExpectedGap: -0.01,
          recommendedSizeMultiplier: 0.9,
          reasonCodes: ['x', 'y', 'z'],
        })),
        byArchetype: Array.from({ length: 20 }, (_, index) => ({
          contextType: 'archetype',
          contextValue: `archetype-${index}`,
          sampleCount: 10,
          retentionRatio: 0.8,
          realizedVsExpectedGap: -0.005,
          recommendedSizeMultiplier: 0.95,
          reasonCodes: ['a', 'b'],
        })),
        mostConstrainedContexts: Array.from({ length: 20 }, (_, index) => ({
          contextType: 'regime',
          contextValue: `constrained-${index}`,
          sampleCount: 10,
          retentionRatio: 0.5,
          realizedVsExpectedGap: -0.03,
          recommendedSizeMultiplier: 0.7,
          reasonCodes: ['c'],
        })),
      },
    },
  };
  await store.save(state);

  const loaded = await store.load();
  const reviewOutputs = loaded.lastCycleSummary?.reviewOutputs as Record<string, unknown>;
  const regimeLocalSizing = reviewOutputs.regimeLocalSizing as Record<string, unknown>;
  assert.strictEqual(Array.isArray(regimeLocalSizing.byRegime), true);
  assert.strictEqual((regimeLocalSizing.byRegime as unknown[]).length, 12);
  assert.strictEqual((regimeLocalSizing.byArchetype as unknown[]).length, 12);
  assert.strictEqual((regimeLocalSizing.mostConstrainedContexts as unknown[]).length, 8);
}

async function runEvaluationScenario(input: {
  regime: string;
  marketArchetype: string;
  reviewSummary: RegimeLocalSizingSummary;
}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'item6-evaluate-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const versionLineageRegistry = new VersionLineageRegistry(path.join(rootDir, 'lineage'));
  const deploymentRegistry = new StrategyDeploymentRegistry(path.join(rootDir, 'deployment'));
  const tradeQualityHistoryStore = new TradeQualityHistoryStore(path.join(rootDir, 'quality'));
  const strategyVariantId = buildStrategyVariantId('strategy-live-1');
  const learningState = createDefaultLearningState(new Date('2026-03-25T00:00:00.000Z'));
  learningState.lastCycleSummary = {
    cycleId: 'cycle-1',
    startedAt: '2026-03-25T00:00:00.000Z',
    completedAt: '2026-03-25T00:10:00.000Z',
    status: 'completed',
    analyzedWindow: {
      from: '2026-03-25T00:00:00.000Z',
      to: '2026-03-25T00:10:00.000Z',
    },
    realizedOutcomeCount: 1,
    attributionSliceCount: 1,
    calibrationUpdates: 0,
    shrinkageActions: 0,
    degradedContexts: [],
    warnings: [],
    errors: [],
    reviewOutputs: {
      regimeLocalSizing: input.reviewSummary,
    },
  };
  learningState.strategyVariants[strategyVariantId] = {
    ...createDefaultStrategyVariantState(strategyVariantId),
    health:
      input.regime === 'near_resolution_microstructure_chaos' ? 'degraded' : 'healthy',
    regimeSnapshots: {
      [`regime:${input.regime}`]: {
        key: `regime:${input.regime}`,
        regime: input.regime,
        liquidityBucket: 'balanced',
        spreadBucket: 'normal',
        timeToExpiryBucket: 'under_15m',
        entryTimingBucket: 'early',
        executionStyle: 'hybrid',
        side: 'buy',
        strategyVariantId,
        sampleCount: 20,
        winRate: 0.55,
        expectedEvSum: 0.28,
        realizedEvSum: input.regime === 'near_resolution_microstructure_chaos' ? 0.14 : 0.26,
        avgExpectedEv: 0.014,
        avgRealizedEv: input.regime === 'near_resolution_microstructure_chaos' ? 0.007 : 0.013,
        realizedVsExpected:
          input.regime === 'near_resolution_microstructure_chaos' ? 0.58 : 0.97,
        avgFillRate: 0.85,
        avgSlippage: 0.002,
        health:
          input.regime === 'near_resolution_microstructure_chaos' ? 'degraded' : 'healthy',
        lastObservedAt: '2026-03-25T00:00:00.000Z',
      },
    },
  };
  await learningStateStore.save(learningState);

  const signal = {
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
    edge: 0.036,
    expectedEv: 0.055,
    regime: input.regime,
    status: 'approved',
    observedAt: new Date(Date.now() - 4_000),
  };
  await versionLineageRegistry.recordDecision({
    decisionId: 'build-signal-1',
    decisionType: 'signal_build',
    signalId: signal.id,
    marketId: signal.marketId,
    strategyVariantId,
    summary: 'seed upstream archetype',
    lineage: {
      strategyVersion: null,
      featureSetVersion: null,
      calibrationVersion: null,
      executionPolicyVersion: null,
      riskPolicyVersion: null,
      allocationPolicyVersion: null,
    },
    replay: {
      marketState: null,
      runtimeState: null,
      learningState: null,
      lineageState: null,
      activeParameterBundle: {
        phaseTwoContext: {
          marketArchetype: input.marketArchetype,
        },
      },
      venueMode: null,
      venueUncertainty: null,
    },
    tags: ['signal-build'],
    recordedAt: new Date('2026-03-25T00:00:01.000Z').toISOString(),
  });

  const createdDecisions: Array<Record<string, unknown>> = [];
  const auditEvents: Array<Record<string, unknown>> = [];
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
      findMany: async () => [
        {
          id: 'm1',
          slug: 'btc-5m',
          title: 'Will BTC be higher in 5 minutes?',
          status: 'active',
          tokenIdYes: 'yes1',
          tokenIdNo: 'no1',
          expiresAt: new Date(Date.now() + 300_000),
        },
      ],
    },
    orderbook: {
      findFirst: async () => ({
        bestBid: 0.54,
        bestAsk: 0.55,
        spread: 0.01,
        bidLevels: [
          { price: 0.54, size: 24 },
          { price: 0.53, size: 18 },
        ],
        askLevels: [
          { price: 0.55, size: 24 },
          { price: 0.56, size: 18 },
        ],
        tickSize: 0.01,
        minOrderSize: 1,
        negRisk: false,
        observedAt: new Date(),
      }),
    },
    marketSnapshot: {
      findFirst: async () => ({
        observedAt: new Date(),
        expiresAt: new Date(Date.now() + 300_000),
        volume: 500,
        marketPrice: 0.55,
      }),
    },
    reconciliationCheckpoint: {
      findFirst: async ({ where }: { where: { source: string } }) =>
        where.source === 'research_governance_validation'
          ? {
              source: where.source,
              processedAt: new Date(),
              status: 'passed',
              details: {
                robustness: { passed: true },
                promotion: { score: 0.82 },
              },
            }
          : {
              source: where.source,
              processedAt: new Date(),
              status: 'completed',
            },
    },
    botRuntimeStatus: {
      findUnique: async () => ({ id: 'live', state: 'running', lastHeartbeatAt: new Date() }),
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
      findMany: async () => [],
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

  const job = new EvaluateTradeOpportunitiesJob(
    prisma as never,
    runtimeControl as never,
    deploymentRegistry,
    learningStateStore,
    versionLineageRegistry,
    venueHealthLearningStore as never,
    tradeQualityHistoryStore,
  );
  const result = await job.run({
    maxOpenPositions: 2,
    maxDailyLossPct: 5,
    maxPerTradeRiskPct: 1,
    maxKellyFraction: 0.05,
    maxConsecutiveLosses: 2,
    noTradeWindowSeconds: 30,
    evaluationIntervalMs: 1_000,
    orderReconcileIntervalMs: 2_000,
    portfolioRefreshIntervalMs: 5_000,
  });
  const approvedDecision = createdDecisions.find((decision) => decision.verdict === 'approved');
  const decisionEvent = auditEvents.find(
    (event) => event.eventType === 'signal.execution_decision',
  );
  const liveSizing =
    decisionEvent &&
    typeof decisionEvent.metadata === 'object' &&
    (decisionEvent.metadata as Record<string, unknown>).regimeLocalSizingDecision &&
    typeof (decisionEvent.metadata as Record<string, unknown>).regimeLocalSizingDecision ===
      'object'
      ? ((decisionEvent.metadata as Record<string, unknown>).regimeLocalSizingDecision as Record<
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
    liveSizing,
  };
}

export const itemSixRegimeLocalSizingTests = [
  {
    name: 'item6 regime local sizing reduces weak regime and archetype',
    fn: testRegimeLocalSizingReducesWeakRegimeAndArchetype,
  },
  {
    name: 'item6 regime local sizing summary ranks constrained contexts',
    fn: testRegimeLocalSizingSummaryRanksConstrainedContexts,
  },
  {
    name: 'item6 evaluate trade opportunities applies regime local sizing',
    fn: testEvaluateTradeOpportunitiesAppliesRegimeLocalSizing,
  },
  {
    name: 'item6 daily review persists regime local sizing summary',
    fn: testDailyReviewPersistsRegimeLocalSizingSummary,
  },
  {
    name: 'item6 learning state store compacts regime local sizing summary',
    fn: testLearningStateStoreCompactsRegimeLocalSizingSummary,
  },
];
