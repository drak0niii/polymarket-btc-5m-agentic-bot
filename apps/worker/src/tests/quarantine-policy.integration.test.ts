import assert from 'assert';
import {
  createDefaultLearningState,
  createStrategyVariantRecord,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { StrategyQuarantinePolicy } from '@polymarket-btc-5m-agentic-bot/signal-engine';

async function testQuarantinePolicyAppliesPreciseScope(): Promise<void> {
  const policy = new StrategyQuarantinePolicy();
  const now = new Date('2026-03-26T00:00:00.000Z');
  const learningState = createDefaultLearningState(now);
  learningState.strategyVariants['variant:strategy-challenger-2'] = {
    strategyVariantId: 'variant:strategy-challenger-2',
    health: 'quarantine_candidate',
    lastLearningAt: now.toISOString(),
    regimeSnapshots: {
      precise: {
        key: 'precise',
        regime: 'trend_burst',
        liquidityBucket: 'balanced',
        spreadBucket: 'normal',
        timeToExpiryBucket: 'under_15m',
        entryTimingBucket: 'early',
        executionStyle: 'maker',
        side: 'buy',
        strategyVariantId: 'variant:strategy-challenger-2',
        sampleCount: 12,
        winRate: 0.1,
        expectedEvSum: 0.08,
        realizedEvSum: -0.09,
        avgExpectedEv: 0.01,
        avgRealizedEv: -0.011,
        realizedVsExpected: -1.1,
        avgFillRate: 0.4,
        avgSlippage: 0.01,
        health: 'quarantine_candidate',
        lastObservedAt: now.toISOString(),
      },
    },
    calibrationContexts: ['strategy:variant:strategy-challenger-2|regime:trend_burst'],
    executionLearning: {
      version: 1,
      updatedAt: now.toISOString(),
      contexts: {},
      policyVersions: {},
      activePolicyVersionIds: {},
      lastPolicyChangeAt: null,
    },
    lastPromotionDecision: { decision: 'not_evaluated', reasons: [], evidence: {}, decidedAt: null },
    lastQuarantineDecision: { status: 'none', severity: 'none', reasons: [], scope: {}, decidedAt: null },
    lastCapitalAllocationDecision: { status: 'unchanged', targetMultiplier: 1, reasons: [], decidedAt: null },
  };
  learningState.calibration['strategy:variant:strategy-challenger-2|regime:trend_burst'] = {
    contextKey: 'strategy:variant:strategy-challenger-2|regime:trend_burst',
    strategyVariantId: 'variant:strategy-challenger-2',
    regime: 'trend_burst',
    sampleCount: 12,
    brierScore: 0.34,
    logLoss: 0.92,
    shrinkageFactor: 0.4,
    overconfidenceScore: 0.3,
    health: 'quarantine_candidate',
    version: 3,
    driftSignals: ['overconfidence_detected'],
    lastUpdatedAt: now.toISOString(),
  };

  const variant = createStrategyVariantRecord({
    strategyVersionId: 'strategy-challenger-2',
    parentVariantId: 'variant:strategy-live-1',
    now,
  });

  const assessment = policy.evaluate({
    variant,
    evidence: {
      variantId: variant.variantId,
      incumbentVariantId: 'variant:strategy-live-1',
      evaluationMode: 'shadow',
      sampleCount: 12,
      calibrationHealth: 'quarantine_candidate',
      executionHealth: 'healthy',
      realizedVsExpected: -1.1,
      realizedPnl: -0.09,
      improvementVsIncumbent: -0.2,
      sufficientSample: true,
      reasons: ['test'],
      evaluatedAt: now.toISOString(),
    },
    learningState,
    now,
  });

  assert.strictEqual(assessment.decision.status, 'quarantined');
  assert.strictEqual(
    assessment.records.some(
      (record) =>
        record.scope.variantId === variant.variantId &&
        record.scope.regime === 'trend_burst' &&
        record.scope.marketContext === 'regime_snapshot',
    ),
    true,
  );
  assert.strictEqual(
    assessment.records.some(
      (record) =>
        record.scope.variantId === variant.variantId &&
        record.scope.regime === 'trend_burst' &&
        record.scope.marketContext === 'calibration',
    ),
    true,
  );
}

export const waveFiveQuarantineIntegrationTests = [
  {
    name: 'wave5 quarantine policy applies precise variant and regime scope',
    fn: testQuarantinePolicyAppliesPreciseScope,
  },
];
