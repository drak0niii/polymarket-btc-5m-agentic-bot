import assert from 'assert';
import os from 'os';
import path from 'path';
import {
  RealizedVsExpectedEdgeStore,
} from '@polymarket-btc-5m-agentic-bot/execution-engine';
import type { ResolvedTradeRecord } from '@polymarket-btc-5m-agentic-bot/domain';
import {
  NetEdgeEstimator,
  buildNetRealismContext,
} from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { ResolvedTradeLedger } from '../runtime/resolved-trade-ledger';

async function testNetEdgeEstimatorReturnsPhaseTwoDecomposition(): Promise<void> {
  const estimator = new NetEdgeEstimator();
  const realismContext = buildNetRealismContext({
    spreadAtDecision: 0.018,
    bookDepthAtIntendedPrice: 42,
    expectedFillFraction: 0.68,
    expectedQueueDelayMs: 24_000,
    expectedPartialFillPenalty: 0.0012,
    expectedCancelReplacePenalty: 0.0008,
    venueUncertaintyLabel: 'degraded',
    feeScheduleLabel: 'fixture_fee_schedule',
    urgency: 'high',
    venueMode: 'size-reduced',
  });

  const decision = estimator.estimate({
    grossForecastEdge: 0.021,
    expectedEv: 0.018,
    feeRate: 0.005,
    spread: 0.018,
    signalAgeMs: 35_000,
    halfLifeMultiplier: 0.74,
    topLevelDepth: 42,
    estimatedOrderSizeUnits: 22,
    executionStyle: 'taker',
    calibrationHealth: 'degraded',
    calibrationShrinkageFactor: 0.84,
    calibrationSampleCount: 12,
    regimeHealth: 'degraded',
    venueUncertaintyLabel: 'degraded',
    venueMode: 'size-reduced',
    realismContext,
  });

  assert.strictEqual(decision.breakdown.grossEdgeBps > 0, true);
  assert.strictEqual(decision.breakdown.feeBps > 0, true);
  assert.strictEqual(decision.breakdown.slippageBps > 0, true);
  assert.strictEqual(decision.breakdown.adverseSelectionPenaltyBps > 0, true);
  assert.strictEqual(decision.breakdown.queuePenaltyBps > 0, true);
  assert.strictEqual(decision.breakdown.uncertaintyPenaltyBps > 0, true);
  assert.strictEqual(
    decision.breakdown.netEdgeBps <
      decision.breakdown.grossEdgeBps,
    true,
  );
  assert.strictEqual(decision.breakdown.costEstimate.queuePenaltyCost > 0, true);
  assert.strictEqual(decision.breakdown.afterQueueEdge < decision.breakdown.afterAdverseSelectionEdge, true);
}

async function testRealizedVsExpectedEdgeStoreComputesFromResolvedTradeLedger(): Promise<void> {
  const rootDir = path.join(os.tmpdir(), `phase2-edge-truth-${Date.now()}`);
  const ledger = new ResolvedTradeLedger(rootDir);
  await ledger.append(
    createResolvedTradeRecord({
      tradeId: 'trade-1',
      orderId: 'order-1',
      expectedNetEdgeBps: 120,
      realizedNetEdgeBps: 84,
      finalizedTimestamp: '2026-03-27T12:00:00.000Z',
    }),
  );
  await ledger.append(
    createResolvedTradeRecord({
      tradeId: 'trade-2',
      orderId: 'order-2',
      regime: 'momentum_continuation',
      archetype: 'btc_follow_through',
      expectedNetEdgeBps: 90,
      realizedNetEdgeBps: 108,
      finalizedTimestamp: '2026-03-27T12:05:00.000Z',
    }),
  );

  const store = new RealizedVsExpectedEdgeStore(ledger);
  const recent = await store.loadRecent(2);
  const summary = await store.summarizeWindow({
    start: '2026-03-27T11:59:00.000Z',
    end: '2026-03-27T12:06:00.000Z',
  });

  assert.strictEqual(recent.length, 2);
  assert.strictEqual(recent[0]?.orderId, 'order-2');
  assert.strictEqual(recent[0]?.realizedVsExpectedDeltaBps, 18);
  assert.strictEqual(recent[1]?.realizedVsExpectedDeltaBps, -36);
  assert.strictEqual(summary.sampleCount, 2);
  assert.strictEqual(summary.averageExpectedNetEdgeBps, 105);
  assert.strictEqual(summary.averageRealizedNetEdgeBps, 96);
  assert.strictEqual(summary.averageDeltaBps, -9);
}

