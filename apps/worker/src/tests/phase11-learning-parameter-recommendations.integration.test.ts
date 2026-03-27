import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ResolvedTradeRecord } from '@polymarket-btc-5m-agentic-bot/domain';
import { DailyReviewJob } from '../jobs/dailyReview.job';
import { LearningEventLog } from '../runtime/learning-event-log';
import { LearningStateStore } from '../runtime/learning-state-store';
import { ResolvedTradeLedger } from '../runtime/resolved-trade-ledger';

async function testDailyLearningCycleGeneratesBoundedParameterRecommendationsFromResolvedTradeLedger(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase11-learning-parameter-recs-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const learningEventLog = new LearningEventLog(rootDir);
  const resolvedTradeLedger = new ResolvedTradeLedger(rootDir);

  const resolvedTrades = [
    buildResolvedTradeRecord({
      orderId: 'order-rec-1',
      strategyVariantId: 'variant:rec',
      strategyVersion: 'strategy-rec',
      regime: 'trend_burst',
      expectedNetEdgeBps: 120,
      realizedNetEdgeBps: -15,
      realizedPnl: -4,
      finalizedTimestamp: '2026-03-29T00:02:00.000Z',
    }),
    buildResolvedTradeRecord({
      orderId: 'order-rec-2',
      strategyVariantId: 'variant:rec',
      strategyVersion: 'strategy-rec',
      regime: 'trend_burst',
      expectedNetEdgeBps: 110,
      realizedNetEdgeBps: -5,
      realizedPnl: -2,
      finalizedTimestamp: '2026-03-29T00:04:00.000Z',
    }),
    buildResolvedTradeRecord({
      orderId: 'order-rec-3',
      strategyVariantId: 'variant:rec',
      strategyVersion: 'strategy-rec',
      regime: 'balanced_rotation',
      expectedNetEdgeBps: 90,
      realizedNetEdgeBps: -8,
      realizedPnl: -1.5,
      finalizedTimestamp: '2026-03-29T00:06:00.000Z',
    }),
  ];
  for (const trade of resolvedTrades) {
    await resolvedTradeLedger.append(trade);
  }

  const prisma = buildPrismaFixture({
    orderIds: resolvedTrades.map((trade) => trade.orderId),
    diagnostics: [],
  });

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
    now: new Date('2026-03-29T00:10:00.000Z'),
  });

  const reviewOutputs =
    summary.reviewOutputs && typeof summary.reviewOutputs === 'object'
      ? (summary.reviewOutputs as Record<string, unknown>)
      : null;
  const boundedRecommendations =
    reviewOutputs?.boundedParameterRecommendations &&
    typeof reviewOutputs.boundedParameterRecommendations === 'object'
      ? (reviewOutputs.boundedParameterRecommendations as Record<string, unknown>)
      : null;
  const changeSet = Array.isArray(boundedRecommendations?.changeSet)
    ? (boundedRecommendations?.changeSet as Array<Record<string, unknown>>)
    : [];
  const parameters = changeSet
    .map((entry) => String(entry.parameter ?? ''))
    .filter((value) => value.length > 0)
    .sort();

  assert.deepStrictEqual(parameters, [
    'entry_threshold_bps',
    'regime_confidence_threshold',
    'size_multiplier_band_max',
  ]);
  assert.strictEqual(
    ((boundedRecommendations?.evidenceRefs as Array<Record<string, unknown>> | undefined)?.[0]
      ?.source ??
      null) === 'resolved_trade_ledger',
    true,
  );
  assert.strictEqual(
    ((boundedRecommendations?.payload as Record<string, unknown> | undefined)?.draftOnly ?? null) ===
      true,
    true,
  );

  const events = await learningEventLog.readLatest(20, {
    types: ['learning_parameter_recommendations_generated'],
  });
  const recommendationEvent = events.at(-1);

  assert.ok(recommendationEvent);
  assert.strictEqual(recommendationEvent?.type, 'learning_parameter_recommendations_generated');
  assert.deepStrictEqual(
    ((recommendationEvent?.details.changeSet as Array<Record<string, unknown>> | undefined) ?? [])
      .map((entry) => String(entry.parameter ?? ''))
      .sort(),
    parameters,
  );
}

