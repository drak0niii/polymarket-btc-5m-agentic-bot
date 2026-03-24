import assert from 'assert';
import {
  MarginalEdgeCooldownPolicy,
  OpportunitySaturationDetector,
  TradeFrequencyGovernor,
} from '@polymarket-btc-5m-agentic-bot/risk-engine';

async function testRepeatedMarginalTradesTriggerAntiOvertradingControls(): Promise<void> {
  const tradeFrequencyGovernor = new TradeFrequencyGovernor();
  const marginalEdgeCooldownPolicy = new MarginalEdgeCooldownPolicy();
  const opportunitySaturationDetector = new OpportunitySaturationDetector();

  const frequencyDecision = tradeFrequencyGovernor.evaluate({
    regime: 'trend_burst',
    regimeRank: 'marginal_regime',
    opportunityClass: 'marginal_edge',
    recentTradeCount: 2,
    recentTradeQualityScore: 0.34,
    recentCapitalLeakageShare: 0.39,
    currentDrawdownPct: 0.07,
  });
  const cooldownDecision = marginalEdgeCooldownPolicy.evaluate({
    opportunityClass: 'marginal_edge',
    marginAboveThreshold: 0.001,
    recentMarginalApprovalCount: 3,
    recentMarginalAttemptCount: 5,
    recentLowQualityTradeShare: 0.42,
  });
  const saturationDecision = opportunitySaturationDetector.evaluate({
    recentApprovedCount: 5,
    recentStrongApprovalCount: 1,
    recentMarginalApprovalCount: 4,
    recentWeakRejectCount: 4,
    recentAverageMarginAboveThreshold: 0.0012,
    recentTradeQualityScore: 0.41,
    recentCapitalLeakageShare: 0.35,
  });

  assert.strictEqual(frequencyDecision.blockTrade, true);
  assert.strictEqual(cooldownDecision.blockTrade, true);
  assert.strictEqual(saturationDecision.blockTrade, true);
  assert.strictEqual(saturationDecision.label, 'saturated');
}

export const waveTwelveAntiOvertradingIntegrationTests = [
  {
    name: 'wave12 repeated marginal trades trigger anti overtrading controls',
    fn: testRepeatedMarginalTradesTriggerAntiOvertradingControls,
  },
];
