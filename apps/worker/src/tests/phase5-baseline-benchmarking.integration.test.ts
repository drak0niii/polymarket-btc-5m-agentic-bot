import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DailyReviewJob } from '../jobs/dailyReview.job';
import {
  CapitalGrowthReviewJob,
  readLatestBaselineComparison,
} from '../jobs/capitalGrowthReview.job';
import { LearningEventLog } from '../runtime/learning-event-log';
import { LearningStateStore } from '../runtime/learning-state-store';
import { buildBaselineComparison } from '../validation/baseline-comparison';
import {
  buildEmpiricalWalkForwardSamples,
  loadHistoricalValidationDataset,
  runP23Validation,
  type HistoricalExecutableCase,
} from '../validation/p23-validation';
import {
  BtcFollowBaseline,
  MomentumBaseline,
  NoRegimeBaseline,
  ReversionBaseline,
  type BenchmarkReplayCase,
} from '@polymarket-btc-5m-agentic-bot/signal-engine';
import {
  createDefaultLearningState,
  createDefaultStrategyVariantState,
} from '@polymarket-btc-5m-agentic-bot/domain';

const repoRoot = path.resolve(__dirname, '../../../..');

async function testBtcFollowBaselineProducesStructuredSummary(): Promise<void> {
  const summary = new BtcFollowBaseline().evaluate(buildBenchmarkCases());

  assert.strictEqual(summary.sampleCount, 4);
  assert.strictEqual(summary.tradeCount > 0, true);
  assert.strictEqual(Number.isFinite(summary.expectedEv), true);
  assert.strictEqual(Number.isFinite(summary.realizedEv), true);
  assert.strictEqual(Array.isArray(summary.regimeBreakdown), true);
  assert.strictEqual(summary.regimeBreakdown.length > 0, true);
}

async function testMomentumAndReversionBaselinesRemainDistinct(): Promise<void> {
  const cases = buildBenchmarkCases();
  const momentum = new MomentumBaseline().evaluate(cases);
  const reversion = new ReversionBaseline().evaluate(cases);

  assert.strictEqual(momentum.benchmarkId, 'momentum_baseline');
  assert.strictEqual(reversion.benchmarkId, 'reversion_baseline');
  assert.notStrictEqual(momentum.tradeCount, reversion.tradeCount);
}

async function testNoRegimeBaselineProducesOpportunityDistribution(): Promise<void> {
  const summary = new NoRegimeBaseline().evaluate(buildBenchmarkCases());

  assert.strictEqual(summary.sampleCount, 4);
  assert.strictEqual(
    Object.values(summary.opportunityClassDistribution).reduce(
      (sum, value) => sum + value,
      0,
    ),
    4,
  );
}

async function testBaselineComparisonProducesReplayableOutputs(): Promise<void> {
  const comparison = buildBaselineComparison(buildHistoricalCases());

  assert.strictEqual(comparison.strategy.sampleCount, 8);
  assert.strictEqual(comparison.benchmarks.length, 4);
  assert.strictEqual(comparison.comparisons.length, 4);
  assert.strictEqual(
    comparison.comparisons.every((entry) => typeof entry.strategyOutperformed === 'boolean'),
    true,
  );
}

async function testP23ValidationProducesBaselineComparison(): Promise<void> {
  const payload = await runP23Validation();

  assert.ok(payload.baselineComparison);
  assert.strictEqual(payload.baselineComparison.benchmarks.length, 4);
  assert.strictEqual(payload.baselineComparison.strategy.sampleCount > 0, true);
}

async function testCapitalGrowthReviewCarriesBaselineComparison(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-capital-growth-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const learningState = createDefaultLearningState(new Date('2026-03-25T00:00:00.000Z'));
  learningState.strategyVariants['variant:strategy-live-1'] = {
    ...createDefaultStrategyVariantState('variant:strategy-live-1'),
  };
  await learningStateStore.save(learningState);

  const job = new CapitalGrowthReviewJob(
    {
      auditEvent: { create: async () => null },
    } as never,
    learningStateStore,
  );
  const baselineComparison = buildBaselineComparison(buildHistoricalCases());
  const result = await job.run({
    from: new Date('2026-03-25T00:00:00.000Z'),
    to: new Date('2026-03-25T01:00:00.000Z'),
    learningState,
    baselineComparison,
    capitalLeakReport: null,
  });

  assert.ok(result.report.baselineComparison);
  assert.strictEqual(
    result.report.baselineComparison?.benchmarks.length,
    4,
  );
}

async function testDailyReviewBaselineHelperEmitsAuditSummary(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-daily-review-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const learningEventLog = new LearningEventLog(rootDir);
  const createdAuditEvents: Array<Record<string, unknown>> = [];
  const prisma = {
    auditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdAuditEvents.push(data);
        return data;
      },
    },
  };
  const job = new DailyReviewJob(prisma as never, learningStateStore, learningEventLog);

  const result = await (job as any).runPhaseFiveBaselineBenchmarkReview({
    now: new Date('2026-03-25T02:00:00.000Z'),
    baselineComparison: buildBaselineComparison(buildHistoricalCases()),
  });

  assert.strictEqual(Array.isArray(result.warnings), true);
  assert.strictEqual(
    createdAuditEvents.some(
      (event) => event.eventType === 'learning.baseline_benchmark_review',
    ),
    true,
  );
}

