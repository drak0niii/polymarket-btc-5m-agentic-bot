import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createDefaultLearningState,
  createDefaultStrategyDeploymentRegistryState,
  createDefaultStrategyVariantState,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { CapitalGrowthReviewJob } from '../jobs/capitalGrowthReview.job';
import { DailyReviewJob } from '../jobs/dailyReview.job';
import { DecisionLogService } from '../runtime/decision-log.service';
import { LearningEventLog } from '../runtime/learning-event-log';
import { LearningStateStore } from '../runtime/learning-state-store';
import { StrategyDeploymentRegistry } from '../runtime/strategy-deployment-registry';
import { VersionLineageRegistry } from '../runtime/version-lineage-registry';
import { buildBaselineComparison } from '../validation/baseline-comparison';
import { buildLiveProofScorecard } from '../validation/live-proof-scorecard';
import { buildRegimePerformanceReport } from '../validation/regime-performance-report';
import { buildRetentionReport } from '../validation/retention-report';
import {
  buildEmpiricalWalkForwardSamples,
  loadHistoricalValidationDataset,
  runP23Validation,
} from '../validation/p23-validation';

const repoRoot = path.resolve(__dirname, '../../../..');

async function testRetentionReportIncludesPerRegimeAndToxicitySlices(): Promise<void> {
  const report = buildRetentionReport({
    executableCases: buildHistoricalCases(),
    now: new Date('2026-03-25T20:00:00.000Z'),
  });

  assert.strictEqual(report.perRegime.length > 0, true);
  assert.strictEqual(report.toxicityConditioned.length > 0, true);
  assert.strictEqual(Number.isFinite(report.aggregateExpectedEv), true);
  assert.strictEqual(
    report.perRegime.every((entry) => Number.isFinite(entry.averageCalibrationGap)),
    true,
  );
}

async function testRegimePerformanceReportIncludesBenchmarkSummary(): Promise<void> {
  const executableCases = buildHistoricalCases();
  const baselineComparison = buildBaselineComparison(executableCases);
  const retentionReport = buildRetentionReport({ executableCases });
  const report = buildRegimePerformanceReport({
    executableCases,
    baselineComparison,
    retentionReport,
  });

  assert.strictEqual(report.perRegime.length > 0, true);
  assert.strictEqual(report.benchmarkComparisonSummary.benchmarkCount, 4);
  assert.strictEqual(report.weakestRegimes.length > 0, true);
  assert.strictEqual(
    report.perRegime.every((entry) => Array.isArray(entry.toxicityConditionedResults)),
    true,
  );
}

async function testLiveProofScorecardRejectsSyntheticOnlyAsPromotionProof(): Promise<void> {
  const executableCases = buildHistoricalCases();
  const baselineComparison = buildBaselineComparison(executableCases);
  const retentionReport = buildRetentionReport({ executableCases });
  const regimePerformanceReport = buildRegimePerformanceReport({
    executableCases,
    baselineComparison,
    retentionReport,
  });
  const scorecard = buildLiveProofScorecard({
    mode: 'synthetic_smoke',
    datasetType: 'synthetic',
    datasetQuality: {
      verdict: 'accepted_with_warnings',
      blockingReasons: [],
      warnings: ['synthetic_smoke_dataset_not_eligible_for_promotion'],
    },
    evidence: {
      empiricalEvidenceUsed: false,
      syntheticAllowed: true,
    },
    governance: {
      confidence: 1,
      promotionEligible: true,
      failReasons: [],
    },
    robustness: {
      passed: true,
      score: 1,
    },
    promotion: {
      promoted: true,
      score: 1,
      reasons: [],
    },
    baselineComparison,
    retentionReport,
    regimePerformanceReport,
  });

  assert.strictEqual(scorecard.promotableEvidence, false);
  assert.strictEqual(scorecard.evidenceClass, 'synthetic_smoke_only');
  assert.strictEqual(
    scorecard.blockers.includes('synthetic_only_evidence_not_promotable'),
    true,
  );
}

async function testP23ValidationProducesPhaseSixReports(): Promise<void> {
  const payload = await runP23Validation();

  assert.ok(payload.retentionReport);
  assert.ok(payload.regimePerformanceReport);
  assert.ok(payload.liveProofScorecard);
  assert.strictEqual(payload.regimePerformanceReport.perRegime.length > 0, true);
  assert.strictEqual(
    typeof payload.liveProofScorecard.summary === 'string' &&
      payload.liveProofScorecard.summary.length > 0,
    true,
  );
}

async function testCapitalGrowthReviewPersistsActionableProofEvents(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase6-capital-growth-'));
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

  assert.ok(result.report.liveProofScorecard);
  assert.ok(result.report.regimePerformanceReport);
  assert.ok(result.report.retentionReport);
  assert.strictEqual(
    createdAuditEvents.some((event) => event.eventType === 'validation.live_proof_scorecard'),
    true,
  );
  assert.strictEqual(
    createdAuditEvents.some((event) => event.eventType === 'validation.retention_report'),
    true,
  );
  assert.strictEqual(
    createdAuditEvents.some(
      (event) => event.eventType === 'validation.regime_performance_report',
    ),
    true,
  );
}

