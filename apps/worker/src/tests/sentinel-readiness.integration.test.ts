import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SentinelReadinessService } from '../runtime/sentinel-readiness-service';
import { SentinelStateStore } from '../runtime/sentinel-state-store';

async function testSentinelReadinessRecommendsLiveAfterTwentyPassingTrades(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-readiness-pass-'));
  const store = new SentinelStateStore(rootDir);
  const readinessService = new SentinelReadinessService(store);
  await store.ensureBaselineKnowledge('sentinel_simulation');

  for (let index = 0; index < 20; index += 1) {
    const tradeId = `trade-${index + 1}`;
    await store.appendSimulatedTrade(buildTrade(tradeId, {
      expectedVsRealizedEdgeGapBps: 4,
      realizedNetEdgeAfterCostsBps: 14,
      fillQualityPassed: true,
      noTradeDisciplinePassed: true,
      unresolvedAnomalyCount: 0,
    }));
    await store.appendLearningUpdate(buildLearningUpdate(tradeId));
  }

  const status = await readinessService.recompute('sentinel_simulation');

  assert.strictEqual(status.recommendedLiveEnable, true);
  assert.strictEqual(status.recommendationState, 'ready_to_consider_live');
  assert.strictEqual(status.mode, 'sentinel_simulation');
  assert.strictEqual(status.baselineKnowledgeVersion, 'sentinel-baseline-v1');
  assert.strictEqual(typeof status.lastLearningAt, 'string');
  assert.strictEqual(
    status.recommendationMessage.includes('It is safe to consider enabling live trading.'),
    true,
  );
  assert.strictEqual(fs.existsSync(store.getPaths().readinessPath), true);
}

async function testSentinelReadinessBlocksRecommendationWhenGapOrAnomaliesFail(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-readiness-fail-'));
  const store = new SentinelStateStore(rootDir);
  const readinessService = new SentinelReadinessService(store);
  await store.ensureBaselineKnowledge('sentinel_simulation');

  for (let index = 0; index < 20; index += 1) {
    const tradeId = `trade-${index + 1}`;
    await store.appendSimulatedTrade(buildTrade(tradeId, {
      expectedVsRealizedEdgeGapBps: index === 0 ? 12 : 4,
      realizedNetEdgeAfterCostsBps: 12,
      fillQualityPassed: true,
      noTradeDisciplinePassed: true,
      unresolvedAnomalyCount: index === 1 ? 1 : 0,
    }));
    await store.appendLearningUpdate(buildLearningUpdate(tradeId));
  }

  const status = await readinessService.recompute('sentinel_simulation');

  assert.strictEqual(status.recommendedLiveEnable, false);
  assert.strictEqual(status.recommendationState, 'not_ready');
  assert.strictEqual(
    status.recommendationMessage.includes('Do not enable live trading yet.'),
    true,
  );
}

function buildTrade(
  simulationTradeId: string,
  overrides: Partial<ReturnType<typeof baseTrade>>,
) {
  return {
    ...baseTrade(simulationTradeId),
    ...overrides,
  };
}

function baseTrade(simulationTradeId: string) {
  return {
    simulationTradeId,
    signalId: simulationTradeId,
    marketId: 'market-1',
    tokenId: 'token-1',
    strategyVersionId: 'strategy-1',
    strategyVariantId: 'variant:strategy-1',
    regime: 'balanced_rotation',
    simulatedAt: '2026-03-27T00:00:00.000Z',
    side: 'BUY' as const,
    operatingMode: 'sentinel_simulation' as const,
    expectedFillProbability: 0.82,
    realizedFillProbability: 0.84,
    expectedFillFraction: 0.94,
    realizedFillFraction: 0.93,
    expectedQueueDelayMs: 450,
    realizedQueueDelayMs: 430,
    expectedFeeBps: 20,
    realizedFeeBps: 20,
    expectedSlippageBps: 4,
    realizedSlippageBps: 5,
    expectedNetEdgeAfterCostsBps: 18,
    realizedNetEdgeAfterCostsBps: 14,
    expectedVsRealizedEdgeGapBps: 4,
    fillQualityPassed: true,
    noTradeDisciplinePassed: true,
    unresolvedAnomalyCount: 0,
    rationale: [],
    evidenceRefs: [],
  };
}

function buildLearningUpdate(simulationTradeId: string) {
  return {
    learningUpdateId: `update:${simulationTradeId}`,
    simulationTradeId,
    learnedAt: '2026-03-27T00:05:00.000Z',
    parameterChanges: [],
    evidenceRefs: [],
    reason: 'test',
    rollbackCriteria: [],
  };
}

export const sentinelReadinessIntegrationTests = [
  {
    name: 'sentinel readiness recommends live after 20 passing learned trades',
    fn: testSentinelReadinessRecommendsLiveAfterTwentyPassingTrades,
  },
  {
    name: 'sentinel readiness blocks recommendation when edge gap or anomalies fail',
    fn: testSentinelReadinessBlocksRecommendationWhenGapOrAnomaliesFail,
  },
];
