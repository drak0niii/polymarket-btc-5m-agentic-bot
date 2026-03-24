import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DailyReviewJob } from '../jobs/dailyReview.job';
import { LearningEventLog } from '../runtime/learning-event-log';
import { LearningStateStore } from '../runtime/learning-state-store';

async function testLearningCycleStatePersistenceAndConfidenceReduction(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave5-learning-cycle-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const learningEventLog = new LearningEventLog(rootDir);

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
          realizedEv: -0.03,
          realizedSlippage: 0.007,
          fillRate: 0.5,
          regime: 'trend_burst',
          capturedAt: new Date('2026-03-24T00:01:00.000Z'),
          staleOrder: true,
        },
      ],
    },
    order: {
      findMany: async () => [
        {
          id: 'order-1',
          marketId: 'market-1',
          tokenId: 'yes-1',
          side: 'BUY',
          status: 'canceled',
          strategyVersionId: 'strategyA',
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          postedAt: new Date('2026-03-24T00:00:01.000Z'),
          acknowledgedAt: new Date('2026-03-24T00:00:03.000Z'),
          canceledAt: new Date('2026-03-24T00:00:30.000Z'),
          filledSize: 1,
          remainingSize: 3,
          size: 4,
          signal: {
            id: 'signal-1',
            marketId: 'market-1',
            strategyVersionId: 'strategyA',
            posteriorProbability: 0.74,
            expectedEv: 0.05,
            regime: 'trend_burst',
            observedAt: new Date('2026-03-24T00:00:00.000Z'),
          },
          market: {
            id: 'market-1',
            expiresAt: new Date('2026-03-24T00:10:00.000Z'),
          },
        },
      ],
    },
    orderbook: {
      findFirst: async () => ({
        spread: 0.05,
        observedAt: new Date('2026-03-24T00:00:00.000Z'),
        askLevels: [{ price: 0.52, size: 8 }],
        bidLevels: [{ price: 0.5, size: 5 }],
      }),
    },
    fill: {
      findMany: async () => [
        {
          orderId: 'order-1',
          filledAt: new Date('2026-03-24T00:00:10.000Z'),
          createdAt: new Date('2026-03-24T00:00:12.000Z'),
        },
      ],
    },
    auditEvent: {
      findMany: async () => [
        {
          orderId: 'order-1',
          eventType: 'order.submitted',
          createdAt: new Date('2026-03-24T00:00:03.000Z'),
          metadata: {
            route: 'maker',
            executionStyle: 'rest',
          },
        },
        {
          orderId: 'order-1',
          eventType: 'order.cancel_requested',
          createdAt: new Date('2026-03-24T00:00:20.000Z'),
          metadata: {},
        },
      ],
    },
  };

  const job = new DailyReviewJob(
    prisma as never,
    learningStateStore,
    learningEventLog,
  );
  const summary = await job.run({
    force: true,
    now: new Date('2026-03-24T00:10:00.000Z'),
  });

  const persistedState = await new LearningStateStore(rootDir).load();
  const recentEvents = await learningEventLog.readLatest(20);

  assert.strictEqual(summary.status !== 'failed', true);
  assert.strictEqual(summary.realizedOutcomeCount, 1);
  assert.strictEqual(summary.shrinkageActions >= 1, true);
  assert.ok(persistedState.lastCycleSummary);
  assert.strictEqual(
    Object.values(persistedState.calibration).some((calibration) => calibration.shrinkageFactor < 1),
    true,
  );
  assert.strictEqual(
    recentEvents.some((event) => event.type === 'learning_cycle_completed'),
    true,
  );
}

export const waveFiveLearningCycleIntegrationTests = [
  {
    name: 'wave5 learning cycle persists state and reduces confidence',
    fn: testLearningCycleStatePersistenceAndConfidenceReduction,
  },
];
