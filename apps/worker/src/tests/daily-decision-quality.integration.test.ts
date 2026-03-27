import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ResolvedTradeRecord } from '@polymarket-btc-5m-agentic-bot/domain';
import {
  createDefaultLearningState,
  createDefaultStrategyVariantState,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { CapitalGrowthReviewJob } from '../jobs/capitalGrowthReview.job';
import { DailyReviewJob } from '../jobs/dailyReview.job';
import { formatDailyDecisionQualityOutput } from '../commands/print-daily-decision-quality.command';
import { LearningEventLog } from '../runtime/learning-event-log';
import { LearningStateStore } from '../runtime/learning-state-store';
import { ResolvedTradeLedger } from '../runtime/resolved-trade-ledger';
import { StrategyDeploymentRegistry } from '../runtime/strategy-deployment-registry';
import { VersionLineageRegistry } from '../runtime/version-lineage-registry';
import {
  buildDailyDecisionQualityReport,
  type DailyDecisionQualityReport,
} from '../validation/daily-decision-quality-report';
import { buildLiveProofScorecard } from '../validation/live-proof-scorecard';

async function testDailyDecisionQualityReportBuildsDailyAndRegimeSlices(): Promise<void> {
  const report = buildDailyDecisionQualityReport({
    from: new Date('2026-03-26T00:00:00.000Z'),
    to: new Date('2026-03-27T00:00:00.000Z'),
    resolvedTrades: [
      buildResolvedTrade({
        tradeId: 'trade-1',
        regime: 'trend_burst',
        realizedPnl: 18,
        realizedNetEdgeBps: 75,
        expectedNetEdgeBps: 60,
      }),
      buildResolvedTrade({
        tradeId: 'trade-2',
        regime: 'illiquid_noisy_book',
        realizedPnl: -11,
        realizedNetEdgeBps: -45,
        expectedNetEdgeBps: 20,
        lossReasonCodes: ['toxicity_damage'],
        lossAttributionCategory: 'toxicity_damage',
      }),
    ],
    rejectedDecisions: [
      {
        timestamp: '2026-03-26T12:00:00.000Z',
        regime: 'illiquid_noisy_book',
        reasonCodes: ['spread_too_wide', 'low_depth'],
      },
    ],
    now: new Date('2026-03-27T00:00:00.000Z'),
  });

  assert.strictEqual(report.byDay.length, 1);
  assert.strictEqual(report.byRegime.length, 2);
  assert.strictEqual(report.overall.tradeCount, 2);
  assert.strictEqual(report.overall.topRejectedReasonCodes[0]?.reasonCode, 'low_depth');
  assert.strictEqual(report.byRegime.some((entry) => entry.sliceKey === 'trend_burst'), true);
  assert.strictEqual(
    report.byRegime.find((entry) => entry.sliceKey === 'illiquid_noisy_book')
      ?.topLossReasonCodes[0]?.reasonCode,
    'toxicity_damage',
  );

  const output = formatDailyDecisionQualityOutput({
    report,
    lastNDays: 1,
  });
  assert.strictEqual(output.reportAvailable, true);
  assert.strictEqual(Array.isArray(output.recentDays), true);
}

async function testDailyReviewPersistsDailyDecisionQualityArtifact(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase8-daily-quality-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const learningEventLog = new LearningEventLog(rootDir);
  const versionLineageRegistry = new VersionLineageRegistry(rootDir);
  const strategyDeploymentRegistry = new StrategyDeploymentRegistry(rootDir);
  const resolvedTradeLedger = new ResolvedTradeLedger(rootDir);
  const createdAuditEvents: Array<Record<string, unknown>> = [];
  await resolvedTradeLedger.append(
    buildResolvedTrade({
      tradeId: 'trade-1',
      finalizedTimestamp: '2026-03-26T12:05:00.000Z',
      realizedPnl: 9,
      realizedNetEdgeBps: 42,
      expectedNetEdgeBps: 30,
    }),
  );
  const job = new DailyReviewJob(
    {
      auditEvent: {
        findMany: async () => [
          {
            createdAt: new Date('2026-03-26T12:00:00.000Z'),
            eventType: 'signal.execution_decision',
            metadata: {
              reasons: ['spread_too_wide'],
              regimeLabel: 'illiquid_noisy_book',
              admissionDecision: {
                admitted: false,
                rejectionReasons: ['spread_too_wide'],
              },
            },
          },
        ],
        create: async ({ data }: { data: Record<string, unknown> }) => {
          createdAuditEvents.push(data);
          return data;
        },
      },
    } as never,
    learningStateStore,
    learningEventLog,
    strategyDeploymentRegistry,
    versionLineageRegistry,
    undefined,
    resolvedTradeLedger,
  );

  const result = await (job as any).runPhaseEightDailyDecisionQualityReview({
    now: new Date('2026-03-27T00:00:00.000Z'),
    from: new Date('2026-03-26T00:00:00.000Z'),
    to: new Date('2026-03-27T00:00:00.000Z'),
  });

  const latestPath = path.join(rootDir, 'daily-decision-quality.latest.json');
  assert.strictEqual(fs.existsSync(latestPath), true);
  assert.strictEqual(result.report.overall.tradeCount, 1);
  assert.strictEqual(
    createdAuditEvents.some(
      (event) => event.eventType === 'learning.daily_decision_quality_review',
    ),
    true,
  );
}

async function testCapitalGrowthReviewUsesDailyDecisionQualityInputs(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase8-capital-growth-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const learningState = createDefaultLearningState(new Date('2026-03-27T00:00:00.000Z'));
  learningState.strategyVariants['variant:strategy-live-1'] = {
    ...createDefaultStrategyVariantState('variant:strategy-live-1'),
  };
  await learningStateStore.save(learningState);
  const report = buildWeakDailyDecisionQualityReport();
  const job = new CapitalGrowthReviewJob(
    {
      auditEvent: {
        create: async () => ({}),
      },
    } as never,
    learningStateStore,
  );

  const result = await job.run({
    from: new Date('2026-03-26T00:00:00.000Z'),
    to: new Date('2026-03-27T00:00:00.000Z'),
    learningState,
    capitalLeakReport: null,
    baselineComparison: null,
    dailyDecisionQualityReport: report,
    rollingBenchmarkScorecard: null,
    retentionReport: null,
    regimePerformanceReport: null,
    liveProofScorecard: null,
  });

  assert.ok(result.report.dailyDecisionQualityReport);
  assert.strictEqual(
    result.warnings.includes('daily_capital_efficiency_weak'),
    true,
  );
}

async function testLiveProofScorecardIncludesDailyDecisionQualityMetrics(): Promise<void> {
  const scorecard = buildLiveProofScorecard({
    mode: 'empirical',
    datasetType: 'empirical',
    datasetQuality: {
      verdict: 'accepted',
      blockingReasons: [],
      warnings: [],
    },
    evidence: {
      empiricalEvidenceUsed: true,
      syntheticAllowed: false,
    },
    governance: {
      confidence: 0.92,
      promotionEligible: true,
      failReasons: [],
    },
    robustness: {
      passed: true,
      score: 0.82,
    },
    promotion: {
      promoted: true,
      score: 0.8,
      reasons: [],
    },
    baselineComparison: {
      generatedAt: '2026-03-27T00:00:00.000Z',
      strategy: {
        benchmarkId: 'strategy',
        benchmarkName: 'Primary Strategy',
        sampleCount: 10,
        tradeCount: 6,
        expectedEv: 0.01,
        realizedEv: 0.008,
        realizedVsExpected: 0.8,
        opportunityClassDistribution: {
          strong_edge: 1,
          tradable_edge: 4,
          marginal_edge: 3,
          weak_edge: 2,
        },
        regimeBreakdown: [],
      },
      benchmarks: [],
      comparisons: [],
      outperformedBenchmarkIds: ['btc_follow_baseline'],
      underperformedBenchmarkIds: [],
    },
    retentionReport: {
      generatedAt: '2026-03-27T00:00:00.000Z',
      aggregateExpectedEv: 1,
      aggregateRealizedEv: 0.9,
      aggregateRetentionRatio: 0.9,
      perRegime: [],
      toxicityConditioned: [],
    } as any,
    regimePerformanceReport: {
      generatedAt: '2026-03-27T00:00:00.000Z',
      perRegime: [],
      strongestRegimes: [],
      weakestRegimes: [],
      benchmarkComparisonSummary: {
        benchmarkCount: 0,
        outperformedBenchmarkIds: [],
        underperformedBenchmarkIds: [],
      },
    } as any,
    dailyDecisionQualityReport: buildWeakDailyDecisionQualityReport(),
  });

  assert.ok(scorecard.dailyDecisionQualitySummary);
  assert.strictEqual(
    scorecard.blockers.includes('daily_net_day_share_too_low'),
    true,
  );
}

function buildWeakDailyDecisionQualityReport(): DailyDecisionQualityReport {
  return buildDailyDecisionQualityReport({
    from: new Date('2026-03-26T00:00:00.000Z'),
    to: new Date('2026-03-27T00:00:00.000Z'),
    resolvedTrades: [
      buildResolvedTrade({
        tradeId: 'weak-trade-1',
        realizedPnl: -14,
        realizedNetEdgeBps: -60,
        expectedNetEdgeBps: 20,
        lossReasonCodes: ['alpha_wrong'],
      }),
    ],
    rejectedDecisions: [],
    now: new Date('2026-03-27T00:00:00.000Z'),
  });
}

function buildResolvedTrade(input: {
  tradeId: string;
  finalizedTimestamp?: string;
  regime?: string;
  realizedPnl?: number;
  realizedNetEdgeBps?: number;
  expectedNetEdgeBps?: number;
  lossReasonCodes?: string[];
  lossAttributionCategory?: string | null;
}): ResolvedTradeRecord {
  return {
    tradeId: input.tradeId,
    orderId: `${input.tradeId}-order`,
    venueOrderId: `${input.tradeId}-venue`,
    marketId: 'market-1',
    tokenId: 'token-1',
    strategyVariantId: 'variant:strategy-live-1',
    strategyVersion: 'strategy-live-1',
    regime: input.regime ?? 'trend_burst',
    archetype: 'trend_follow_through',
    decisionTimestamp: '2026-03-26T12:00:00.000Z',
    submissionTimestamp: '2026-03-26T12:00:05.000Z',
    firstFillTimestamp: '2026-03-26T12:00:06.000Z',
    finalizedTimestamp: input.finalizedTimestamp ?? '2026-03-26T12:10:00.000Z',
    side: 'BUY',
    intendedPrice: 0.55,
    averageFillPrice: 0.56,
    size: 10,
    notional: 100,
    estimatedFeeAtDecision: 0.2,
    realizedFee: 0.25,
    estimatedSlippageBps: 6,
    realizedSlippageBps: 9,
    queueDelayMs: 1_200,
    fillFraction: 1,
    expectedNetEdgeBps: input.expectedNetEdgeBps ?? 40,
    realizedNetEdgeBps: input.realizedNetEdgeBps ?? 30,
    maxFavorableExcursionBps: 20,
    maxAdverseExcursionBps: -12,
    toxicityScoreAtDecision: 0.3,
    benchmarkContext: {
      benchmarkComparisonState: 'outperforming',
      baselinePenaltyMultiplier: 1,
      regimeBenchmarkGateState: 'passed',
      underperformedBenchmarkIds: [],
      outperformedBenchmarkIds: ['no_trade_baseline'],
      reasonCodes: [],
    },
    lossAttributionCategory: input.lossAttributionCategory ?? null,
    executionAttributionCategory: null,
    lifecycleState: 'economically_resolved_with_portfolio_truth',
    attribution: {
      benchmarkContext: null,
      lossAttributionCategory: input.lossAttributionCategory ?? null,
      executionAttributionCategory: null,
      primaryLeakageDriver: input.lossAttributionCategory ?? null,
      secondaryLeakageDrivers: [],
      reasonCodes: input.lossReasonCodes ?? [],
    },
    executionQuality: {
      intendedPrice: 0.55,
      averageFillPrice: 0.56,
      size: 10,
      notional: 100,
      estimatedFeeAtDecision: 0.2,
      realizedFee: 0.25,
      estimatedSlippageBps: 6,
      realizedSlippageBps: 9,
      queueDelayMs: 1_200,
      fillFraction: 1,
    },
    netOutcome: {
      expectedNetEdgeBps: input.expectedNetEdgeBps ?? 40,
      realizedNetEdgeBps: input.realizedNetEdgeBps ?? 30,
      maxFavorableExcursionBps: 20,
      maxAdverseExcursionBps: -12,
      realizedPnl: input.realizedPnl ?? 6,
    },
    capturedAt: input.finalizedTimestamp ?? '2026-03-26T12:10:00.000Z',
  };
}

export const phaseEightDailyDecisionQualityTests = [
  {
    name: 'daily decision-quality report builds daily and regime slices',
    fn: testDailyDecisionQualityReportBuildsDailyAndRegimeSlices,
  },
  {
    name: 'daily review persists daily decision-quality artifact',
    fn: testDailyReviewPersistsDailyDecisionQualityArtifact,
  },
  {
    name: 'capital growth review uses daily decision-quality inputs',
    fn: testCapitalGrowthReviewUsesDailyDecisionQualityInputs,
  },
  {
    name: 'live proof scorecard includes daily decision-quality metrics',
    fn: testLiveProofScorecardIncludesDailyDecisionQualityMetrics,
  },
];
