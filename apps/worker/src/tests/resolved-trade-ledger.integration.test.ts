import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ResolvedTradeRecord } from '@polymarket-btc-5m-agentic-bot/domain';
import { LearningStateStore } from '../runtime/learning-state-store';
import { ResolvedTradeLedger } from '../runtime/resolved-trade-ledger';
import { ReconcileFillsJob } from '../jobs/reconcileFills.job';
import { RefreshPortfolioJob } from '../jobs/refreshPortfolio.job';

async function testResolvedTradeLedgerAppendAndQuery(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolved-trade-ledger-'));
  const ledger = new ResolvedTradeLedger(rootDir);
  const base = createResolvedTradeRecord({
    tradeId: 'resolved:o1',
    orderId: 'o1',
    finalizedTimestamp: '2026-03-27T10:05:00.000Z',
  });
  const next = createResolvedTradeRecord({
    tradeId: 'resolved:o2',
    orderId: 'o2',
    finalizedTimestamp: '2026-03-27T11:10:00.000Z',
  });

  const firstAppend = await ledger.append(base);
  const duplicateAppend = await ledger.append(base);
  await ledger.append(next);

  assert.strictEqual(firstAppend.appended, true);
  assert.strictEqual(duplicateAppend.appended, false);
  assert.strictEqual((await ledger.findByOrderId('o1'))?.tradeId, 'resolved:o1');
  assert.strictEqual((await ledger.loadRecent(1))[0]?.orderId, 'o2');

  const windowed = await ledger.loadWindow({
    start: '2026-03-27T10:00:00.000Z',
    end: '2026-03-27T10:30:00.000Z',
  });
  assert.deepStrictEqual(
    windowed.map((record) => record.orderId),
    ['o1'],
  );
}

async function testReconcileFillsWritesResolvedTradeAndAuditEvent(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolved-trade-reconcile-'));
  const ledger = new ResolvedTradeLedger(rootDir);
  const auditEvents: Array<Record<string, unknown>> = [
    {
      signalId: 's1',
      eventType: 'signal.admission_decision',
      metadata: {
        executableEdge: {
          finalNetEdge: 0.012,
        },
        phaseTwoContext: {
          marketArchetype: 'balanced_rotation',
        },
      },
      createdAt: new Date('2026-03-27T09:59:00.000Z'),
    },
    {
      orderId: 'o1',
      eventType: 'order.submitted',
      metadata: {
        alphaAttribution: {
          expectedExecutionCost: {
            feeCost: 0.004,
            slippageCost: 0.002,
          },
          expectedNetEdge: 0.011,
        },
        toxicity: {
          toxicityScore: 0.21,
        },
        benchmarkRelativeSizingDecision: {
          benchmarkComparisonState: 'neutral',
          baselinePenaltyMultiplier: 0.9,
          regimeBenchmarkGateState: 'blocked',
          benchmarkPenaltyReasonCodes: ['benchmark_context_mixed'],
        },
      },
      createdAt: new Date('2026-03-27T10:00:00.000Z'),
    },
  ];
  const fills: Array<Record<string, unknown>> = [];
  let diagnosticCreateCalls = 0;

  const prisma = {
    fill: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        fills.find((fill) => fill.id === where.id) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        fills.push({
          ...data,
        });
        return data;
      },
      findMany: async () => fills,
    },
    order: {
      findFirst: async () => ({
        id: 'o1',
        venueOrderId: 'venue-o1',
        marketId: 'm1',
        tokenId: 'yes1',
        signalId: 's1',
        strategyVersionId: 'sv1',
        side: 'BUY',
        size: 10,
        price: 0.5,
        expectedEv: 0.08,
        filledSize: 0,
        remainingSize: 10,
        avgFillPrice: null,
        lastVenueStatus: null,
        lastVenueSyncAt: null,
        createdAt: new Date('2026-03-27T10:00:00.000Z'),
        postedAt: new Date('2026-03-27T10:00:10.000Z'),
        acknowledgedAt: null,
      }),
      findMany: async () => [],
      update: async () => null,
    },
    signal: {
      findUnique: async () => ({
        id: 's1',
        regime: 'balanced_rotation',
        observedAt: new Date('2026-03-27T09:59:30.000Z'),
        createdAt: new Date('2026-03-27T09:59:35.000Z'),
      }),
    },
    executionDiagnostic: {
      create: async () => {
        diagnosticCreateCalls += 1;
      },
    },
    auditEvent: {
      findFirst: async ({
        where,
      }: {
        where: { signalId?: string; orderId?: string; eventType: string };
      }) =>
        auditEvents
          .filter((event) => {
            if (where.eventType !== event.eventType) {
              return false;
            }
            if (where.signalId && where.signalId !== event.signalId) {
              return false;
            }
            if (where.orderId && where.orderId !== event.orderId) {
              return false;
            }
            return true;
          })
          .at(-1) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        auditEvents.push(data);
        return data;
      },
    },
  };

  const runtimeControl = {
    recordReconciliationCheckpoint: async () => null,
  };

  const job = new ReconcileFillsJob(prisma as never, runtimeControl as never);
  (job as any).resolvedTradeLedger = ledger;
  (job as any).fetchVenueTrades = async () => ({
    ok: true,
    trades: [
      {
        id: 't1',
        orderId: 'o1',
        price: 0.53,
        size: 10,
        fee: 0.01,
        filledAt: '2026-03-27T10:00:20.000Z',
      },
    ],
  });

  const result = await job.run();
  const resolved = await ledger.findByOrderId('o1');

  assert.strictEqual(result.fillsInserted, 1);
  assert.strictEqual(diagnosticCreateCalls, 1);
  assert.ok(resolved);
  assert.strictEqual(resolved?.tokenId, 'yes1');
  assert.strictEqual(resolved?.strategyVariantId, 'variant:sv1');
  assert.strictEqual(resolved?.archetype, 'balanced_rotation');
  assert.strictEqual(resolved?.lifecycleState, 'economically_resolved');
  assert.strictEqual(
    auditEvents.some((event) => event.eventType === 'trade.resolved'),
    true,
  );
}

