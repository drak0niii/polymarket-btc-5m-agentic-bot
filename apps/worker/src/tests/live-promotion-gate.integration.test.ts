import assert from 'assert';
import type { ResolvedTradeRecord } from '@polymarket-btc-5m-agentic-bot/domain';
import { LiveTrustScore } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import {
  LivePromotionGate,
  buildLivePromotionEvidencePacket,
} from '@polymarket-btc-5m-agentic-bot/signal-engine';

async function testLivePromotionGateRejectsRawPnlWinnerThatFailsBenchmarks(): Promise<void> {
  const resolvedTrades = [
    buildResolvedTrade('trade-1', 42, 0.8),
    buildResolvedTrade('trade-2', 38, 0.6),
    buildResolvedTrade('trade-3', 35, 0.7),
    buildResolvedTrade('trade-4', 39, 0.9),
    buildResolvedTrade('trade-5', 33, 0.5),
    buildResolvedTrade('trade-6', 36, 0.75),
    buildResolvedTrade('trade-7', 41, 0.82),
    buildResolvedTrade('trade-8', 37, 0.64),
  ];
  const trust = new LiveTrustScore().evaluate({
    strategyVariantId: 'variant:benchmark-fail',
    regime: 'momentum_continuation',
    resolvedTrades,
  });
  const packet = buildLivePromotionEvidencePacket({
    strategyVariantId: 'variant:benchmark-fail',
    evidenceWindowStart: '2026-03-20T00:00:00.000Z',
    evidenceWindowEnd: '2026-03-27T00:00:00.000Z',
    resolvedTrades,
    liveTrustScoreSummary: {
      trustScore: trust.trustScore,
      sampleCount: trust.sampleCount,
      componentBreakdown: trust.componentBreakdown,
      reasonCodes: trust.reasonCodes,
    },
    regimeSnapshots: [
      {
        regime: 'momentum_continuation',
        health: 'healthy',
        realizedVsExpected: 1.02,
      },
    ],
    now: new Date('2026-03-27T00:00:00.000Z'),
  });
  const decision = new LivePromotionGate().evaluate({
    evidencePacket: packet,
    now: new Date('2026-03-27T00:00:00.000Z'),
  });

  assert.strictEqual(packet.realizedNetEdgeSummary.averageNetEdgeBps! > 0, true);
  assert.strictEqual(packet.benchmarkComparisonSummary.underperformingCount > 0, true);
  assert.strictEqual(decision.passed, false);
  assert.strictEqual(
    decision.reasonCodes.includes('benchmark_outperformance_not_met'),
    true,
  );
}

function buildResolvedTrade(
  tradeId: string,
  realizedNetEdgeBps: number,
  realizedPnl: number,
): ResolvedTradeRecord {
  return {
    tradeId,
    orderId: `${tradeId}-order`,
    venueOrderId: `${tradeId}-venue`,
    marketId: 'market-1',
    tokenId: 'yes1',
    strategyVariantId: 'variant:benchmark-fail',
    strategyVersion: 'strategy-live-1',
    regime: 'momentum_continuation',
    archetype: 'btc_follow_through',
    decisionTimestamp: '2026-03-26T12:00:00.000Z',
    submissionTimestamp: '2026-03-26T12:00:01.000Z',
    firstFillTimestamp: '2026-03-26T12:00:03.000Z',
    finalizedTimestamp: '2026-03-26T12:05:00.000Z',
    side: 'BUY',
    intendedPrice: 0.54,
    averageFillPrice: 0.542,
    size: 12,
    notional: 120,
    estimatedFeeAtDecision: 0.2,
    realizedFee: 0.22,
    estimatedSlippageBps: 5,
    realizedSlippageBps: 7,
    queueDelayMs: 1_000,
    fillFraction: 1,
    expectedNetEdgeBps: 28,
    realizedNetEdgeBps,
    maxFavorableExcursionBps: 25,
    maxAdverseExcursionBps: -10,
    toxicityScoreAtDecision: 0.18,
    benchmarkContext: {
      benchmarkComparisonState: 'underperforming',
      baselinePenaltyMultiplier: 0.5,
      regimeBenchmarkGateState: 'blocked',
      underperformedBenchmarkIds: ['no_trade_baseline', 'no_regime_baseline'],
      outperformedBenchmarkIds: [],
      reasonCodes: ['benchmark_failure'],
    },
    lossAttributionCategory: null,
    executionAttributionCategory: null,
    lifecycleState: 'economically_resolved_with_portfolio_truth',
    attribution: {
      benchmarkContext: {
        benchmarkComparisonState: 'underperforming',
        baselinePenaltyMultiplier: 0.5,
        regimeBenchmarkGateState: 'blocked',
        underperformedBenchmarkIds: ['no_trade_baseline', 'no_regime_baseline'],
        outperformedBenchmarkIds: [],
        reasonCodes: ['benchmark_failure'],
      },
      lossAttributionCategory: null,
      executionAttributionCategory: null,
      primaryLeakageDriver: null,
      secondaryLeakageDrivers: [],
      reasonCodes: [],
    },
    executionQuality: {
      intendedPrice: 0.54,
      averageFillPrice: 0.542,
      size: 12,
      notional: 120,
      estimatedFeeAtDecision: 0.2,
      realizedFee: 0.22,
      estimatedSlippageBps: 5,
      realizedSlippageBps: 7,
      queueDelayMs: 1_000,
      fillFraction: 1,
    },
    netOutcome: {
      expectedNetEdgeBps: 28,
      realizedNetEdgeBps,
      maxFavorableExcursionBps: 25,
      maxAdverseExcursionBps: -10,
      realizedPnl,
    },
    capturedAt: '2026-03-26T12:05:00.000Z',
  };
}

export const phaseTenLivePromotionGateTests = [
  {
    name: 'phase10 promotion gate rejects raw-pnl winners that fail benchmark-relative net pnl',
    fn: testLivePromotionGateRejectsRawPnlWinnerThatFailsBenchmarks,
  },
];
