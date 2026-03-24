import assert from 'assert';
import type {
  TradeQualityComponentScore,
  TradeQualityScore,
} from '@polymarket-btc-5m-agentic-bot/domain';
import {
  RegimeCapitalPolicy,
  RegimeDisablePolicy,
  RegimeProfitabilityRanker,
} from '@polymarket-btc-5m-agentic-bot/risk-engine';

async function testDestructiveRegimesAreDownRankedAndRestricted(): Promise<void> {
  const ranker = new RegimeProfitabilityRanker();
  const capitalPolicy = new RegimeCapitalPolicy();
  const disablePolicy = new RegimeDisablePolicy();
  const tradeQualityScores = [
    buildTradeQualityScore('destructive', 0.18, -0.03),
    buildTradeQualityScore('poor', 0.28, -0.02),
    buildTradeQualityScore('destructive', 0.12, -0.025),
  ];

  const assessment = ranker.rank({
    strategyVariantId: 'variant:test',
    regime: 'trend_burst',
    regimeSnapshot: {
      key: 'variant:test::trend_burst',
      regime: 'trend_burst',
      liquidityBucket: 'thin',
      spreadBucket: 'stressed',
      timeToExpiryBucket: 'under_15m',
      entryTimingBucket: 'late',
      executionStyle: 'taker',
      side: 'buy',
      strategyVariantId: 'variant:test',
      sampleCount: 9,
      expectedEvSum: 0.18,
      realizedEvSum: -0.11,
      avgExpectedEv: 0.02,
      avgRealizedEv: -0.012,
      realizedVsExpected: 0.45,
      winRate: 0.22,
      avgFillRate: 0.62,
      avgSlippage: 0.01,
      health: 'degraded',
      lastObservedAt: new Date().toISOString(),
    },
    calibrationHealth: 'degraded',
    executionContext: {
      contextKey: 'variant:test::trend_burst',
      strategyVariantId: 'variant:test',
      regime: 'trend_burst',
      sampleCount: 9,
      makerSampleCount: 1,
      takerSampleCount: 8,
      makerFillRate: 0.5,
      takerFillRate: 0.7,
      averageFillDelayMs: 55_000,
      averageSlippage: 0.009,
      adverseSelectionScore: 0.55,
      cancelSuccessRate: 0.7,
      partialFillRate: 0.3,
      makerPunished: true,
      health: 'degraded',
      notes: ['execution_retention_weak'],
      activePolicyVersionId: 'policy-1',
      lastUpdatedAt: new Date().toISOString(),
    },
    recentTradeQualityScores: tradeQualityScores,
    currentDrawdownPct: 0.08,
    maxDrawdownPct: 0.12,
    recentLeakShare: 0.46,
  });
  const capitalTreatment = capitalPolicy.decide({
    assessment,
    portfolioAllocationMultiplier: 0.6,
  });
  const disableDecision = disablePolicy.evaluate({
    assessment,
    recentTradeQualityScores: tradeQualityScores,
    recentLeakShare: 0.46,
    recentLeakDominantCategory: 'slippage',
  });

  assert.strictEqual(assessment.rank, 'avoid_regime');
  assert.strictEqual(capitalTreatment.treatment, 'blocked_capital');
  assert.strictEqual(capitalTreatment.blockNewTrades, true);
  assert.strictEqual(disableDecision.status, 'disabled');
  assert.strictEqual(disableDecision.blockNewTrades, true);
}

function buildTradeQualityScore(
  label: TradeQualityScore['label'],
  overallScore: number,
  realizedEv: number,
): TradeQualityScore {
  return {
    tradeId: `${label}-${overallScore}`,
    orderId: `${label}-order`,
    signalId: `${label}-signal`,
    marketId: 'market-1',
    strategyVariantId: 'variant:test',
    regime: 'trend_burst',
    marketContext: 'btc-5m',
    executionStyle: 'taker',
    evaluatedAt: new Date().toISOString(),
    label,
    breakdown: {
      forecastQuality: component(overallScore),
      calibrationQuality: component(overallScore),
      executionQuality: component(overallScore),
      timingQuality: component(overallScore),
      policyCompliance: component(overallScore),
      realizedOutcomeQuality: {
        ...component(overallScore),
        evidence: {
          expectedEv: 0.02,
          realizedEv,
        },
      },
      overallScore,
      reasons: [`overall_${label}`],
    },
  };
}

function component(score: number): TradeQualityComponentScore {
  return {
    score,
    label:
      score >= 0.8
        ? 'excellent'
        : score >= 0.65
          ? 'good'
          : score >= 0.45
            ? 'mixed'
            : score >= 0.25
              ? 'poor'
              : 'destructive',
    reasons: ['component_fixture'],
    evidence: {},
  };
}

export const waveTwelveRegimeProfitabilityIntegrationTests = [
  {
    name: 'wave12 destructive regimes are down ranked and capital reduced',
    fn: testDestructiveRegimesAreDownRankedAndRestricted,
  },
];
