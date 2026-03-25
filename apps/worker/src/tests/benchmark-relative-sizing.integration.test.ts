import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  BenchmarkRelativeSizing,
  type BenchmarkRelativeSizingBenchmark,
  type BenchmarkRelativeSizingContextEntry,
} from '@polymarket-btc-5m-agentic-bot/risk-engine';
import {
  buildStrategyVariantId,
  createDefaultLearningState,
  createDefaultStrategyVariantState,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { DailyReviewJob } from '../jobs/dailyReview.job';
import { EvaluateTradeOpportunitiesJob } from '../jobs/evaluateTradeOpportunities.job';
import { LearningStateStore } from '../runtime/learning-state-store';
import { StrategyDeploymentRegistry } from '../runtime/strategy-deployment-registry';
import { VersionLineageRegistry } from '../runtime/version-lineage-registry';
import { TradeQualityHistoryStore } from '@polymarket-btc-5m-agentic-bot/risk-engine';

async function testBenchmarkRelativeSizingOutperformingCase(): Promise<void> {
  const decision = new BenchmarkRelativeSizing().evaluate({
    regime: 'trend_burst',
    overallUnderperformedBenchmarkIds: [],
    overallOutperformedBenchmarkIds: ['btc_follow_baseline'],
    strategyRegimeBreakdown: [createContext('trend_burst', 0.018, 0.016, 0.92)],
    benchmarks: [
      createBenchmark('btc_follow_baseline', createContext('trend_burst', 0.014, 0.011, 0.79)),
      createBenchmark('momentum_baseline', createContext('trend_burst', 0.015, 0.012, 0.8)),
    ],
  });

  assert.strictEqual(decision.baselinePenaltyMultiplier, 1);
  assert.strictEqual(decision.benchmarkComparisonState, 'outperforming');
  assert.strictEqual(decision.regimeBenchmarkGateState, 'passed');
  assert.strictEqual(decision.promotionBlockedByBenchmark, false);
  assert.strictEqual(
    decision.benchmarkPenaltyReasonCodes.includes('benchmark_context_outperforming'),
    true,
  );
  assert.strictEqual(
    decision.regimeBenchmarkReasonCodes.includes('benchmark_gate_passed'),
    true,
  );
}

async function testBenchmarkRelativeSizingUnderperformingCase(): Promise<void> {
  const decision = new BenchmarkRelativeSizing().evaluate({
    regime: 'illiquid_noisy_book',
    overallUnderperformedBenchmarkIds: ['btc_follow_baseline', 'momentum_baseline'],
    overallOutperformedBenchmarkIds: [],
    strategyRegimeBreakdown: [createContext('illiquid_noisy_book', 0.006, -0.002, -0.33)],
    benchmarks: [
      createBenchmark(
        'btc_follow_baseline',
        createContext('illiquid_noisy_book', 0.009, 0.004, 0.44),
      ),
      createBenchmark(
        'momentum_baseline',
        createContext('illiquid_noisy_book', 0.008, 0.003, 0.38),
      ),
      createBenchmark(
        'no_regime_baseline',
        createContext('illiquid_noisy_book', 0.007, 0.001, 0.14),
      ),
    ],
  });

  assert.strictEqual(decision.baselinePenaltyMultiplier < 1, true);
  assert.strictEqual(decision.benchmarkComparisonState, 'underperforming');
  assert.strictEqual(decision.regimeBenchmarkGateState, 'blocked');
  assert.strictEqual(decision.promotionBlockedByBenchmark, true);
  assert.strictEqual(
    decision.benchmarkPenaltyReasonCodes.includes('benchmark_underperformance_majority'),
    true,
  );
  assert.strictEqual(
    decision.regimeBenchmarkReasonCodes.includes('benchmark_gate_underperforming_context'),
    true,
  );
}

async function testBenchmarkRelativeSizingNeutralCase(): Promise<void> {
  const decision = new BenchmarkRelativeSizing().evaluate({
    regime: 'balanced_rotation',
    overallUnderperformedBenchmarkIds: ['btc_follow_baseline'],
    overallOutperformedBenchmarkIds: ['reversion_baseline'],
    strategyRegimeBreakdown: [createContext('balanced_rotation', 0.011, 0.009, 0.82)],
    benchmarks: [
      createBenchmark(
        'btc_follow_baseline',
        createContext('balanced_rotation', 0.0104, 0.0068, 0.65),
      ),
      createBenchmark(
        'reversion_baseline',
        createContext('balanced_rotation', 0.0095, 0.0092, 0.97),
      ),
    ],
  });

  assert.strictEqual(decision.baselinePenaltyMultiplier, 1);
  assert.strictEqual(decision.benchmarkComparisonState, 'neutral');
  assert.strictEqual(decision.regimeBenchmarkGateState, 'blocked');
  assert.strictEqual(decision.promotionBlockedByBenchmark, true);
  assert.strictEqual(
    decision.benchmarkPenaltyReasonCodes.includes('benchmark_context_mixed'),
    true,
  );
  assert.strictEqual(
    decision.regimeBenchmarkReasonCodes.includes('benchmark_gate_non_outperforming_context'),
    true,
  );
}

async function testBenchmarkRelativeSizingInsufficientEvidenceCase(): Promise<void> {
  const decision = new BenchmarkRelativeSizing().evaluate({
    regime: 'trend_burst',
    overallUnderperformedBenchmarkIds: [],
    overallOutperformedBenchmarkIds: [],
    strategyRegimeBreakdown: [
      createContext('trend_burst', 0.017, 0.015, 0.88, {
        sampleCount: 3,
        tradeCount: 2,
      }),
    ],
    benchmarks: [
      createBenchmark(
        'btc_follow_baseline',
        createContext('trend_burst', 0.013, 0.011, 0.81, {
          sampleCount: 3,
          tradeCount: 2,
        }),
      ),
    ],
  });

  assert.strictEqual(decision.regimeBenchmarkGateState, 'insufficient_evidence');
  assert.strictEqual(decision.promotionBlockedByBenchmark, true);
  assert.strictEqual(
    decision.regimeBenchmarkReasonCodes.includes('benchmark_gate_insufficient_evidence'),
    true,
  );
}

async function testEvaluateTradeOpportunitiesShrinksSizeUnderBenchmarkFailure(): Promise<void> {
  const strong = await runEvaluationScenario(false);
  const weak = await runEvaluationScenario(true);

  assert.ok(strong.benchmarkRelativeSizing);
  assert.ok(weak.benchmarkRelativeSizing);
  assert.strictEqual(
    strong.benchmarkRelativeSizing?.regimeBenchmarkGateState,
    'passed',
  );
  assert.strictEqual(
    weak.benchmarkRelativeSizing?.regimeBenchmarkGateState,
    'blocked',
  );
  assert.strictEqual(
    weak.benchmarkRelativeSizing?.promotionBlockedByBenchmark,
    true,
  );
  assert.strictEqual(
    (weak.benchmarkRelativeSizing?.baselinePenaltyMultiplier as number | undefined ?? 1) <
      (strong.benchmarkRelativeSizing?.baselinePenaltyMultiplier as number | undefined ?? 1),
    true,
  );
  if (strong.result.approved === 1 && weak.result.approved === 1) {
    assert.strictEqual((weak.positionSize ?? 0) < (strong.positionSize ?? 0), true);
  }
}

async function testDailyReviewBuildsBenchmarkRelativeSizingSummary(): Promise<void> {
  const createdAuditEvents: Array<Record<string, unknown>> = [];
  const job = new DailyReviewJob({
    auditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdAuditEvents.push(data);
        return data;
      },
    },
  } as never);

  const result = await (job as any).runItemSevenBenchmarkRelativeSizingReview({
    now: new Date('2026-03-26T00:00:00.000Z'),
    baselineComparison: {
      generatedAt: '2026-03-26T00:00:00.000Z',
      strategy: {
        benchmarkId: 'strategy',
        benchmarkName: 'Primary Strategy',
        sampleCount: 12,
        tradeCount: 6,
        expectedEv: 0.012,
        realizedEv: 0.005,
        realizedVsExpected: 0.41,
        opportunityClassDistribution: {
          strong_edge: 1,
          tradable_edge: 3,
          marginal_edge: 4,
          weak_edge: 4,
        },
        regimeBreakdown: [
          {
            regime: 'trend_burst',
            sampleCount: 6,
            tradeCount: 4,
            expectedEv: 0.016,
            realizedEv: 0.012,
            realizedVsExpected: 0.75,
            opportunityClassDistribution: {
              strong_edge: 1,
              tradable_edge: 3,
              marginal_edge: 1,
              weak_edge: 1,
            },
          },
          {
            regime: 'illiquid_noisy_book',
            sampleCount: 6,
            tradeCount: 2,
            expectedEv: 0.008,
            realizedEv: -0.002,
            realizedVsExpected: -0.25,
            opportunityClassDistribution: {
              strong_edge: 0,
              tradable_edge: 0,
              marginal_edge: 3,
              weak_edge: 3,
            },
          },
        ],
      },
      benchmarks: [
        {
          benchmarkId: 'btc_follow_baseline',
          benchmarkName: 'BTC Follow Baseline',
          sampleCount: 12,
          tradeCount: 7,
          expectedEv: 0.013,
          realizedEv: 0.008,
          realizedVsExpected: 0.61,
          opportunityClassDistribution: {
            strong_edge: 1,
            tradable_edge: 2,
            marginal_edge: 5,
            weak_edge: 4,
          },
          regimeBreakdown: [
            {
              regime: 'trend_burst',
              sampleCount: 6,
              tradeCount: 4,
              expectedEv: 0.014,
              realizedEv: 0.011,
              realizedVsExpected: 0.79,
              opportunityClassDistribution: {
                strong_edge: 1,
                tradable_edge: 2,
                marginal_edge: 2,
                weak_edge: 1,
              },
            },
            {
              regime: 'illiquid_noisy_book',
              sampleCount: 6,
              tradeCount: 3,
              expectedEv: 0.009,
              realizedEv: 0.003,
              realizedVsExpected: 0.33,
              opportunityClassDistribution: {
                strong_edge: 0,
                tradable_edge: 0,
                marginal_edge: 3,
                weak_edge: 3,
              },
            },
          ],
        },
      ],
      comparisons: [],
      outperformedBenchmarkIds: [],
      underperformedBenchmarkIds: ['btc_follow_baseline'],
    },
  });

  assert.strictEqual(result.warnings.length > 0, true);
  assert.strictEqual(Array.isArray(result.summary.regimePenalties), true);
  assert.strictEqual(
    Array.isArray(result.summary.promotionBlockedRegimes),
    true,
  );
  assert.ok(
    createdAuditEvents.find(
      (event) => event.eventType === 'learning.benchmark_relative_sizing_review',
    ),
  );
}

