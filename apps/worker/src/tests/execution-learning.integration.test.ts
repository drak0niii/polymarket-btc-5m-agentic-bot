import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AdaptiveMakerTakerPolicy,
  ExecutionPolicyVersionStore,
} from '@polymarket-btc-5m-agentic-bot/execution-engine';
import {
  createDefaultExecutionLearningState,
  createDefaultLearningState,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { buildExecutionLearningContextKey } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { LearningStateStore } from '../runtime/learning-state-store';

async function testExecutionLearningAdaptsLiveOrderPath(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave5-execution-learning-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const contextKey = buildExecutionLearningContextKey(
    'variant:strategy-live-1',
    'momentum_continuation',
  );
  const learningState = createDefaultLearningState(
    new Date('2026-03-25T00:00:00.000Z'),
  );
  learningState.executionLearning = {
    ...createDefaultExecutionLearningState(),
    updatedAt: '2026-03-25T00:00:00.000Z',
    lastPolicyChangeAt: '2026-03-25T00:00:00.000Z',
    contexts: {
      [contextKey]: {
        contextKey,
        strategyVariantId: 'variant:strategy-live-1',
        regime: 'momentum_continuation',
        sampleCount: 6,
        makerSampleCount: 3,
        takerSampleCount: 3,
        makerFillRate: 0.25,
        takerFillRate: 0.95,
        averageFillDelayMs: 22_000,
        averageSlippage: 0.004,
        adverseSelectionScore: 0.55,
        cancelSuccessRate: 0.6,
        partialFillRate: 0.2,
        makerPunished: true,
        health: 'degraded',
        notes: ['maker_adverse_selection_detected'],
        activePolicyVersionId: 'execution-policy:test:v1',
        lastUpdatedAt: '2026-03-25T00:00:00.000Z',
      },
    },
    policyVersions: {
      'execution-policy:test:v1': {
        versionId: 'execution-policy:test:v1',
        contextKey,
        strategyVariantId: 'variant:strategy-live-1',
        regime: 'momentum_continuation',
        mode: 'taker_preferred',
        recommendedRoute: 'taker',
        recommendedExecutionStyle: 'cross',
        sampleCount: 6,
        makerFillRateAssumption: 0.25,
        takerFillRateAssumption: 0.95,
        expectedFillDelayMs: 22_000,
        expectedSlippage: 0.004,
        adverseSelectionScore: 0.55,
        cancelSuccessRate: 0.6,
        partialFillRate: 0.2,
        health: 'degraded',
        rationale: ['maker_adverse_selection_detected'],
        sourceCycleId: 'cycle-1',
        supersedesVersionId: null,
        createdAt: '2026-03-25T00:00:00.000Z',
      },
    },
    activePolicyVersionIds: {
      [contextKey]: 'execution-policy:test:v1',
    },
  };
  await learningStateStore.save(learningState);

  const policyVersionStore = new ExecutionPolicyVersionStore({
    loadState: () => learningStateStore.load(),
    saveState: (state) => learningStateStore.save(state),
  });
  const activePolicyVersion = await policyVersionStore.getActiveVersionForStrategy(
    'variant:strategy-live-1',
    'momentum_continuation',
  );
  const decision = new AdaptiveMakerTakerPolicy().decide({
    activePolicyVersion,
    marketContext: {
      strategyVariantId: 'variant:strategy-live-1',
      regime: 'momentum_continuation',
      action: 'ENTER',
      urgency: 'medium',
      spread: 0.02,
      topLevelDepth: 100,
    },
  });

  assert.ok(activePolicyVersion);
  assert.strictEqual(activePolicyVersion?.versionId, 'execution-policy:test:v1');
  assert.strictEqual(decision.route, 'taker');
  assert.strictEqual(decision.executionStyle, 'cross');
  assert.strictEqual(decision.policyVersionId, 'execution-policy:test:v1');
}

export const waveFiveExecutionLearningIntegrationTests = [
  {
    name: 'wave5 execution learning adapts the live order path',
    fn: testExecutionLearningAdaptsLiveOrderPath,
  },
];
