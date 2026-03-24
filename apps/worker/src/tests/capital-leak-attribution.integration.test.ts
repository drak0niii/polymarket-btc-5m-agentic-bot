import assert from 'assert';
import { CapitalLeakAttribution } from '@polymarket-btc-5m-agentic-bot/risk-engine';

async function testCapitalLeakAttributionDistinguishesMultipleLeakSources(): Promise<void> {
  const attribution = new CapitalLeakAttribution();
  const result = attribution.attribute({
    tradeId: 'trade-1',
    orderId: 'order-1',
    signalId: 'signal-1',
    marketId: 'market-1',
    strategyVariantId: 'variant:test',
    regime: 'trend_burst',
    marketContext: 'btc-5m',
    executionStyle: 'taker',
    observedAt: new Date().toISOString(),
    expectedEv: 0.05,
    realizedEv: -0.01,
    expectedSlippage: 0.002,
    realizedSlippage: 0.011,
    edgeAtSignal: 0.028,
    edgeAtFill: 0.01,
    fillRate: 0.55,
    allocatedNotional: 180,
    recommendedNotional: 100,
    calibrationHealth: 'degraded',
    regimeHealth: 'degraded',
    venueUncertaintyLabel: 'degraded',
    netEdgeAtDecision: 0.001,
    netEdgeThreshold: 0.0035,
    policyBreaches: ['weak_net_edge', 'low_margin_opportunity'],
  });

  const categories = result.contributions.map((contribution) => contribution.category);

  assert.strictEqual(result.totalLeak > 0, true);
  assert.strictEqual(categories.includes('slippage'), true);
  assert.strictEqual(categories.includes('adverse_selection'), true);
  assert.strictEqual(categories.includes('missed_fills'), true);
  assert.strictEqual(categories.includes('overtrading'), true);
  assert.strictEqual(categories.includes('poor_sizing'), true);
  assert.strictEqual(categories.includes('degraded_regime_trading'), true);
  assert.strictEqual(categories.includes('venue_degradation_cost'), true);
}

export const waveTwelveCapitalLeakAttributionIntegrationTests = [
  {
    name: 'wave12 capital leak attribution distinguishes multiple leak sources',
    fn: testCapitalLeakAttributionDistinguishesMultipleLeakSources,
  },
];
