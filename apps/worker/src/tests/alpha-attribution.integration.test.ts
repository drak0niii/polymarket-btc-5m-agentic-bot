import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createAlphaAttribution } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { DailyReviewJob } from '../jobs/dailyReview.job';
import { LearningEventLog } from '../runtime/learning-event-log';
import { LearningStateStore } from '../runtime/learning-state-store';

async function testAlphaAttributionPositiveEdge(): Promise<void> {
  const attribution = createAlphaAttribution({
    rawForecastProbability: 0.64,
    marketImpliedProbability: 0.56,
    confidenceAdjustedEdge: 0.06,
    paperEdge: 0.055,
    expectedExecutionCost: {
      feeCost: 0.004,
      slippageCost: 0.003,
      adverseSelectionCost: 0.002,
    },
    expectedNetEdge: 0.046,
    capturedAt: '2026-03-25T00:00:00.000Z',
  });

  assert.strictEqual(Math.abs(attribution.rawForecastEdge - 0.08) < 1e-9, true);
  assert.strictEqual(Math.abs(attribution.confidenceAdjustedEdge - 0.06) < 1e-9, true);
  assert.strictEqual(Math.abs(attribution.paperEdge - 0.055) < 1e-9, true);
  assert.strictEqual(Math.abs(attribution.expectedNetEdge - 0.046) < 1e-9, true);
  assert.strictEqual(attribution.retentionRatio, null);
}

async function testAlphaAttributionNegativeEdge(): Promise<void> {
  const attribution = createAlphaAttribution({
    rawForecastProbability: 0.39,
    marketImpliedProbability: 0.52,
    confidenceAdjustedEdge: -0.09,
    paperEdge: -0.08,
    expectedExecutionCost: {
      feeCost: 0.004,
      slippageCost: 0.003,
      adverseSelectionCost: 0.002,
    },
    expectedNetEdge: -0.089,
    realizedExecutionCost: {
      feeCost: 0.004,
      slippageCost: 0.004,
      adverseSelectionCost: 0.003,
    },
    realizedNetEdge: -0.094,
    capturedAt: '2026-03-25T00:00:00.000Z',
  });

  assert.strictEqual(attribution.rawForecastEdge, -0.13);
  assert.strictEqual(attribution.expectedNetEdge < 0, true);
  assert.strictEqual(attribution.realizedNetEdge! < 0, true);
  assert.strictEqual(attribution.retentionRatio! > 0, true);
}

async function testAlphaAttributionNearZeroEdge(): Promise<void> {
  const attribution = createAlphaAttribution({
    rawForecastProbability: 0.5001,
    marketImpliedProbability: 0.5,
    expectedExecutionCost: {
      feeCost: 0,
      slippageCost: 0,
      adverseSelectionCost: 0,
    },
    expectedNetEdge: 0,
    realizedExecutionCost: {
      feeCost: 0,
      slippageCost: 0,
      adverseSelectionCost: 0,
    },
    realizedNetEdge: 0,
    capturedAt: '2026-03-25T00:00:00.000Z',
  });

  assert.strictEqual(attribution.rawForecastEdge > 0, true);
  assert.strictEqual(attribution.expectedNetEdge, 0);
  assert.strictEqual(attribution.realizedNetEdge, 0);
  assert.strictEqual(attribution.retentionRatio, 1);
}

async function testAlphaAttributionCostDominantScenario(): Promise<void> {
  const attribution = createAlphaAttribution({
    rawForecastProbability: 0.58,
    marketImpliedProbability: 0.52,
    confidenceAdjustedEdge: 0.03,
    paperEdge: 0.02,
    expectedExecutionCost: {
      feeCost: 0.005,
      slippageCost: 0.008,
      adverseSelectionCost: 0.006,
      fillDecayCost: 0.004,
    },
    capturedAt: '2026-03-25T00:00:00.000Z',
  });

  assert.strictEqual(attribution.expectedExecutionCost.totalCost > attribution.paperEdge, true);
  assert.strictEqual(attribution.expectedNetEdge < 0, true);
}

async function testAlphaAttributionRetentionRatioEdgeCases(): Promise<void> {
  const noExpectedEdge = createAlphaAttribution({
    rawForecastProbability: 0.6,
    marketImpliedProbability: 0.5,
    expectedNetEdge: 0,
    realizedNetEdge: 0.01,
    capturedAt: '2026-03-25T00:00:00.000Z',
  });
  const zeroPair = createAlphaAttribution({
    rawForecastProbability: 0.6,
    marketImpliedProbability: 0.5,
    expectedNetEdge: 0,
    realizedNetEdge: 0,
    capturedAt: '2026-03-25T00:00:00.000Z',
  });

  assert.strictEqual(noExpectedEdge.retentionRatio, null);
  assert.strictEqual(zeroPair.retentionRatio, 1);
}

async function testDailyReviewPersistsAlphaAttributionSummary(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-alpha-review-'));
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
      ],
    },
    order: {
      findMany: async () => [
        {
          id: 'order-1',
          marketId: 'market-1',
          tokenId: 'yes-1',
          side: 'BUY',
          status: 'filled',
          strategyVersionId: 'strategyA',
          createdAt: new Date('2026-03-25T00:00:00.000Z'),
          postedAt: new Date('2026-03-25T00:00:01.000Z'),
          acknowledgedAt: new Date('2026-03-25T00:00:03.000Z'),
          filledSize: 1,
          remainingSize: 0,
          size: 1,
          price: 0.55,
          signal: {
            id: 'signal-1',
            marketId: 'market-1',
            strategyVersionId: 'strategyA',
            posteriorProbability: 0.68,
            marketImpliedProb: 0.56,
            edge: 0.07,
            expectedEv: 0.05,
            regime: 'trend_burst',
            observedAt: new Date('2026-03-25T00:00:00.000Z'),
          },
          market: {
            id: 'market-1',
            expiresAt: new Date('2026-03-25T00:10:00.000Z'),
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
      findMany: async () => [
        {
          orderId: 'order-1',
          eventType: 'order.submitted',
          createdAt: new Date('2026-03-25T00:00:03.000Z'),
          metadata: {
            route: 'maker',
            executionStyle: 'rest',
          },
        },
      ],
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

  const alphaReviewEvent = createdAuditEvents.find(
    (event) => event.eventType === 'learning.alpha_attribution_review',
  );
  assert.ok(alphaReviewEvent);
  const metadata =
    alphaReviewEvent && typeof alphaReviewEvent.metadata === 'object'
      ? (alphaReviewEvent.metadata as Record<string, unknown>)
      : null;
  assert.ok(metadata);
  assert.strictEqual(metadata?.sampleCount, 1);
  assert.strictEqual(Array.isArray(metadata?.recentAlphaAttributions), true);
}

export const phaseOneAlphaAttributionTests = [
  {
    name: 'phase1 alpha attribution handles positive edge',
    fn: testAlphaAttributionPositiveEdge,
  },
  {
    name: 'phase1 alpha attribution handles negative edge',
    fn: testAlphaAttributionNegativeEdge,
  },
  {
    name: 'phase1 alpha attribution handles near-zero edge',
    fn: testAlphaAttributionNearZeroEdge,
  },
  {
    name: 'phase1 alpha attribution handles cost-dominant scenarios',
    fn: testAlphaAttributionCostDominantScenario,
  },
  {
    name: 'phase1 alpha attribution handles retention ratio edge cases',
    fn: testAlphaAttributionRetentionRatioEdgeCases,
  },
  {
    name: 'phase1 daily review persists alpha attribution summary',
    fn: testDailyReviewPersistsAlphaAttributionSummary,
  },
];
