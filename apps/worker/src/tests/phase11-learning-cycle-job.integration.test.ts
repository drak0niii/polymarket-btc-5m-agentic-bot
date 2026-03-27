import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ResolvedTradeRecord } from '@polymarket-btc-5m-agentic-bot/domain';
import { DailyReviewJob } from '../jobs/dailyReview.job';
import { LearningEventLog } from '../runtime/learning-event-log';
import { LearningStateStore } from '../runtime/learning-state-store';
import { ResolvedTradeLedger } from '../runtime/resolved-trade-ledger';

async function testDailyLearningCycleUsesResolvedTradeLedgerAndPersistsArtifact(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase11-learning-cycle-job-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const learningEventLog = new LearningEventLog(rootDir);
  const resolvedTradeLedger = new ResolvedTradeLedger(rootDir);
  const auditCreates: Array<Record<string, unknown>> = [];
  await resolvedTradeLedger.append(
    buildResolvedTradeRecord({
      orderId: 'order-1',
      strategyVariantId: 'variant:strategyA',
      strategyVersion: 'strategyA',
      regime: 'trend_burst',
      expectedNetEdgeBps: 120,
      realizedNetEdgeBps: 80,
      realizedPnl: 18,
      finalizedTimestamp: '2026-03-27T00:05:00.000Z',
    }),
  );

  const prisma = {
    strategyVersion: {
      findMany: async () => [],
    },
    executionDiagnostic: {
      findMany: async () => [
        {
          orderId: 'order-1',
          strategyVersionId: 'strategyA',
          expectedEv: -0.02,
          realizedEv: -0.03,
          fillRate: 0.25,
          realizedSlippage: 0.01,
          regime: 'stale_diagnostic_regime',
          capturedAt: new Date('2026-03-27T00:04:00.000Z'),
        },
      ],
    },
    order: {
      findMany: async () => [
        {
          id: 'order-1',
          marketId: 'market-1',
          tokenId: 'yes1',
          side: 'BUY',
          status: 'filled',
          strategyVersionId: 'strategyA',
          createdAt: new Date('2026-03-27T00:00:00.000Z'),
          acknowledgedAt: new Date('2026-03-27T00:00:05.000Z'),
          signal: {
            id: 'signal-1',
            marketId: 'market-1',
            strategyVersionId: 'strategyA',
            posteriorProbability: 0.71,
            expectedEv: 0.03,
            regime: 'trend_burst',
            observedAt: new Date('2026-03-27T00:00:00.000Z'),
          },
          market: {
            id: 'market-1',
            expiresAt: new Date('2026-03-27T01:00:00.000Z'),
          },
        },
      ],
    },
    orderbook: {
      findFirst: async () => ({
        spread: 0.04,
        askLevels: [{ price: 0.53, size: 12 }],
        bidLevels: [{ price: 0.5, size: 9 }],
      }),
    },
    auditEvent: {
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        auditCreates.push(data);
        return data;
      },
    },
  };

  const job = new DailyReviewJob(
    prisma as never,
    learningStateStore,
    learningEventLog,
    undefined,
    undefined,
    undefined,
    resolvedTradeLedger,
  );
  const summary = await job.run({
    force: true,
    now: new Date('2026-03-27T00:10:00.000Z'),
  });

  const artifactPath = path.join(rootDir, 'learning-cycles', 'latest.json');
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;

  assert.strictEqual(summary.realizedOutcomeCount, 1);
  assert.strictEqual(
    ((artifact.sampleSourceSummary as Record<string, unknown>).sourceOfTruth ?? null) ===
      'resolved_trade_ledger',
    true,
  );
  assert.strictEqual(
    ((artifact.sampleSourceSummary as Record<string, unknown>).resolvedTradeCount ?? null) === 1,
    true,
  );
  assert.strictEqual(
    auditCreates.some((event) => event.eventType === 'learning.cycle_started'),
    true,
  );
  assert.strictEqual(
    auditCreates.some((event) => event.eventType === 'learning.cycle_completed'),
    true,
  );
}

async function testDailyLearningCycleCollapsesConcurrentRunsIntoSingleCycle(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase11-learning-cycle-lock-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const learningEventLog = new LearningEventLog(rootDir);
  const resolvedTradeLedger = new ResolvedTradeLedger(rootDir);
  await resolvedTradeLedger.append(
    buildResolvedTradeRecord({
      orderId: 'order-2',
      strategyVariantId: 'variant:strategyB',
      strategyVersion: 'strategyB',
      regime: 'balanced_rotation',
      expectedNetEdgeBps: 90,
      realizedNetEdgeBps: 45,
      realizedPnl: 9,
      finalizedTimestamp: '2026-03-28T00:05:00.000Z',
    }),
  );

  const prisma = {
    strategyVersion: {
      findMany: async () => [],
    },
    executionDiagnostic: {
      findMany: async () => [],
    },
    order: {
      findMany: async () => {
        await delay(40);
        return [
          {
            id: 'order-2',
            marketId: 'market-2',
            tokenId: 'yes2',
            side: 'BUY',
            status: 'filled',
            strategyVersionId: 'strategyB',
            createdAt: new Date('2026-03-28T00:00:00.000Z'),
            acknowledgedAt: new Date('2026-03-28T00:00:06.000Z'),
            signal: {
              id: 'signal-2',
              marketId: 'market-2',
              strategyVersionId: 'strategyB',
              posteriorProbability: 0.62,
              expectedEv: 0.02,
              regime: 'balanced_rotation',
              observedAt: new Date('2026-03-28T00:00:00.000Z'),
            },
            market: {
              id: 'market-2',
              expiresAt: new Date('2026-03-28T01:00:00.000Z'),
            },
          },
        ];
      },
    },
    orderbook: {
      findFirst: async () => ({
        spread: 0.03,
        askLevels: [{ price: 0.54, size: 10 }],
        bidLevels: [{ price: 0.51, size: 11 }],
      }),
    },
    auditEvent: {
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => data,
    },
  };

  const job = new DailyReviewJob(
    prisma as never,
    learningStateStore,
    learningEventLog,
    undefined,
    undefined,
    undefined,
    resolvedTradeLedger,
  );
  const now = new Date('2026-03-28T00:10:00.000Z');
  const [first, second] = await Promise.all([
    job.run({ force: true, now }),
    job.run({ force: true, now }),
  ]);
  const cycleEvents = await learningEventLog.readLatest(20, {
    cycleId: first.cycleId,
    types: ['learning_cycle_started', 'learning_cycle_completed'],
  });

  assert.strictEqual(first.cycleId, second.cycleId);
  assert.strictEqual(
    cycleEvents.filter((event) => event.type === 'learning_cycle_started').length,
    1,
  );
  assert.strictEqual(
    cycleEvents.filter((event) => event.type === 'learning_cycle_completed').length,
    1,
  );
}

