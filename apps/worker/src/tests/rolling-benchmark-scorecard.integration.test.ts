import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createDefaultLearningState,
  createDefaultStrategyVariantState,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { CapitalGrowthReviewJob } from '../jobs/capitalGrowthReview.job';
import { DailyReviewJob } from '../jobs/dailyReview.job';
import { LearningStateStore } from '../runtime/learning-state-store';
import type { BaselineComparisonReport } from '../validation/baseline-comparison';
import {
  buildRollingBenchmarkScorecard,
  type RollingBenchmarkComparisonState,
} from '../validation/rolling-benchmark-scorecard';
import {
  runP23Validation,
  type HistoricalExecutableCase,
} from '../validation/p23-validation';

async function testRollingBenchmarkScorecardBuildsRollingWindows(): Promise<void> {
  const scorecard = buildRollingBenchmarkScorecard({
    executableCases: buildRollingCases(),
    now: new Date('2026-03-10T12:00:00.000Z'),
    comparisonBuilder: (cases) => createSyntheticComparison(cases),
  });

  assert.deepStrictEqual(
    scorecard.windows.map((window) => window.windowKey),
    ['1d', '3d', '7d', '30d'],
  );
  assert.strictEqual(scorecard.windows[0]?.benchmarkComparisonState, 'outperforming');
  assert.strictEqual(scorecard.windows[1]?.benchmarkComparisonState, 'mixed');
  assert.strictEqual(scorecard.windows[2]?.benchmarkComparisonState, 'underperforming');
  assert.strictEqual(scorecard.stabilityOfOutperformance.underperformingWindowCount > 0, true);
}

async function testRollingBenchmarkScorecardUsesBestAvailableThirtyDayEquivalent(): Promise<void> {
  const scorecard = buildRollingBenchmarkScorecard({
    executableCases: buildRollingCases(),
    now: new Date('2026-03-10T12:00:00.000Z'),
    comparisonBuilder: (cases) => createSyntheticComparison(cases),
  });

  const trailingThirtyDay = scorecard.windows.find((window) => window.windowKey === '30d');
  assert.ok(trailingThirtyDay);
  assert.strictEqual(trailingThirtyDay?.exactWindowAvailable, false);
  assert.strictEqual((trailingThirtyDay?.effectiveDays ?? 0) < 30, true);
  assert.strictEqual((trailingThirtyDay?.sampleCount ?? 0) > 0, true);
}

async function testP23ValidationProducesRollingBenchmarkScorecard(): Promise<void> {
  const payload = await runP23Validation();

  assert.ok(payload.rollingBenchmarkScorecard);
  assert.strictEqual(payload.rollingBenchmarkScorecard.windows.length, 4);
  assert.strictEqual(
    payload.rollingBenchmarkScorecard.windows.some((window) => window.windowKey === '30d'),
    true,
  );
}

async function testCapitalGrowthReviewCarriesRollingBenchmarkScorecard(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'item8-capital-growth-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const learningState = createDefaultLearningState(new Date('2026-03-25T00:00:00.000Z'));
  learningState.strategyVariants['variant:strategy-live-1'] = {
    ...createDefaultStrategyVariantState('variant:strategy-live-1'),
  };
  await learningStateStore.save(learningState);

  const createdAuditEvents: Array<Record<string, unknown>> = [];
  const payload = await runP23Validation();
  const job = new CapitalGrowthReviewJob(
    {
      auditEvent: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          createdAuditEvents.push(data);
          return data;
        },
      },
    } as never,
    learningStateStore,
  );
  const result = await job.run({
    from: new Date('2026-03-25T00:00:00.000Z'),
    to: new Date('2026-03-25T01:00:00.000Z'),
    learningState,
    baselineComparison: payload.baselineComparison,
    rollingBenchmarkScorecard: payload.rollingBenchmarkScorecard,
    retentionReport: payload.retentionReport,
    regimePerformanceReport: payload.regimePerformanceReport,
    liveProofScorecard: payload.liveProofScorecard,
    capitalLeakReport: null,
  });

  assert.ok(result.report.rollingBenchmarkScorecard);
  assert.strictEqual(
    createdAuditEvents.some(
      (event) => event.eventType === 'validation.rolling_benchmark_scorecard',
    ),
    true,
  );
}