function createContext(
  regime: string,
  expectedEv: number,
  realizedEv: number,
  realizedVsExpected: number | null,
  overrides?: {
    sampleCount?: number;
    tradeCount?: number;
  },
): BenchmarkRelativeSizingContextEntry {
  return {
    regime,
    sampleCount: overrides?.sampleCount ?? 12,
    tradeCount: overrides?.tradeCount ?? 6,
    expectedEv,
    realizedEv,
    realizedVsExpected,
  };
}

function createBenchmark(
  benchmarkId: string,
  context: BenchmarkRelativeSizingContextEntry,
): BenchmarkRelativeSizingBenchmark {
  return {
    benchmarkId,
    benchmarkName: benchmarkId,
    regimeBreakdown: [context],
  };
}

async function runEvaluationScenario(useWeakBenchmarks: boolean) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'item7-evaluate-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const versionLineageRegistry = new VersionLineageRegistry(path.join(rootDir, 'lineage'));
  const deploymentRegistry = new StrategyDeploymentRegistry(path.join(rootDir, 'deployment'));
  const tradeQualityHistoryStore = new TradeQualityHistoryStore(path.join(rootDir, 'quality'));
  const strategyVariantId = buildStrategyVariantId('strategy-live-1');
  const regime = useWeakBenchmarks ? 'illiquid_noisy_book' : 'trend_burst';
  const learningState = createDefaultLearningState(new Date('2026-03-26T00:00:00.000Z'));
  learningState.strategyVariants[strategyVariantId] = {
    ...createDefaultStrategyVariantState(strategyVariantId),
    health: useWeakBenchmarks ? 'degraded' : 'healthy',
    regimeSnapshots: {
      [`regime:${regime}`]: {
        key: `regime:${regime}`,
        regime,
        liquidityBucket: 'balanced',
        spreadBucket: 'normal',
        timeToExpiryBucket: 'under_15m',
        entryTimingBucket: 'early',
        executionStyle: 'hybrid',
        side: 'buy',
        strategyVariantId,
        sampleCount: 20,
        winRate: useWeakBenchmarks ? 0.42 : 0.57,
        expectedEvSum: 0.28,
        realizedEvSum: useWeakBenchmarks ? 0.14 : 0.26,
        avgExpectedEv: 0.014,
        avgRealizedEv: useWeakBenchmarks ? 0.007 : 0.013,
        realizedVsExpected: useWeakBenchmarks ? 0.58 : 0.97,
        avgFillRate: 0.82,
        avgSlippage: 0.002,
        health: useWeakBenchmarks ? 'degraded' : 'healthy',
        lastObservedAt: '2026-03-26T00:00:00.000Z',
      },
    },
  };
  learningState.lastCycleSummary = {
    cycleId: 'cycle-1',
    startedAt: '2026-03-26T00:00:00.000Z',
    completedAt: '2026-03-26T00:10:00.000Z',
    status: 'completed',
    analyzedWindow: {
      from: '2026-03-26T00:00:00.000Z',
      to: '2026-03-26T00:10:00.000Z',
    },
    realizedOutcomeCount: 1,
    attributionSliceCount: 1,
    calibrationUpdates: 0,
    shrinkageActions: 0,
    degradedContexts: [],
    warnings: [],
    errors: [],
    reviewOutputs: {
      baselineBenchmarks: buildBaselineComparisonReport(useWeakBenchmarks),
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
    regime,
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
          marketArchetype: useWeakBenchmarks
            ? 'stressed_microstructure'
            : 'trend_follow_through',
        },
      },
      venueMode: null,
      venueUncertainty: null,
    },
    tags: ['signal-build'],
    recordedAt: new Date('2026-03-26T00:00:01.000Z').toISOString(),
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
      updatedAt: new Date('2026-03-26T00:00:00.000Z').toISOString(),
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
  const benchmarkRelativeSizing =
    decisionEvent &&
    typeof decisionEvent.metadata === 'object' &&
    (decisionEvent.metadata as Record<string, unknown>).benchmarkRelativeSizingDecision &&
    typeof (decisionEvent.metadata as Record<string, unknown>)
      .benchmarkRelativeSizingDecision === 'object'
      ? ((decisionEvent.metadata as Record<string, unknown>)
          .benchmarkRelativeSizingDecision as Record<string, unknown>)
      : null;

  return {
    result,
    positionSize:
      approvedDecision && typeof approvedDecision.positionSize === 'number'
        ? approvedDecision.positionSize
        : null,
    benchmarkRelativeSizing,
  };
}