function buildResolvedTradeRecord(
  input: Partial<ResolvedTradeRecord> & {
    orderId: string;
    strategyVariantId: string;
    strategyVersion: string;
    regime: string;
    expectedNetEdgeBps: number;
    realizedNetEdgeBps: number;
    realizedPnl: number;
    finalizedTimestamp: string;
  },
): ResolvedTradeRecord {
  return {
    tradeId: `resolved:${input.orderId}`,
    orderId: input.orderId,
    venueOrderId: `venue:${input.orderId}`,
    marketId: input.marketId ?? 'market-default',
    tokenId: input.tokenId ?? 'token-default',
    strategyVariantId: input.strategyVariantId,
    strategyVersion: input.strategyVersion,
    regime: input.regime,
    archetype: input.archetype ?? 'balanced_rotation',
    decisionTimestamp: input.decisionTimestamp ?? '2026-03-27T00:00:00.000Z',
    submissionTimestamp: input.submissionTimestamp ?? '2026-03-27T00:00:05.000Z',
    firstFillTimestamp: input.firstFillTimestamp ?? '2026-03-27T00:00:10.000Z',
    finalizedTimestamp: input.finalizedTimestamp,
    side: input.side ?? 'BUY',
    intendedPrice: input.intendedPrice ?? 0.5,
    averageFillPrice: input.averageFillPrice ?? 0.52,
    size: input.size ?? 5,
    notional: input.notional ?? 2.6,
    estimatedFeeAtDecision: input.estimatedFeeAtDecision ?? 0.01,
    realizedFee: input.realizedFee ?? 0.01,
    estimatedSlippageBps: input.estimatedSlippageBps ?? 8,
    realizedSlippageBps: input.realizedSlippageBps ?? 6,
    queueDelayMs: input.queueDelayMs ?? 450,
    fillFraction: input.fillFraction ?? 1,
    expectedNetEdgeBps: input.expectedNetEdgeBps,
    realizedNetEdgeBps: input.realizedNetEdgeBps,
    maxFavorableExcursionBps: input.maxFavorableExcursionBps ?? 30,
    maxAdverseExcursionBps: input.maxAdverseExcursionBps ?? -12,
    toxicityScoreAtDecision: input.toxicityScoreAtDecision ?? 0.18,
    benchmarkContext: input.benchmarkContext ?? null,
    lossAttributionCategory: input.lossAttributionCategory ?? null,
    executionAttributionCategory: input.executionAttributionCategory ?? null,
    lifecycleState: input.lifecycleState ?? 'economically_resolved',
    attribution: input.attribution ?? {
      benchmarkContext: null,
      lossAttributionCategory: null,
      executionAttributionCategory: null,
      primaryLeakageDriver: null,
      secondaryLeakageDrivers: [],
      reasonCodes: [],
    },
    executionQuality: input.executionQuality ?? {
      intendedPrice: input.intendedPrice ?? 0.5,
      averageFillPrice: input.averageFillPrice ?? 0.52,
      size: input.size ?? 5,
      notional: input.notional ?? 2.6,
      estimatedFeeAtDecision: input.estimatedFeeAtDecision ?? 0.01,
      realizedFee: input.realizedFee ?? 0.01,
      estimatedSlippageBps: input.estimatedSlippageBps ?? 8,
      realizedSlippageBps: input.realizedSlippageBps ?? 6,
      queueDelayMs: input.queueDelayMs ?? 450,
      fillFraction: input.fillFraction ?? 1,
    },
    netOutcome: input.netOutcome ?? {
      expectedNetEdgeBps: input.expectedNetEdgeBps,
      realizedNetEdgeBps: input.realizedNetEdgeBps,
      maxFavorableExcursionBps: input.maxFavorableExcursionBps ?? 30,
      maxAdverseExcursionBps: input.maxAdverseExcursionBps ?? -12,
      realizedPnl: input.realizedPnl,
    },
    capturedAt: input.capturedAt ?? input.finalizedTimestamp,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const phaseElevenLearningCycleJobTests = [
  {
    name: 'phase11 daily learning cycle uses resolved-trade ledger and persists artifact',
    fn: testDailyLearningCycleUsesResolvedTradeLedgerAndPersistsArtifact,
  },
  {
    name: 'phase11 daily learning cycle collapses concurrent runs into one cycle',
    fn: testDailyLearningCycleCollapsesConcurrentRunsIntoSingleCycle,
  },
];