async function testDailyReviewRollingBenchmarkScorecardEmitsAuditSummary(): Promise<void> {
  const createdAuditEvents: Array<Record<string, unknown>> = [];
  const job = new DailyReviewJob({
    auditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdAuditEvents.push(data);
        return data;
      },
    },
  } as never);

  const result = await (job as any).runItemEightRollingBenchmarkScorecardReview({
    now: new Date('2026-03-26T00:00:00.000Z'),
    rollingBenchmarkScorecard: buildRollingBenchmarkScorecard({
      executableCases: buildRollingCases(),
      now: new Date('2026-03-10T12:00:00.000Z'),
      comparisonBuilder: (cases) => createSyntheticComparison(cases),
    }),
  });

  assert.strictEqual(Array.isArray(result.warnings), true);
  assert.strictEqual(
    createdAuditEvents.some(
      (event) => event.eventType === 'learning.rolling_benchmark_scorecard_review',
    ),
    true,
  );
  assert.strictEqual(
    typeof result.summary.stabilityOfOutperformance === 'object' &&
      result.summary.stabilityOfOutperformance !== null,
    true,
  );
}

function buildRollingCases(): HistoricalExecutableCase[] {
  return [
    createHistoricalCase('2026-03-01T00:00:00.000Z', 0.009, 0.002),
    createHistoricalCase('2026-03-03T00:00:00.000Z', 0.009, 0.003),
    createHistoricalCase('2026-03-06T00:00:00.000Z', 0.0095, 0.004),
    createHistoricalCase('2026-03-08T00:00:00.000Z', 0.0105, 0.011),
    createHistoricalCase('2026-03-09T12:00:00.000Z', 0.011, 0.018),
    createHistoricalCase('2026-03-10T12:00:00.000Z', 0.011, 0.02),
  ];
}

function createSyntheticComparison(
  cases: HistoricalExecutableCase[],
): BaselineComparisonReport {
  const state: RollingBenchmarkComparisonState =
    cases.length <= 2
      ? 'outperforming'
      : cases.length === 3
        ? 'mixed'
        : 'underperforming';
  const averageRealized =
    cases.reduce((sum, entry) => sum + entry.realizedReturn, 0) / Math.max(cases.length, 1);
  const outperformedBenchmarkIds =
    state === 'outperforming'
      ? ['btc_follow_baseline', 'momentum_baseline']
      : state === 'mixed'
        ? ['btc_follow_baseline']
        : [];
  const underperformedBenchmarkIds =
    state === 'underperforming'
      ? ['btc_follow_baseline', 'momentum_baseline']
      : state === 'mixed'
        ? ['momentum_baseline']
        : [];

  return {
    generatedAt: '2026-03-10T12:00:00.000Z',
    strategy: {
      benchmarkId: 'strategy',
      benchmarkName: 'Primary Strategy',
      sampleCount: cases.length,
      tradeCount: cases.length,
      expectedEv: 0.01,
      realizedEv: averageRealized,
      realizedVsExpected: averageRealized / 0.01,
      opportunityClassDistribution: {
        strong_edge: 0,
        tradable_edge: cases.length,
        marginal_edge: 0,
        weak_edge: 0,
      },
      regimeBreakdown: [],
    },
    benchmarks: [
      createBenchmarkSummary('btc_follow_baseline'),
      createBenchmarkSummary('momentum_baseline'),
    ],
    comparisons: [
      createComparisonEntry(
        'btc_follow_baseline',
        outperformedBenchmarkIds.includes('btc_follow_baseline'),
      ),
      createComparisonEntry(
        'momentum_baseline',
        outperformedBenchmarkIds.includes('momentum_baseline'),
      ),
    ],
    outperformedBenchmarkIds,
    underperformedBenchmarkIds,
  };
}

function createBenchmarkSummary(benchmarkId: string) {
  return {
    benchmarkId,
    benchmarkName: benchmarkId,
    sampleCount: 6,
    tradeCount: 4,
    expectedEv: 0.009,
    realizedEv: 0.008,
    realizedVsExpected: 0.89,
    opportunityClassDistribution: {
      strong_edge: 0,
      tradable_edge: 6,
      marginal_edge: 0,
      weak_edge: 0,
    },
    regimeBreakdown: [] as [],
    assumptions: ['test_fixture'],
    generatedAt: '2026-03-10T12:00:00.000Z',
  };
}