function createResolvedTradeRecord(
  overrides: Partial<ResolvedTradeRecord>,
): ResolvedTradeRecord {
  return {
    tradeId: overrides.tradeId ?? 'trade-default',
    orderId: overrides.orderId ?? 'order-default',
    venueOrderId: overrides.venueOrderId ?? 'venue-order-default',
    marketId: overrides.marketId ?? 'market-btc',
    tokenId: overrides.tokenId ?? 'token-up',
    strategyVariantId: overrides.strategyVariantId ?? 'variant:strategy-live-1',
    strategyVersion: overrides.strategyVersion ?? 'strategy-live-1',
    regime: overrides.regime ?? 'balanced_market',
    archetype: overrides.archetype ?? 'mean_reversion',
    decisionTimestamp: overrides.decisionTimestamp ?? '2026-03-27T11:58:00.000Z',
    submissionTimestamp: overrides.submissionTimestamp ?? '2026-03-27T11:58:05.000Z',
    firstFillTimestamp: overrides.firstFillTimestamp ?? '2026-03-27T11:58:06.000Z',
    finalizedTimestamp: overrides.finalizedTimestamp ?? '2026-03-27T12:00:00.000Z',
    side: overrides.side ?? 'BUY',
    intendedPrice: overrides.intendedPrice ?? 0.51,
    averageFillPrice: overrides.averageFillPrice ?? 0.514,
    size: overrides.size ?? 25,
    notional: overrides.notional ?? 12.85,
    estimatedFeeAtDecision: overrides.estimatedFeeAtDecision ?? 0.05,
    realizedFee: overrides.realizedFee ?? 0.052,
    estimatedSlippageBps: overrides.estimatedSlippageBps ?? 18,
    realizedSlippageBps: overrides.realizedSlippageBps ?? 24,
    queueDelayMs: overrides.queueDelayMs ?? 7_000,
    fillFraction: overrides.fillFraction ?? 1,
    expectedNetEdgeBps: overrides.expectedNetEdgeBps ?? 120,
    realizedNetEdgeBps: overrides.realizedNetEdgeBps ?? 84,
    maxFavorableExcursionBps: overrides.maxFavorableExcursionBps ?? 160,
    maxAdverseExcursionBps: overrides.maxAdverseExcursionBps ?? -45,
    toxicityScoreAtDecision: overrides.toxicityScoreAtDecision ?? 0.22,
    benchmarkContext: overrides.benchmarkContext ?? null,
    lossAttributionCategory: overrides.lossAttributionCategory ?? 'mixed',
    executionAttributionCategory: overrides.executionAttributionCategory ?? 'queue_decay',
    lifecycleState: overrides.lifecycleState ?? 'economically_resolved',
    attribution: overrides.attribution ?? {
      benchmarkContext: null,
      lossAttributionCategory: 'mixed',
      executionAttributionCategory: 'queue_decay',
      primaryLeakageDriver: 'queue_delay',
      secondaryLeakageDrivers: ['slippage'],
      reasonCodes: ['fixture'],
    },
    executionQuality: overrides.executionQuality ?? {
      intendedPrice: 0.51,
      averageFillPrice: 0.514,
      size: 25,
      notional: 12.85,
      estimatedFeeAtDecision: 0.05,
      realizedFee: 0.052,
      estimatedSlippageBps: 18,
      realizedSlippageBps: 24,
      queueDelayMs: 7_000,
      fillFraction: 1,
    },
    netOutcome: overrides.netOutcome ?? {
      expectedNetEdgeBps: overrides.expectedNetEdgeBps ?? 120,
      realizedNetEdgeBps: overrides.realizedNetEdgeBps ?? 84,
      maxFavorableExcursionBps: 160,
      maxAdverseExcursionBps: -45,
      realizedPnl: 0.9,
    },
    capturedAt: overrides.capturedAt ?? overrides.finalizedTimestamp ?? '2026-03-27T12:00:00.000Z',
  };
}

export const phaseTwoNetEdgeTruthPathTests = [
  {
    name: 'phase2 net edge estimator returns full decomposition',
    fn: testNetEdgeEstimatorReturnsPhaseTwoDecomposition,
  },
  {
    name: 'phase2 realized-vs-expected edge store reads resolved-trade ledger',
    fn: testRealizedVsExpectedEdgeStoreComputesFromResolvedTradeLedger,
  },
];
