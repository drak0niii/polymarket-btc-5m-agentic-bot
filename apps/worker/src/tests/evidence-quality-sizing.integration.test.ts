import assert from 'assert';
import { EvidenceQualitySizer, LiveTrustScore } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import type { ResolvedTradeRecord } from '@polymarket-btc-5m-agentic-bot/domain';

async function testEvidenceQualitySizingCapsProfitableButUnderSampledStrategy(): Promise<void> {
  const trust = new LiveTrustScore().evaluate({
    strategyVariantId: 'variant:under-sampled',
    regime: 'trend_burst',
    resolvedTrades: [
      buildResolvedTrade('trade-1', 92, 70),
      buildResolvedTrade('trade-2', 81, 66),
    ],
  });
  const sizing = new EvidenceQualitySizer().evaluate({ trust });

  assert.strictEqual(trust.sampleCount, 2);
  assert.strictEqual(trust.componentBreakdown.netExpectancyAfterCosts > 0.7, true);
  assert.strictEqual(sizing.evidenceFactor < 1, true);
  assert.notStrictEqual(sizing.recentEvidenceBand, 'full_size');
  assert.strictEqual(sizing.thresholdsUnmet.includes('minimum_live_trades_for_scale'), true);
  assert.strictEqual(
    sizing.rationale.includes('threshold_unmet:minimum_live_trades_for_scale'),
    true,
  );
}

function buildResolvedTrade(
  tradeId: string,
  realizedNetEdgeBps: number,
  expectedNetEdgeBps: number,
): ResolvedTradeRecord {
  return {
    tradeId,
    orderId: `${tradeId}-order`,
    venueOrderId: `${tradeId}-venue`,
    marketId: 'market-1',
    tokenId: 'yes1',
    strategyVariantId: 'variant:under-sampled',
    strategyVersion: 'strategy-live-1',
    regime: 'trend_burst',
    archetype: 'trend_follow_through',
    decisionTimestamp: '2026-03-26T12:00:00.000Z',
    submissionTimestamp: '2026-03-26T12:00:02.000Z',
    firstFillTimestamp: '2026-03-26T12:00:03.000Z',
    finalizedTimestamp: '2026-03-26T12:05:00.000Z',
    side: 'BUY',
    intendedPrice: 0.55,
    averageFillPrice: 0.552,
    size: 10,
    notional: 100,
    estimatedFeeAtDecision: 0.2,
    realizedFee: 0.21,
    estimatedSlippageBps: 5,
    realizedSlippageBps: 7,
    queueDelayMs: 900,
    fillFraction: 1,
    expectedNetEdgeBps,
    realizedNetEdgeBps,
    maxFavorableExcursionBps: 18,
    maxAdverseExcursionBps: -9,
    toxicityScoreAtDecision: 0.21,
    benchmarkContext: {
      benchmarkComparisonState: 'outperforming',
      baselinePenaltyMultiplier: 1,
      regimeBenchmarkGateState: 'passed',
      underperformedBenchmarkIds: [],
      outperformedBenchmarkIds: ['no_trade_baseline'],
      reasonCodes: [],
    },
    lossAttributionCategory: null,
    executionAttributionCategory: null,
    lifecycleState: 'economically_resolved_with_portfolio_truth',
    attribution: {
      benchmarkContext: {
        benchmarkComparisonState: 'outperforming',
        baselinePenaltyMultiplier: 1,
        regimeBenchmarkGateState: 'passed',
        underperformedBenchmarkIds: [],
        outperformedBenchmarkIds: ['no_trade_baseline'],
        reasonCodes: [],
      },
      lossAttributionCategory: null,
      executionAttributionCategory: null,
      primaryLeakageDriver: null,
      secondaryLeakageDrivers: [],
      reasonCodes: [],
    },
    executionQuality: {
      intendedPrice: 0.55,
      averageFillPrice: 0.552,
      size: 10,
      notional: 100,
      estimatedFeeAtDecision: 0.2,
      realizedFee: 0.21,
      estimatedSlippageBps: 5,
      realizedSlippageBps: 7,
      queueDelayMs: 900,
      fillFraction: 1,
    },
    netOutcome: {
      expectedNetEdgeBps,
      realizedNetEdgeBps,
      maxFavorableExcursionBps: 18,
      maxAdverseExcursionBps: -9,
      realizedPnl: 8,
    },
    capturedAt: '2026-03-26T12:05:00.000Z',
  };
}

export const phaseTenEvidenceQualitySizingTests = [
  {
    name: 'phase10 evidence-quality sizing caps profitable but under-sampled strategy',
    fn: testEvidenceQualitySizingCapsProfitableButUnderSampledStrategy,
  },
];
