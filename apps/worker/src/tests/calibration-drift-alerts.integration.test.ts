import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createDefaultLearningState } from '@polymarket-btc-5m-agentic-bot/domain';
import { DailyReviewJob } from '../jobs/dailyReview.job';
import { LearningEventLog } from '../runtime/learning-event-log';
import { LearningStateStore } from '../runtime/learning-state-store';
import { runP23Validation } from '../validation/p23-validation';
import { buildCalibrationDriftAlerts } from '../validation/calibration-drift-alerts';

async function testCalibrationDriftAlertsThresholdBehavior(): Promise<void> {
  const report = buildCalibrationDriftAlerts({
    now: new Date('2026-03-26T00:00:00.000Z'),
    observations: [
      {
        regime: 'trend_burst',
        archetype: 'trend_follow_through',
        predictedProbability: 0.82,
        realizedOutcome: 0,
      },
      {
        regime: 'trend_burst',
        archetype: 'trend_follow_through',
        predictedProbability: 0.78,
        realizedOutcome: 0,
      },
      {
        regime: 'trend_burst',
        archetype: 'trend_follow_through',
        predictedProbability: 0.76,
        realizedOutcome: 0,
      },
      {
        regime: 'trend_burst',
        archetype: 'trend_follow_through',
        predictedProbability: 0.8,
        realizedOutcome: 0,
      },
      {
        regime: 'range_balance',
        archetype: 'balanced_rotation',
        predictedProbability: 0.55,
        realizedOutcome: 1,
      },
      {
        regime: 'range_balance',
        archetype: 'balanced_rotation',
        predictedProbability: 0.52,
        realizedOutcome: 0,
      },
    ],
  });

  assert.strictEqual(report.calibrationDriftState, 'alert');
  assert.strictEqual(report.regimeCalibrationAlert.length >= 2, true);
  assert.strictEqual(report.archetypeCalibrationAlert.length >= 2, true);
  assert.strictEqual(
    report.regimeCalibrationAlert[0]?.contextValue,
    'trend_burst',
  );
  assert.strictEqual(
    report.regimeCalibrationAlert[0]?.calibrationDriftState,
    'alert',
  );
  assert.strictEqual(
    report.driftReasonCodes.includes('overprediction_drift'),
    true,
  );
}

async function testP23ValidationProducesCalibrationDriftAlerts(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'item12-p23-'));
  const payload = await runP23Validation({
    mode: 'synthetic_smoke',
    allowSyntheticSmoke: true,
    evidenceDir: path.join(rootDir, 'evidence'),
    now: new Date('2026-03-26T00:00:00.000Z'),
  });

  assert.ok(payload.calibrationDriftAlerts);
  assert.strictEqual(
    typeof payload.calibrationDriftAlerts.calibrationDriftState === 'string',
    true,
  );
  assert.strictEqual(
    Array.isArray(payload.calibrationDriftAlerts.regimeCalibrationAlert),
    true,
  );
  assert.strictEqual(
    Array.isArray(payload.calibrationDriftAlerts.archetypeCalibrationAlert),
    true,
  );
  assert.strictEqual(
    Array.isArray(payload.calibrationDriftAlerts.driftReasonCodes),
    true,
  );
}

