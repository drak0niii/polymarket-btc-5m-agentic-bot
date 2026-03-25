import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createDefaultLearningState } from '@polymarket-btc-5m-agentic-bot/domain';
import { DailyReviewJob } from '../jobs/dailyReview.job';
import { LearningEventLog } from '../runtime/learning-event-log';
import { LearningStateStore } from '../runtime/learning-state-store';
import { runP23Validation } from '../validation/p23-validation';
import { buildRetentionContextReport } from '../validation/retention-context-report';

async function testRetentionContextReportGroupsByContext(): Promise<void> {
  const report = buildRetentionContextReport({
    now: new Date('2026-03-25T00:00:00.000Z'),
    observations: [
      {
        regime: 'trend_burst',
        archetype: 'trend_follow_through',
        toxicityState: 'normal',
        expectedNetEdge: 0.03,
        realizedNetEdge: 0.024,
      },
      {
        regime: 'trend_burst',
        archetype: 'trend_follow_through',
        toxicityState: 'elevated',
        expectedNetEdge: 0.02,
        realizedNetEdge: 0.008,
      },
      {
        regime: 'near_resolution_microstructure_chaos',
        archetype: 'stressed_microstructure',
        toxicityState: 'blocked',
        expectedNetEdge: 0.025,
        realizedNetEdge: -0.01,
      },
    ],
  });

  assert.strictEqual(report.sampleCount, 3);
  assert.strictEqual(report.retentionByRegime.length, 2);
  assert.strictEqual(report.retentionByArchetype.length, 2);
  assert.strictEqual(report.retentionByToxicityState.length, 3);
  assert.strictEqual(report.topDegradingContexts.length > 0, true);
  assert.strictEqual(report.topImprovingContexts.length > 0, true);
  assert.strictEqual(
    report.topDegradingContexts.some(
      (entry) =>
        entry.contextType === 'archetype' &&
        entry.contextValue === 'stressed_microstructure',
    ),
    true,
  );
}

async function testP23ValidationEmitsRetentionContextReport(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'item2-p23-'));
  const payload = await runP23Validation({
    mode: 'synthetic_smoke',
    allowSyntheticSmoke: true,
    evidenceDir: path.join(rootDir, 'evidence'),
    now: new Date('2026-03-25T00:00:00.000Z'),
  });

  assert.ok(payload.retentionContextReport);
  assert.strictEqual(
    Array.isArray(payload.retentionContextReport.retentionByRegime),
    true,
  );
  assert.strictEqual(
    Array.isArray(payload.retentionContextReport.retentionByArchetype),
    true,
  );
  assert.strictEqual(
    Array.isArray(payload.retentionContextReport.retentionByToxicityState),
    true,
  );
}