async function testRefreshPortfolioStoresResolvedTradePointer(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolved-trade-pointer-'));
  const ledger = new ResolvedTradeLedger(rootDir);
  await ledger.append(
    createResolvedTradeRecord({
      tradeId: 'resolved:o9',
      orderId: 'o9',
      finalizedTimestamp: '2026-03-27T12:00:00.000Z',
    }),
  );

  const prisma = {
    fill: {
      findMany: async () => [],
    },
    market: {
      findMany: async () => [],
    },
    marketSnapshot: {
      findMany: async () => [],
    },
    orderbook: {
      findMany: async () => [],
    },
    position: {
      findMany: async () => [],
    },
    portfolioSnapshot: {
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
        id: where.id,
        ...data,
      }),
    },
  };

  const job = new RefreshPortfolioJob(prisma as never);
  (job as any).resolvedTradeLedger = ledger;
  (job as any).learningStateStore = new LearningStateStore(rootDir);
  (job as any).externalPortfolioService = {
    capture: async () => ({
      snapshotId: 'snap-1',
      bankroll: 1000,
      availableCapital: 900,
      openOrderExposure: 0,
      capturedAt: '2026-03-27T12:01:00.000Z',
      freshness: { overallVerdict: 'fresh' },
      divergence: { status: 'aligned' },
      recovery: { mode: 'normal' },
      tradingPermissions: { allowNewEntries: true },
      reservedCash: 0,
      workingOpenOrders: [],
      inventories: [],
    }),
  };

  await job.run();

  const pointer = await (job as any).learningStateStore.loadResolvedTradePointer();
  assert.ok(pointer);
  assert.strictEqual(pointer?.lastResolvedTradeId, 'resolved:o9');
  assert.strictEqual(
    pointer?.resolvedTradeLedgerPath.endsWith('resolved-trades.jsonl'),
    true,
  );
}