async function testDailyLearningCycleBlocksBoundedParameterRecommendationsForFallbackSamples(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase11-learning-parameter-fallback-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const learningEventLog = new LearningEventLog(rootDir);
  const resolvedTradeLedger = new ResolvedTradeLedger(rootDir);
  const diagnostics = [
    buildExecutionDiagnostic('order-fallback-1', 'strategy-fallback', -0.01, '2026-03-30T00:02:00.000Z'),
    buildExecutionDiagnostic('order-fallback-2', 'strategy-fallback', -0.015, '2026-03-30T00:04:00.000Z'),
    buildExecutionDiagnostic('order-fallback-3', 'strategy-fallback', -0.02, '2026-03-30T00:06:00.000Z'),
  ];
  const prisma = buildPrismaFixture({
    orderIds: diagnostics.map((diagnostic) => String(diagnostic.orderId ?? '')),
    diagnostics,
  });

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
    now: new Date('2026-03-30T00:10:00.000Z'),
  });

  const reviewOutputs =
    summary.reviewOutputs && typeof summary.reviewOutputs === 'object'
      ? (summary.reviewOutputs as Record<string, unknown>)
      : null;
  const boundedRecommendations =
    reviewOutputs?.boundedParameterRecommendations &&
    typeof reviewOutputs.boundedParameterRecommendations === 'object'
      ? (reviewOutputs.boundedParameterRecommendations as Record<string, unknown>)
      : null;
  const changeSet = Array.isArray(boundedRecommendations?.changeSet)
    ? (boundedRecommendations?.changeSet as Array<Record<string, unknown>>)
    : [];
  const warnings = Array.isArray(boundedRecommendations?.warnings)
    ? (boundedRecommendations?.warnings as Array<string>)
    : [];

  assert.strictEqual(changeSet.length, 0);
  assert.strictEqual(
    warnings.includes('bounded_parameter_recommendations_require_resolved_trade_ledger'),
    true,
  );
  assert.strictEqual(summary.warnings.includes('bounded_parameter_recommendations_require_resolved_trade_ledger'), true);

  const events = await learningEventLog.readLatest(20, {
    types: ['learning_parameter_recommendations_generated'],
  });
  const recommendationEvent = events.at(-1);

  assert.ok(recommendationEvent);
  assert.strictEqual(recommendationEvent?.details.changeSet instanceof Array, true);
  assert.strictEqual(
    (((recommendationEvent?.details.payload as Record<string, unknown> | undefined)?.blocked as
      | boolean
      | undefined) ??
      false) === true,
    true,
  );
}

function buildPrismaFixture(input: {
  orderIds: string[];
  diagnostics: Array<Record<string, unknown>>;
}) {
  return {
    strategyVersion: {
      findMany: async () => [],
    },
    executionDiagnostic: {
      findMany: async () => input.diagnostics,
    },
    order: {
      findMany: async () =>
        input.orderIds.map((orderId, index) => ({
          id: orderId,
          marketId: `market-${index + 1}`,
          tokenId: `token-${index + 1}`,
          side: 'BUY',
          status: 'filled',
          strategyVersionId: orderId.includes('fallback') ? 'strategy-fallback' : 'strategy-rec',
          createdAt: new Date(`2026-03-${29 + Number(orderId.includes('fallback'))}T00:00:00.000Z`),
          acknowledgedAt: new Date(`2026-03-${29 + Number(orderId.includes('fallback'))}T00:00:05.000Z`),
          signal: {
            id: `signal-${orderId}`,
            marketId: `market-${index + 1}`,
            strategyVersionId: orderId.includes('fallback') ? 'strategy-fallback' : 'strategy-rec',
            posteriorProbability: 0.68,
            expectedEv: 0.03,
            regime: index % 2 === 0 ? 'trend_burst' : 'balanced_rotation',
            observedAt: new Date(`2026-03-${29 + Number(orderId.includes('fallback'))}T00:00:00.000Z`),
          },
          market: {
            id: `market-${index + 1}`,
            expiresAt: new Date(`2026-03-${29 + Number(orderId.includes('fallback'))}T01:00:00.000Z`),
          },
        })),
    },
    orderbook: {
      findFirst: async () => ({
        spread: 0.04,
        askLevels: [{ price: 0.54, size: 10 }],
        bidLevels: [{ price: 0.5, size: 9 }],
      }),
    },
    auditEvent: {
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => data,
    },
  };
}

