import assert from 'assert';
import {
  EntryTimingEfficiencyScorer,
  SizeVsLiquidityPolicy,
} from '@polymarket-btc-5m-agentic-bot/execution-engine';
import {
  MaxLossPerOpportunityPolicy,
  SizePenaltyEngine,
  UncertaintyWeightedSizing,
} from '@polymarket-btc-5m-agentic-bot/risk-engine';

async function testUncertaintyAndLiquidityReduceOtherwiseAttractiveSize(): Promise<void> {
  const uncertaintyWeightedSizing = new UncertaintyWeightedSizing();
  const sizePenaltyEngine = new SizePenaltyEngine();
  const maxLossPolicy = new MaxLossPerOpportunityPolicy();
  const liquidityPolicy = new SizeVsLiquidityPolicy();

  const uncertaintySizing = uncertaintyWeightedSizing.evaluate({
    basePositionSize: 120,
    netEdge: 0.009,
    netEdgeThreshold: 0.004,
    calibrationHealth: 'watch',
    executionHealth: 'degraded',
    regimeHealth: 'watch',
    venueHealth: 'degraded',
    currentDrawdownPct: 0.06,
    sampleCount: 4,
  });
  const sizePenalty = sizePenaltyEngine.evaluate({
    calibrationHealth: 'watch',
    executionHealth: 'degraded',
    regimeHealth: 'watch',
    venueUncertaintyLabel: 'degraded',
    concentrationPenaltyMultiplier: 0.8,
    correlationPenaltyMultiplier: 0.75,
  });
  const cappedByMaxLoss = maxLossPolicy.evaluate({
    candidatePositionSize:
      uncertaintySizing.adjustedPositionSize * sizePenalty.multiplier,
    bankroll: 1_000,
    availableCapital: 300,
    maxPerTradeRiskPct: 1,
    opportunityClass: 'tradable_edge',
    signalConfidence: 0.62,
  });
  const liquidityDecision = liquidityPolicy.evaluate({
    desiredNotional: cappedByMaxLoss.maxAllowedPositionSize,
    desiredSizeUnits: cappedByMaxLoss.maxAllowedPositionSize / 0.56,
    price: 0.56,
    topLevelDepth: 18,
    spread: 0.045,
    expectedSlippage: 0.011,
    route: 'taker',
  });

  assert.strictEqual(uncertaintySizing.adjustedPositionSize < 120, true);
  assert.strictEqual(sizePenalty.multiplier < 1, true);
  assert.strictEqual(cappedByMaxLoss.maxAllowedPositionSize < 120, true);
  assert.strictEqual(liquidityDecision.allowedNotional < cappedByMaxLoss.maxAllowedPositionSize, true);
}

async function testStaleTimingCanBlockAnOtherwiseAttractiveTrade(): Promise<void> {
  const entryTimingEfficiencyScorer = new EntryTimingEfficiencyScorer();
  const timing = entryTimingEfficiencyScorer.score({
    signalAgeMs: 95_000,
    timeToExpirySeconds: 50,
    halfLifeMultiplier: 0.42,
    halfLifeExpired: true,
    expectedFillDelayMs: 18_000,
    microstructureDecayPressure: 0.82,
  });

  assert.strictEqual(timing.blockTrade, true);
  assert.strictEqual(timing.label, 'stale');
  assert.strictEqual(timing.sizeMultiplier, 0);
}

export const waveTwelveUncertaintySizingIntegrationTests = [
  {
    name: 'wave12 uncertainty and liquidity reduce attractive trade size',
    fn: testUncertaintyAndLiquidityReduceOtherwiseAttractiveSize,
  },
  {
    name: 'wave12 stale timing can block attractive entries',
    fn: testStaleTimingCanBlockAnOtherwiseAttractiveTrade,
  },
];