async function testDailyReviewProofReviewWritesAuditAndLineage(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase6-daily-review-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const learningEventLog = new LearningEventLog(rootDir);
  const versionLineageRegistry = new VersionLineageRegistry(rootDir);
  const strategyDeploymentRegistry = new StrategyDeploymentRegistry(rootDir);
  const createdAuditEvents: Array<Record<string, unknown>> = [];
  const prisma = {
    auditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdAuditEvents.push(data);
        return data;
      },
    },
  };
  const job = new DailyReviewJob(
    prisma as never,
    learningStateStore,
    learningEventLog,
    strategyDeploymentRegistry,
    versionLineageRegistry,
  );

  const learningState = createDefaultLearningState(new Date('2026-03-25T00:00:00.000Z'));
  learningState.strategyVariants['variant:strategy-live-1'] = {
    ...createDefaultStrategyVariantState('variant:strategy-live-1'),
  };
  await learningStateStore.save(learningState);
  const registry = createDefaultStrategyDeploymentRegistryState(
    new Date('2026-03-25T00:00:00.000Z'),
  );
  registry.incumbentVariantId = 'variant:strategy-live-1';
  registry.variants['variant:strategy-live-1'] = {
    ...registry.variants['variant:strategy-live-1'],
    strategyVersionId: 'strategy-live-1',
  };
  await strategyDeploymentRegistry.save(registry);

  const payload = await runP23Validation();
  const result = await (job as any).runPhaseSixValidationProofReview({
    cycleId: 'cycle-1',
    now: new Date('2026-03-25T02:00:00.000Z'),
    learningState,
    registry,
    capitalGrowthReport: {
      generatedAt: '2026-03-25T02:00:00.000Z',
      window: {
        from: '2026-03-25T01:00:00.000Z',
        to: '2026-03-25T02:00:00.000Z',
      },
      variants: [],
      compoundingEfficient: [],
      profitableButUnstable: [],
      shouldScale: [],
      shouldReduce: [],
      baselineComparison: payload.baselineComparison,
      rollingBenchmarkScorecard: payload.rollingBenchmarkScorecard,
      retentionReport: payload.retentionReport,
      regimePerformanceReport: payload.regimePerformanceReport,
      liveProofScorecard: payload.liveProofScorecard,
    },
  });

  assert.strictEqual(Array.isArray(result.warnings), true);
  assert.strictEqual(
    createdAuditEvents.some((event) => event.eventType === 'learning.live_proof_review'),
    true,
  );
  const tagged = await versionLineageRegistry.getLatestByTag('validation_proof');
  assert.strictEqual(tagged.length > 0, true);
}

async function testDecisionLogServiceSummarizesProofCoverage(): Promise<void> {
  const service = new DecisionLogService({} as never);
  const summary = service.summarizeProofCoverage([
    { eventType: 'validation.live_proof_scorecard' },
    { eventType: 'validation.retention_report' },
    { eventType: 'validation.regime_performance_report' },
    { eventType: 'learning.live_proof_review' },
  ]);

  assert.strictEqual(summary.healthy, true);
  assert.strictEqual(summary.coverage, 1);
  assert.strictEqual(summary.presentFamilies.length, 4);
}

function buildHistoricalCases() {
  const dataset = loadHistoricalValidationDataset(
    path.join(
      repoRoot,
      'apps/worker/src/validation/datasets/p23-empirical-validation.dataset.json',
    ),
  );
  return buildEmpiricalWalkForwardSamples(dataset).executableCases.slice(0, 24);
}

export const phaseSixLiveProofTests = [
  {
    name: 'phase6 retention report includes per-regime and toxicity slices',
    fn: testRetentionReportIncludesPerRegimeAndToxicitySlices,
  },
  {
    name: 'phase6 regime performance report includes benchmark summary',
    fn: testRegimePerformanceReportIncludesBenchmarkSummary,
  },
  {
    name: 'phase6 live proof scorecard rejects synthetic-only promotion proof',
    fn: testLiveProofScorecardRejectsSyntheticOnlyAsPromotionProof,
  },
  {
    name: 'phase6 p23 validation produces proof reports',
    fn: testP23ValidationProducesPhaseSixReports,
  },
  {
    name: 'phase6 capital growth review persists actionable proof events',
    fn: testCapitalGrowthReviewPersistsActionableProofEvents,
  },
  {
    name: 'phase6 daily review proof review writes audit and lineage',
    fn: testDailyReviewProofReviewWritesAuditAndLineage,
  },
  {
    name: 'phase6 decision log summarizes proof coverage',
    fn: testDecisionLogServiceSummarizesProofCoverage,
  },
];