function createComparisonEntry(benchmarkId: string, outperformed: boolean) {
  return {
    benchmarkId,
    benchmarkName: benchmarkId,
    expectedEvGap: outperformed ? 0.001 : -0.001,
    realizedEvGap: outperformed ? 0.004 : -0.004,
    realizedVsExpectedGap: outperformed ? 0.12 : -0.12,
    tradeCountGap: 0,
    strategyOutperformed: outperformed,
  };
}

function createHistoricalCase(
  observedAt: string,
  costAdjustedEv: number,
  realizedReturn: number,
): HistoricalExecutableCase {
  return {
    observationId: `obs-${observedAt}`,
    slug: 'btc-above-100k',
    observedAt,
    strategySide: 'UP',
    marketImpliedProbabilityUp: 0.54,
    realizedOutcomeUp: 1,
    marketImpliedProbability: 0.54,
    predictedProbability: 0.57,
    realizedOutcome: 1,
    expectedEdge: 0.03,
    executableEv: costAdjustedEv + 0.001,
    costAdjustedEv,
    realizedReturn,
    fillRate: 0.84,
    spreadCost: 0.001,
    slippageCost: 0.0012,
    feeCost: 0.0008,
    latencyCost: 0.0004,
    timeoutCancelCost: 0.0002,
    replayKey: `replay-${observedAt}`,
    regime: 'trend_burst',
    marketArchetype: 'momentum_continuation',
    liquidityBucket: 'medium',
    timeBucket: 'asia',
    marketStructureBucket: 'balanced',
    featureSnapshot: {
      rollingReturnPct: 0.004,
      lastReturnPct: 0.002,
      realizedVolatility: 0.015,
      spread: 0.008,
      spreadToDepthRatio: 0.002,
      topLevelDepth: 40,
      combinedDepth: 120,
      orderbookNoiseScore: 0.08,
      flowImbalanceProxy: 0.21,
      flowIntensity: 0.32,
      micropriceBias: 0.015,
      bookUpdateStress: 0.18,
      btcMoveTransmission: 0.42,
      signalDecayPressure: 0.12,
      marketArchetype: 'trend_follow_through',
      marketArchetypeConfidence: 0.82,
      marketStateTransition: 'trend_acceleration',
      timeToExpirySeconds: 7200,
    },
    microstructure: {
      boundaryDistance: 0.05,
      boundaryTension: 0.35,
      expiryConvexity: 0.18,
      liquidityClusterScore: 0.41,
      venueMispricingScore: 0.22,
      crowdLagScore: 0.17,
      decayPressure: 0.12,
      structureBucket: 'balanced',
      eventType: 'binary_event_contract',
      computedAt: observedAt,
    },
    toxicity: {
      toxicityScore: 0.22,
      bookInstabilityScore: 0.19,
      adverseSelectionRisk: 0.21,
      toxicityState: 'elevated',
      recommendedAction: 'reduce_size',
      reasons: ['test_fixture'],
      capturedAt: observedAt,
    },
  };
}

export const itemEightRollingBenchmarkScorecardTests = [
  {
    name: 'item8 rolling benchmark scorecard builds requested windows',
    fn: testRollingBenchmarkScorecardBuildsRollingWindows,
  },
  {
    name: 'item8 rolling benchmark scorecard uses best available 30 day equivalent',
    fn: testRollingBenchmarkScorecardUsesBestAvailableThirtyDayEquivalent,
  },
  {
    name: 'item8 p23 validation produces rolling benchmark scorecard',
    fn: testP23ValidationProducesRollingBenchmarkScorecard,
  },
  {
    name: 'item8 capital growth review carries rolling benchmark scorecard',
    fn: testCapitalGrowthReviewCarriesRollingBenchmarkScorecard,
  },
  {
    name: 'item8 daily review emits rolling benchmark scorecard summary',
    fn: testDailyReviewRollingBenchmarkScorecardEmitsAuditSummary,
  },
];
