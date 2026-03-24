import assert from 'assert';
import { NetEdgeEstimator, NetEdgeThresholdPolicy, NoTradeZonePolicy } from '@polymarket-btc-5m-agentic-bot/signal-engine';

async function testRawEdgeCanBeRejectedAfterCostAdjustment(): Promise<void> {
  const estimator = new NetEdgeEstimator();
  const thresholdPolicy = new NetEdgeThresholdPolicy();
  const noTradeZonePolicy = new NoTradeZonePolicy();

  const netEdgeDecision = estimator.estimate({
    grossForecastEdge: 0.012,
    expectedEv: 0.012,
    feeRate: 0.005,
    spread: 0.02,
    signalAgeMs: 90_000,
    halfLifeMultiplier: 0.58,
    topLevelDepth: 30,
    estimatedOrderSizeUnits: 24,
    executionStyle: 'taker',
    calibrationHealth: 'degraded',
    calibrationShrinkageFactor: 0.82,
    calibrationSampleCount: 4,
    regimeHealth: 'degraded',
    venueUncertaintyLabel: 'degraded',
    venueMode: 'size-reduced',
  });
  const threshold = thresholdPolicy.evaluate({
    baseMinimumNetEdge: 0.0015,
    netEdge: netEdgeDecision.breakdown,
    regimeHealth: 'degraded',
    venueUncertaintyLabel: 'degraded',
  });
  const noTradeZone = noTradeZonePolicy.evaluate({
    timeToExpirySeconds: 240,
    noTradeWindowSeconds: 30,
    btcFresh: true,
    orderbookFresh: true,
    spread: 0.02,
    topLevelDepth: 30,
    microstructure: {
      boundaryDistance: 0.04,
      boundaryTension: 0.6,
      expiryConvexity: 0.2,
      liquidityClusterScore: 0.5,
      venueMispricingScore: 0.3,
      crowdLagScore: 0.4,
      decayPressure: 0.45,
      structureBucket: 'balanced',
      eventType: 'binary_event_contract',
      computedAt: new Date().toISOString(),
    },
    governanceHealthy: true,
    edgeHalfLifeHealthy: true,
    netEdge: netEdgeDecision.breakdown,
    thresholdDecision: threshold,
    calibrationHealth: 'degraded',
    regimeHealth: 'degraded',
    executionContextHealthy: false,
    venueUncertaintyLabel: 'degraded',
  });

  assert.strictEqual(netEdgeDecision.breakdown.grossForecastEdge > 0, true);
  assert.strictEqual(netEdgeDecision.breakdown.finalNetEdge <= 0, true);
  assert.strictEqual(netEdgeDecision.breakdown.paperEdgeBlocked, true);
  assert.strictEqual(threshold.passed, false);
  assert.strictEqual(noTradeZone.blocked, true);
  assert.strictEqual(noTradeZone.reasons.includes('weak_net_edge'), true);
  assert.strictEqual(noTradeZone.reasons.includes('poor_execution_context'), true);
}

export const waveTwelveNetEdgeGatingIntegrationTests = [
  {
    name: 'wave12 raw edge is rejectable after realistic cost adjustment',
    fn: testRawEdgeCanBeRejectedAfterCostAdjustment,
  },
];
