import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  FillRealismStore,
  OrderPlanner,
  PostFillToxicityStore,
  buildFillRealismBucket,
} from '@polymarket-btc-5m-agentic-bot/execution-engine';

async function testLiveExecutionRealismUpdatesFuturePlannerOutput(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase10-fill-realism-'));
  const fillRealismStore = new FillRealismStore(path.join(rootDir, 'fill'));
  const postFillToxicityStore = new PostFillToxicityStore(path.join(rootDir, 'tox'));
  const planner = new OrderPlanner({
    fillRealismStore,
    postFillToxicityStore,
  });
  const bucket = buildFillRealismBucket({
    spreadBucket: 'wide',
    liquidityBucket: 'thin',
    orderUrgency: 'high',
    regime: 'illiquid_noisy_book',
    executionStyle: 'taker',
    venueUncertaintyLabel: 'degraded',
  });

  const before = planner.plan({
    resolvedIntent: {
      tokenId: 'yes1',
      outcome: 'YES',
      intent: 'ENTER',
      venueSide: 'BUY',
      inventoryEffect: 'INCREASE',
    },
    price: 0.56,
    size: 20,
    urgency: 'high',
    expiryAt: '2026-03-27T12:00:00.000Z',
    noTradeWindowSeconds: 30,
    executionStyle: 'cross',
    venueConstraints: {
      tickSize: 0.01,
      minOrderSize: 1,
      negRisk: false,
    },
    liquidity: {
      topLevelDepth: 10,
      executableDepth: 10,
      recentMatchedVolume: 12,
      restingSizeAhead: 9,
      bestBid: 0.52,
      bestAsk: 0.56,
      spread: 0.04,
    },
    regime: 'illiquid_noisy_book',
    venueUncertaintyLabel: 'degraded',
    feeRateBpsEstimate: 16,
  });

  await fillRealismStore.append({
    observationId: 'phase10-fill-1',
    orderId: 'order-1',
    tradeId: 'trade-1',
    bucket,
    fillProbabilityWithin1s: 0.08,
    fillProbabilityWithin3s: 0.14,
    fillProbabilityWithin5s: 0.22,
    fillProbabilityWithin10s: 0.35,
    fillFraction: 0.44,
    queueDelayMs: 14_000,
    cancelSuccessLatencyMs: 4_500,
    slippageBps: 34,
    capturedAt: '2026-03-27T10:00:00.000Z',
  });
  await postFillToxicityStore.append({
    observationId: 'phase10-tox-1',
    orderId: 'order-1',
    tradeId: 'trade-1',
    bucket,
    drift1sBps: 7,
    drift3sBps: 14,
    drift10sBps: 26,
    drift30sBps: 31,
    capturedAt: '2026-03-27T10:00:01.000Z',
  });

  const after = planner.plan({
    resolvedIntent: {
      tokenId: 'yes1',
      outcome: 'YES',
      intent: 'ENTER',
      venueSide: 'BUY',
      inventoryEffect: 'INCREASE',
    },
    price: 0.56,
    size: 20,
    urgency: 'high',
    expiryAt: '2026-03-27T12:00:00.000Z',
    noTradeWindowSeconds: 30,
    executionStyle: 'cross',
    venueConstraints: {
      tickSize: 0.01,
      minOrderSize: 1,
      negRisk: false,
    },
    liquidity: {
      topLevelDepth: 10,
      executableDepth: 10,
      recentMatchedVolume: 12,
      restingSizeAhead: 9,
      bestBid: 0.52,
      bestAsk: 0.56,
      spread: 0.04,
    },
    regime: 'illiquid_noisy_book',
    venueUncertaintyLabel: 'degraded',
    feeRateBpsEstimate: 16,
  });

  assert.strictEqual(after.executionBucketContext.regime, 'illiquid_noisy_book');
  assert.strictEqual(after.expectedFillProbability < before.expectedFillProbability, true);
  assert.strictEqual(after.expectedRealizedCostBps !== before.expectedRealizedCostBps, true);
  assert.strictEqual(
    after.expectedAdverseSelectionPenaltyBps > before.expectedAdverseSelectionPenaltyBps,
    true,
  );
  assert.strictEqual((after.postFillToxicitySummary?.sampleCount ?? 0) > 0, true);
}

export const phaseTenFillRealismFeedbackTests = [
  {
    name: 'phase10 live execution realism updates future planner output',
    fn: testLiveExecutionRealismUpdatesFuturePlannerOutput,
  },
];