function buildExecutionDiagnostic(
  orderId: string,
  strategyVersionId: string,
  realizedEv: number,
  capturedAt: string,
): Record<string, unknown> {
  return {
    orderId,
    strategyVersionId,
    expectedEv: 0.03,
    realizedEv,
    fillRate: 0.5,
    realizedSlippage: 0.0015,
    regime: 'trend_burst',
    capturedAt: new Date(capturedAt),
  };
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
    decisionTimestamp: input.decisionTimestamp ?? '2026-03-29T00:00:00.000Z',
    submissionTimestamp: input.submissionTimestamp ?? '2026-03-29T00:00:05.000Z',
    firstFillTimestamp: input.firstFillTimestamp ?? '2026-03-29T00:00:10.000Z',
    finalizedTimestamp: input.finalizedTimestamp,
    side: input.side ?? 'BUY',
    intendedPrice: input.intendedPrice ?? 0.5,
    averageFillPrice: input.averageFillPrice ?? 0.52,
    size: input.size ?? 5,
    notional: input.notional ?? 2.6,
    estimatedFeeAtDecision: input.estimatedFeeAtDecision ?? 0.01,
    realizedFee: input.realizedFee ?? 0.01,
    estimatedSlippageBps: input.estimatedSlippageBps ?? 8,
    realizedSlippageBps: input.realizedSlippageBps ?? 10,
    queueDelayMs: input.queueDelayMs ?? 450,
    fillFraction: input.fillFraction ?? 0.6,
    expectedNetEdgeBps: input.expectedNetEdgeBps,
    realizedNetEdgeBps: input.realizedNetEdgeBps,
    maxFavorableExcursionBps: input.maxFavorableExcursionBps ?? 20,
    maxAdverseExcursionBps: input.maxAdverseExcursionBps ?? -18,
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
      realizedSlippageBps: input.realizedSlippageBps ?? 10,
      queueDelayMs: input.queueDelayMs ?? 450,
      fillFraction: input.fillFraction ?? 0.6,
    },
    netOutcome: input.netOutcome ?? {
      expectedNetEdgeBps: input.expectedNetEdgeBps,
      realizedNetEdgeBps: input.realizedNetEdgeBps,
      maxFavorableExcursionBps: input.maxFavorableExcursionBps ?? 20,
      maxAdverseExcursionBps: input.maxAdverseExcursionBps ?? -18,
      realizedPnl: input.realizedPnl,
    },
    capturedAt: input.capturedAt ?? input.finalizedTimestamp,
  };
}

export const phaseElevenLearningParameterRecommendationTests = [
  {
    name: 'phase11 bounded parameter recommendations use resolved-trade ledger evidence',
    fn: testDailyLearningCycleGeneratesBoundedParameterRecommendationsFromResolvedTradeLedger,
  },
  {
    name: 'phase11 bounded parameter recommendations block legacy fallback samples',
    fn: testDailyLearningCycleBlocksBoundedParameterRecommendationsForFallbackSamples,
  },
];