async function testDailyReviewPersistsRetentionContextSummary(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'item2-daily-review-'));
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
          expectedFee: 0.003,
          realizedFee: 0.003,
          expectedSlippage: 0.004,
          realizedSlippage: 0.006,
          edgeAtSignal: 0.07,
          edgeAtFill: 0.05,
          fillRate: 1,
          regime: 'trend_burst',
          capturedAt: new Date('2026-03-25T00:01:00.000Z'),
          staleOrder: false,
        },
        {
          orderId: 'order-2',
          strategyVersionId: 'strategyA',
          expectedEv: 0.04,
          realizedEv: -0.01,
          expectedFee: 0.003,
          realizedFee: 0.003,
          expectedSlippage: 0.004,
          realizedSlippage: 0.007,
          edgeAtSignal: 0.06,
          edgeAtFill: 0.03,
          fillRate: 1,
          regime: 'near_resolution_microstructure_chaos',
          capturedAt: new Date('2026-03-25T00:02:00.000Z'),
          staleOrder: false,
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
    orderbook: {
      findFirst: async () => ({
        spread: 0.02,
        observedAt: new Date('2026-03-25T00:00:00.000Z'),
        askLevels: [{ price: 0.56, size: 12 }],
        bidLevels: [{ price: 0.54, size: 10 }],
      }),
    },
    fill: {
      findMany: async () => [],
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

  const job = new DailyReviewJob(
    prisma as never,
    learningStateStore,
    learningEventLog,
  );
  await job.run({
    force: true,
    now: new Date('2026-03-25T00:10:00.000Z'),
  });

  const reviewEvent = createdAuditEvents.find(
    (event) => event.eventType === 'learning.retention_context_review',
  );
  assert.ok(reviewEvent);
  const metadata =
    reviewEvent && typeof reviewEvent.metadata === 'object'
      ? (reviewEvent.metadata as Record<string, unknown>)
      : null;
  assert.strictEqual(Array.isArray(metadata?.retentionByRegime), true);
  assert.strictEqual(Array.isArray(metadata?.retentionByArchetype), true);
  assert.strictEqual(Array.isArray(metadata?.retentionByToxicityState), true);

  const savedState = await learningStateStore.load();
  const reviewOutputs =
    savedState.lastCycleSummary?.reviewOutputs &&
    typeof savedState.lastCycleSummary.reviewOutputs === 'object'
      ? (savedState.lastCycleSummary.reviewOutputs as Record<string, unknown>)
      : null;
  const retentionContext =
    reviewOutputs?.retentionContext && typeof reviewOutputs.retentionContext === 'object'
      ? (reviewOutputs.retentionContext as Record<string, unknown>)
      : null;
  assert.ok(retentionContext);
  assert.strictEqual(Array.isArray(retentionContext?.topDegradingContexts), true);
}

async function testLearningStateStoreCompactsRetentionContextSummary(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'item2-learning-state-'));
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
    realizedOutcomeCount: 10,
    attributionSliceCount: 10,
    calibrationUpdates: 1,
    shrinkageActions: 0,
    degradedContexts: [],
    warnings: [],
    errors: [],
    reviewOutputs: {
      retentionContext: {
        generatedAt: '2026-03-25T00:10:00.000Z',
        sampleCount: 12,
        retentionByRegime: Array.from({ length: 20 }, (_, index) => ({
          contextType: 'regime',
          contextValue: `regime-${index}`,
          sampleCount: 1,
          expectedNetEdge: 0.01,
          realizedNetEdge: 0.008,
          retentionRatio: 0.8,
          realizedVsExpectedGap: -0.002,
          rankScore: 0.5,
        })),
        retentionByArchetype: Array.from({ length: 20 }, (_, index) => ({
          contextType: 'archetype',
          contextValue: `archetype-${index}`,
          sampleCount: 1,
          expectedNetEdge: 0.01,
          realizedNetEdge: 0.008,
          retentionRatio: 0.8,
          realizedVsExpectedGap: -0.002,
          rankScore: 0.5,
        })),
        retentionByToxicityState: Array.from({ length: 12 }, (_, index) => ({
          contextType: 'toxicity_state',
          contextValue: `toxicity-${index}`,
          sampleCount: 1,
          expectedNetEdge: 0.01,
          realizedNetEdge: 0.008,
          retentionRatio: 0.8,
          realizedVsExpectedGap: -0.002,
          rankScore: 0.5,
        })),
        topDegradingContexts: Array.from({ length: 8 }, (_, index) => ({
          contextType: 'regime',
          contextValue: `degrading-${index}`,
          sampleCount: 1,
          expectedNetEdge: 0.01,
          realizedNetEdge: 0.001,
          retentionRatio: 0.1,
          realizedVsExpectedGap: -0.009,
          rankScore: -1,
        })),
        topImprovingContexts: Array.from({ length: 8 }, (_, index) => ({
          contextType: 'regime',
          contextValue: `improving-${index}`,
          sampleCount: 1,
          expectedNetEdge: 0.01,
          realizedNetEdge: 0.015,
          retentionRatio: 1.5,
          realizedVsExpectedGap: 0.005,
          rankScore: 1,
        })),
      },
    },
  };

  await store.save(state);
  const loaded = await store.load();
  const reviewOutputs =
    loaded.lastCycleSummary?.reviewOutputs &&
    typeof loaded.lastCycleSummary.reviewOutputs === 'object'
      ? (loaded.lastCycleSummary.reviewOutputs as Record<string, unknown>)
      : null;
  const retentionContext =
    reviewOutputs?.retentionContext && typeof reviewOutputs.retentionContext === 'object'
      ? (reviewOutputs.retentionContext as Record<string, unknown>)
      : null;
  assert.ok(retentionContext);
  assert.strictEqual(
    Array.isArray(retentionContext?.retentionByRegime) &&
      (retentionContext?.retentionByRegime as unknown[]).length === 12,
    true,
  );
  assert.strictEqual(
    Array.isArray(retentionContext?.topImprovingContexts) &&
      (retentionContext?.topImprovingContexts as unknown[]).length === 5,
    true,
  );
}

export const itemTwoRetentionContextTests = [
  {
    name: 'item2 retention context report groups retention by regime archetype and toxicity',
    fn: testRetentionContextReportGroupsByContext,
  },
  {
    name: 'item2 p23 validation emits retention context report',
    fn: testP23ValidationEmitsRetentionContextReport,
  },
  {
    name: 'item2 daily review persists retention context summary',
    fn: testDailyReviewPersistsRetentionContextSummary,
  },
  {
    name: 'item2 learning state store compacts retention context summary',
    fn: testLearningStateStoreCompactsRetentionContextSummary,
  },
];