async function testReadLatestBaselineComparisonReadsValidationArtifact(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-baseline-artifact-'));
  const artifactPath = path.join(tempDir, 'latest.json');
  const baselineComparison = buildBaselineComparison(buildHistoricalCases());
  fs.writeFileSync(
    artifactPath,
    JSON.stringify({ baselineComparison }, null, 2),
    'utf8',
  );

  const loaded = await readLatestBaselineComparison(artifactPath);
  assert.ok(loaded);
  assert.strictEqual(loaded?.benchmarks.length, 4);
}

function buildBenchmarkCases(): BenchmarkReplayCase[] {
  return [
    createBenchmarkCase({
      observationId: 'obs-1',
      regime: 'momentum_continuation',
      rollingReturnPct: 0.006,
      lastReturnPct: 0.004,
      realizedOutcomeUp: 1,
    }),
    createBenchmarkCase({
      observationId: 'obs-2',
      regime: 'low_volatility_drift',
      rollingReturnPct: -0.004,
      lastReturnPct: -0.003,
      realizedOutcomeUp: 0,
    }),
    createBenchmarkCase({
      observationId: 'obs-3',
      regime: 'spike_and_revert',
      rollingReturnPct: 0.001,
      lastReturnPct: -0.006,
      realizedOutcomeUp: 1,
      orderbookNoiseScore: 0.18,
    }),
    createBenchmarkCase({
      observationId: 'obs-4',
      regime: 'illiquid_noisy_book',
      rollingReturnPct: 0.003,
      lastReturnPct: 0.001,
      realizedOutcomeUp: 0,
      spread: 0.02,
      topLevelDepth: 12,
    }),
  ];
}

function createBenchmarkCase(
  overrides: Partial<BenchmarkReplayCase> & {
    observationId: string;
    regime: string;
    rollingReturnPct: number;
    lastReturnPct: number;
    realizedOutcomeUp: number;
    spread?: number;
    topLevelDepth?: number;
    orderbookNoiseScore?: number;
  },
): BenchmarkReplayCase {
  return {
    observationId: overrides.observationId,
    observedAt: '2026-03-25T00:00:00.000Z',
    regime: overrides.regime,
    marketImpliedProbabilityUp: overrides.marketImpliedProbabilityUp ?? 0.54,
    realizedOutcomeUp: overrides.realizedOutcomeUp,
    fillRate: overrides.fillRate ?? 0.82,
    spreadCost: overrides.spreadCost ?? 0.001,
    slippageCost: overrides.slippageCost ?? 0.0015,
    feeCost: overrides.feeCost ?? 0.001,
    latencyCost: overrides.latencyCost ?? 0.0008,
    timeoutCancelCost: overrides.timeoutCancelCost ?? 0.0006,
    timeBucket: overrides.timeBucket ?? 'us',
    marketStructureBucket: overrides.marketStructureBucket ?? 'balanced',
    featureSnapshot: {
      rollingReturnPct: overrides.rollingReturnPct,
      lastReturnPct: overrides.lastReturnPct,
      realizedVolatility: overrides.featureSnapshot?.realizedVolatility ?? 0.012,
      spread: overrides.spread ?? overrides.featureSnapshot?.spread ?? 0.01,
      topLevelDepth:
        overrides.topLevelDepth ?? overrides.featureSnapshot?.topLevelDepth ?? 32,
      combinedDepth: overrides.featureSnapshot?.combinedDepth ?? 60,
      orderbookNoiseScore:
        overrides.orderbookNoiseScore ??
        overrides.featureSnapshot?.orderbookNoiseScore ??
        0.08,
      timeToExpirySeconds:
        overrides.featureSnapshot?.timeToExpirySeconds ?? 240,
    },
  };
}

function buildHistoricalCases(): HistoricalExecutableCase[] {
  const dataset = loadHistoricalValidationDataset(
    path.join(
      repoRoot,
      'apps/worker/src/validation/datasets/p23-empirical-validation.dataset.json',
    ),
  );
  const built = buildEmpiricalWalkForwardSamples(dataset);
  return built.executableCases.slice(0, 8);
}

export const phaseFiveBaselineBenchmarkingTests = [
  {
    name: 'phase5 btc follow baseline produces structured summary',
    fn: testBtcFollowBaselineProducesStructuredSummary,
  },
  {
    name: 'phase5 momentum and reversion baselines remain distinct',
    fn: testMomentumAndReversionBaselinesRemainDistinct,
  },
  {
    name: 'phase5 no-regime baseline produces opportunity distribution',
    fn: testNoRegimeBaselineProducesOpportunityDistribution,
  },
  {
    name: 'phase5 baseline comparison produces replayable outputs',
    fn: testBaselineComparisonProducesReplayableOutputs,
  },
  {
    name: 'phase5 p23 validation produces baseline comparison',
    fn: testP23ValidationProducesBaselineComparison,
  },
  {
    name: 'phase5 capital growth review carries baseline comparison',
    fn: testCapitalGrowthReviewCarriesBaselineComparison,
  },
  {
    name: 'phase5 daily review baseline helper emits audit summary',
    fn: testDailyReviewBaselineHelperEmitsAuditSummary,
  },
  {
    name: 'phase5 baseline comparison reader loads validation artifact',
    fn: testReadLatestBaselineComparisonReadsValidationArtifact,
  },
];