function createResolvedTradeRecord(
  overrides: Partial<ResolvedTradeRecord>,
): ResolvedTradeRecord {
  return {
    tradeId: overrides.tradeId ?? 'resolved:o1',
    orderId: overrides.orderId ?? 'o1',
    venueOrderId: overrides.venueOrderId ?? 'venue-o1',
    marketId: overrides.marketId ?? 'm1',
    tokenId: overrides.tokenId ?? 'yes1',
    strategyVariantId: overrides.strategyVariantId ?? 'variant:sv1',
    strategyVersion: overrides.strategyVersion ?? 'sv1',
    regime: overrides.regime ?? 'balanced_rotation',
    archetype: overrides.archetype ?? 'balanced_rotation',
    decisionTimestamp: overrides.decisionTimestamp ?? '2026-03-27T10:00:00.000Z',
    submissionTimestamp: overrides.submissionTimestamp ?? '2026-03-27T10:00:05.000Z',
    firstFillTimestamp: overrides.firstFillTimestamp ?? '2026-03-27T10:00:10.000Z',
    finalizedTimestamp: overrides.finalizedTimestamp ?? '2026-03-27T10:01:00.000Z',
    side: overrides.side ?? 'BUY',
    intendedPrice: overrides.intendedPrice ?? 0.5,
    averageFillPrice: overrides.averageFillPrice ?? 0.51,
    size: overrides.size ?? 10,
    notional: overrides.notional ?? 5.1,
    estimatedFeeAtDecision: overrides.estimatedFeeAtDecision ?? 0.01,
    realizedFee: overrides.realizedFee ?? 0.012,
    estimatedSlippageBps: overrides.estimatedSlippageBps ?? 20,
    realizedSlippageBps: overrides.realizedSlippageBps ?? 24,
    queueDelayMs: overrides.queueDelayMs ?? 5_000,
    fillFraction: overrides.fillFraction ?? 1,
    expectedNetEdgeBps: overrides.expectedNetEdgeBps ?? 120,
    realizedNetEdgeBps: overrides.realizedNetEdgeBps ?? 88,
    maxFavorableExcursionBps: overrides.maxFavorableExcursionBps ?? null,
    maxAdverseExcursionBps: overrides.maxAdverseExcursionBps ?? null,
    toxicityScoreAtDecision: overrides.toxicityScoreAtDecision ?? 0.15,
    benchmarkContext: overrides.benchmarkContext ?? null,
    lossAttributionCategory: overrides.lossAttributionCategory ?? null,
    executionAttributionCategory: overrides.executionAttributionCategory ?? 'bad_execution',
    lifecycleState: overrides.lifecycleState ?? 'economically_resolved',
    attribution: overrides.attribution ?? {
      benchmarkContext: null,
      lossAttributionCategory: null,
      executionAttributionCategory: 'bad_execution',
      primaryLeakageDriver: 'slippage_materially_worse_than_expected',
      secondaryLeakageDrivers: [],
      reasonCodes: ['slippage_materially_worse_than_expected'],
    },
    executionQuality: overrides.executionQuality ?? {
      intendedPrice: 0.5,
      averageFillPrice: 0.51,
      size: 10,
      notional: 5.1,
      estimatedFeeAtDecision: 0.01,
      realizedFee: 0.012,
      estimatedSlippageBps: 20,
      realizedSlippageBps: 24,
      queueDelayMs: 5_000,
      fillFraction: 1,
    },
    netOutcome: overrides.netOutcome ?? {
      expectedNetEdgeBps: 120,
      realizedNetEdgeBps: 88,
      maxFavorableExcursionBps: null,
      maxAdverseExcursionBps: null,
      realizedPnl: null,
    },
    capturedAt: overrides.capturedAt ?? '2026-03-27T10:01:00.000Z',
  };
}

export const phaseOneResolvedTradeLedgerTests = [
  {
    name: 'resolved trade ledger appends and queries canonical records',
    fn: testResolvedTradeLedgerAppendAndQuery,
  },
  {
    name: 'reconcile fills writes resolved trade ledger and audit event',
    fn: testReconcileFillsWritesResolvedTradeAndAuditEvent,
  },
  {
    name: 'refresh portfolio stores resolved trade ledger pointer',
    fn: testRefreshPortfolioStoresResolvedTradePointer,
  },
];