function buildBaselineComparisonReport(useWeakBenchmarks: boolean) {
  return {
    generatedAt: '2026-03-26T00:00:00.000Z',
    strategy: {
      benchmarkId: 'strategy',
      benchmarkName: 'Primary Strategy',
      sampleCount: 12,
      tradeCount: 6,
      expectedEv: useWeakBenchmarks ? 0.008 : 0.016,
      realizedEv: useWeakBenchmarks ? -0.002 : 0.012,
      realizedVsExpected: useWeakBenchmarks ? -0.25 : 0.92,
      opportunityClassDistribution: {
        strong_edge: 1,
        tradable_edge: 2,
        marginal_edge: 4,
        weak_edge: 5,
      },
      regimeBreakdown: [
        {
          regime: useWeakBenchmarks ? 'illiquid_noisy_book' : 'trend_burst',
          sampleCount: 12,
          tradeCount: 6,
          expectedEv: useWeakBenchmarks ? 0.008 : 0.016,
          realizedEv: useWeakBenchmarks ? -0.002 : 0.012,
          realizedVsExpected: useWeakBenchmarks ? -0.25 : 0.92,
          opportunityClassDistribution: {
            strong_edge: 1,
            tradable_edge: 2,
            marginal_edge: 4,
            weak_edge: 5,
          },
        },
      ],
    },
    benchmarks: [
      {
        benchmarkId: 'btc_follow_baseline',
        benchmarkName: 'BTC Follow Baseline',
        sampleCount: 12,
        tradeCount: 6,
        expectedEv: useWeakBenchmarks ? 0.01 : 0.012,
        realizedEv: useWeakBenchmarks ? 0.003 : 0.01,
        realizedVsExpected: useWeakBenchmarks ? 0.3 : 0.79,
        opportunityClassDistribution: {
          strong_edge: 1,
          tradable_edge: 2,
          marginal_edge: 4,
          weak_edge: 5,
        },
        regimeBreakdown: [
          {
            regime: useWeakBenchmarks ? 'illiquid_noisy_book' : 'trend_burst',
            sampleCount: 12,
            tradeCount: 6,
            expectedEv: useWeakBenchmarks ? 0.01 : 0.012,
            realizedEv: useWeakBenchmarks ? 0.003 : 0.01,
            realizedVsExpected: useWeakBenchmarks ? 0.3 : 0.79,
            opportunityClassDistribution: {
              strong_edge: 1,
              tradable_edge: 2,
              marginal_edge: 4,
              weak_edge: 5,
            },
          },
        ],
      },
      {
        benchmarkId: 'momentum_baseline',
        benchmarkName: 'Momentum Baseline',
        sampleCount: 12,
        tradeCount: 6,
        expectedEv: useWeakBenchmarks ? 0.009 : 0.011,
        realizedEv: useWeakBenchmarks ? 0.002 : 0.009,
        realizedVsExpected: useWeakBenchmarks ? 0.22 : 0.8,
        opportunityClassDistribution: {
          strong_edge: 1,
          tradable_edge: 2,
          marginal_edge: 4,
          weak_edge: 5,
        },
        regimeBreakdown: [
          {
            regime: useWeakBenchmarks ? 'illiquid_noisy_book' : 'trend_burst',
            sampleCount: 12,
            tradeCount: 6,
            expectedEv: useWeakBenchmarks ? 0.009 : 0.011,
            realizedEv: useWeakBenchmarks ? 0.002 : 0.009,
            realizedVsExpected: useWeakBenchmarks ? 0.22 : 0.8,
            opportunityClassDistribution: {
              strong_edge: 1,
              tradable_edge: 2,
              marginal_edge: 4,
              weak_edge: 5,
            },
          },
        ],
      },
    ],
    comparisons: [],
    outperformedBenchmarkIds: useWeakBenchmarks
      ? []
      : ['btc_follow_baseline', 'momentum_baseline'],
    underperformedBenchmarkIds: useWeakBenchmarks
      ? ['btc_follow_baseline', 'momentum_baseline']
      : [],
  };
}

export const itemSevenBenchmarkRelativeSizingTests = [
  {
    name: 'item7 benchmark relative sizing leaves outperforming context unchanged',
    fn: testBenchmarkRelativeSizingOutperformingCase,
  },
  {
    name: 'item7 benchmark relative sizing penalizes underperforming context',
    fn: testBenchmarkRelativeSizingUnderperformingCase,
  },
  {
    name: 'item7 benchmark relative sizing leaves mixed context neutral',
    fn: testBenchmarkRelativeSizingNeutralCase,
  },
  {
    name: 'item9 benchmark relative sizing blocks scale up on insufficient evidence',
    fn: testBenchmarkRelativeSizingInsufficientEvidenceCase,
  },
  {
    name: 'item7 evaluate trade opportunities shrinks size under benchmark failure',
    fn: testEvaluateTradeOpportunitiesShrinksSizeUnderBenchmarkFailure,
  },
  {
    name: 'item7 daily review builds benchmark relative sizing summary',
    fn: testDailyReviewBuildsBenchmarkRelativeSizingSummary,
  },
];