async function testDailyReviewPersistsCalibrationDriftAlerts(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'item12-daily-review-'));
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
          realizedEv: -0.02,
          regime: 'trend_burst',
          capturedAt: new Date('2026-03-26T00:01:00.000Z'),
        },
        {
          orderId: 'order-2',
          strategyVersionId: 'strategyA',
          expectedEv: 0.04,
          realizedEv: -0.01,
          regime: 'trend_burst',
          capturedAt: new Date('2026-03-26T00:02:00.000Z'),
        },
        {
          orderId: 'order-3',
          strategyVersionId: 'strategyA',
          expectedEv: 0.03,
          realizedEv: -0.015,
          regime: 'trend_burst',
          capturedAt: new Date('2026-03-26T00:03:00.000Z'),
        },
        {
          orderId: 'order-4',
          strategyVersionId: 'strategyA',
          expectedEv: 0.06,
          realizedEv: -0.025,
          regime: 'trend_burst',
          capturedAt: new Date('2026-03-26T00:04:00.000Z'),
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
            posteriorProbability: 0.8,
            marketImpliedProb: 0.56,
            edge: 0.07,
            expectedEv: 0.05,
            observedAt: new Date('2026-03-26T00:00:00.000Z'),
          },
        },
        {
          id: 'order-2',
          strategyVersionId: 'strategyA',
          signal: {
            id: 'signal-2',
            strategyVersionId: 'strategyA',
            regime: 'trend_burst',
            posteriorProbability: 0.77,
            marketImpliedProb: 0.55,
            edge: 0.05,
            expectedEv: 0.04,
            observedAt: new Date('2026-03-26T00:00:30.000Z'),
          },
        },
        {
          id: 'order-3',
          strategyVersionId: 'strategyA',
          signal: {
            id: 'signal-3',
            strategyVersionId: 'strategyA',
            regime: 'trend_burst',
            posteriorProbability: 0.79,
            marketImpliedProb: 0.57,
            edge: 0.04,
            expectedEv: 0.03,
            observedAt: new Date('2026-03-26T00:01:00.000Z'),
          },
        },
        {
          id: 'order-4',
          strategyVersionId: 'strategyA',
          signal: {
            id: 'signal-4',
            strategyVersionId: 'strategyA',
            regime: 'trend_burst',
            posteriorProbability: 0.83,
            marketImpliedProb: 0.58,
            edge: 0.06,
            expectedEv: 0.06,
            observedAt: new Date('2026-03-26T00:01:30.000Z'),
          },
        },
      ],
    },
    orderbook: {
      findFirst: async () => ({
        spread: 0.02,
        observedAt: new Date('2026-03-26T00:00:00.000Z'),
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
              createdAt: new Date('2026-03-26T00:00:03.000Z'),
              metadata: {
                retainedEdgeExpectation: {
                  marketArchetype: 'trend_follow_through',
                },
              },
            },
            {
              orderId: 'order-2',
              eventType: 'order.submitted',
              createdAt: new Date('2026-03-26T00:00:33.000Z'),
              metadata: {
                retainedEdgeExpectation: {
                  marketArchetype: 'trend_follow_through',
                },
              },
            },
            {
              orderId: 'order-3',
              eventType: 'order.submitted',
              createdAt: new Date('2026-03-26T00:01:03.000Z'),
              metadata: {
                retainedEdgeExpectation: {
                  marketArchetype: 'trend_follow_through',
                },
              },
            },
            {
              orderId: 'order-4',
              eventType: 'order.submitted',
              createdAt: new Date('2026-03-26T00:01:33.000Z'),
              metadata: {
                retainedEdgeExpectation: {
                  marketArchetype: 'trend_follow_through',
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
    now: new Date('2026-03-26T00:10:00.000Z'),
  });

  const reviewEvent = createdAuditEvents.find(
    (event) => event.eventType === 'learning.calibration_drift_alert_review',
  );
  assert.ok(reviewEvent);
  const metadata =
    reviewEvent && typeof reviewEvent.metadata === 'object'
      ? (reviewEvent.metadata as Record<string, unknown>)
      : null;
  assert.strictEqual(metadata?.calibrationDriftState, 'alert');
  assert.strictEqual(Array.isArray(metadata?.regimeCalibrationAlert), true);
  assert.strictEqual(Array.isArray(metadata?.archetypeCalibrationAlert), true);

  const savedState = await learningStateStore.load();
  const reviewOutputs =
    savedState.lastCycleSummary?.reviewOutputs &&
    typeof savedState.lastCycleSummary.reviewOutputs === 'object'
      ? (savedState.lastCycleSummary.reviewOutputs as Record<string, unknown>)
      : null;
  const calibrationDriftAlerts =
    reviewOutputs?.calibrationDriftAlerts &&
    typeof reviewOutputs.calibrationDriftAlerts === 'object'
      ? (reviewOutputs.calibrationDriftAlerts as Record<string, unknown>)
      : null;
  assert.ok(calibrationDriftAlerts);
  assert.strictEqual(calibrationDriftAlerts?.calibrationDriftState, 'alert');
}

async function testLearningStateStoreCompactsCalibrationDriftAlerts(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'item12-learning-state-'));
  const store = new LearningStateStore(rootDir);
  const state = createDefaultLearningState(new Date('2026-03-26T00:00:00.000Z'));
  state.lastCycleSummary = {
    cycleId: 'cycle-1',
    startedAt: '2026-03-26T00:00:00.000Z',
    completedAt: '2026-03-26T00:10:00.000Z',
    status: 'completed',
    analyzedWindow: {
      from: '2026-03-26T00:00:00.000Z',
      to: '2026-03-26T00:10:00.000Z',
    },
    realizedOutcomeCount: 10,
    attributionSliceCount: 10,
    calibrationUpdates: 1,
    shrinkageActions: 0,
    degradedContexts: [],
    warnings: [],
    errors: [],
    reviewOutputs: {
      calibrationDriftAlerts: {
        generatedAt: '2026-03-26T00:10:00.000Z',
        sampleCount: 16,
        calibrationDriftState: 'alert',
        regimeCalibrationAlert: Array.from({ length: 18 }, (_, index) => ({
          contextType: 'regime',
          contextValue: `regime-${index}`,
          sampleCount: 4,
          averagePredictedProbability: 0.76,
          realizedOutcomeRate: 0.2,
          averageCalibrationGap: -0.56,
          absoluteCalibrationGap: 0.56,
          calibrationDriftState: 'alert',
          driftReasonCodes: ['absolute_gap_alert', 'overprediction_drift'],
        })),
        archetypeCalibrationAlert: Array.from({ length: 18 }, (_, index) => ({
          contextType: 'archetype',
          contextValue: `archetype-${index}`,
          sampleCount: 4,
          averagePredictedProbability: 0.76,
          realizedOutcomeRate: 0.2,
          averageCalibrationGap: -0.56,
          absoluteCalibrationGap: 0.56,
          calibrationDriftState: 'alert',
          driftReasonCodes: ['absolute_gap_alert', 'overprediction_drift'],
        })),
        driftReasonCodes: Array.from({ length: 20 }, (_, index) => `reason-${index}`),
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
  const calibrationDriftAlerts =
    reviewOutputs?.calibrationDriftAlerts &&
    typeof reviewOutputs.calibrationDriftAlerts === 'object'
      ? (reviewOutputs.calibrationDriftAlerts as Record<string, unknown>)
      : null;

  assert.ok(calibrationDriftAlerts);
  assert.strictEqual(
    Array.isArray(calibrationDriftAlerts?.regimeCalibrationAlert) &&
      (calibrationDriftAlerts?.regimeCalibrationAlert as unknown[]).length === 12,
    true,
  );
  assert.strictEqual(
    Array.isArray(calibrationDriftAlerts?.driftReasonCodes) &&
      (calibrationDriftAlerts?.driftReasonCodes as unknown[]).length === 12,
    true,
  );
}

export const itemTwelveCalibrationDriftAlertTests = [
  {
    name: 'item12 calibration drift alerts detect thresholded regime and archetype drift',
    fn: testCalibrationDriftAlertsThresholdBehavior,
  },
  {
    name: 'item12 p23 validation emits calibration drift alerts',
    fn: testP23ValidationProducesCalibrationDriftAlerts,
  },
  {
    name: 'item12 daily review persists calibration drift alerts',
    fn: testDailyReviewPersistsCalibrationDriftAlerts,
  },
  {
    name: 'item12 learning state store compacts calibration drift alerts',
    fn: testLearningStateStoreCompactsCalibrationDriftAlerts,
  },
];
