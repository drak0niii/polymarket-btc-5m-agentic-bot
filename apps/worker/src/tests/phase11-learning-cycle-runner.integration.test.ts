import assert from 'assert';
import {
  createDefaultLearningState,
  createDefaultStrategyVariantState,
  type LearningEvent,
  type LearningState,
} from '@polymarket-btc-5m-agentic-bot/domain';
import {
  LearningCycleRunner,
  type LearningCycleSample,
} from '../orchestration/learning-cycle-runner';
import type { CalibrationObservation } from '@polymarket-btc-5m-agentic-bot/signal-engine';

async function testDeterministicLearningCycleRunnerNormalizesOrderAndLeavesPriorStateUntouched(): Promise<void> {
  const priorState = createStateFixture();
  const priorSnapshot = JSON.stringify(priorState);
  const now = new Date('2026-03-29T00:10:00.000Z');
  const startedAt = new Date('2026-03-29T00:00:00.000Z');
  const sampleA = buildSample({
    strategyVariantId: 'variant:b',
    regime: 'trend_burst',
    observedAt: '2026-03-29T00:02:00.000Z',
    expectedEv: 0.05,
    realizedEv: 0.02,
    predictedProbability: 0.71,
    realizedOutcome: 1,
  });
  const sampleB = buildSample({
    strategyVariantId: 'variant:a',
    regime: 'balanced_rotation',
    observedAt: '2026-03-29T00:01:00.000Z',
    expectedEv: 0.04,
    realizedEv: -0.01,
    predictedProbability: 0.63,
    realizedOutcome: 0,
  });

  const firstObservationOrders: string[][] = [];
  const secondObservationOrders: string[][] = [];
  const runnerA = new LearningCycleRunner(
    {
      update: async (observations: CalibrationObservation[]) => {
        firstObservationOrders.push(observations.map((item: CalibrationObservation) => item.strategyVariantId));
        return buildCalibrationResult('cycle-deterministic', now.toISOString());
      },
    } as never,
  );
  const runnerB = new LearningCycleRunner(
    {
      update: async (observations: CalibrationObservation[]) => {
        secondObservationOrders.push(observations.map((item: CalibrationObservation) => item.strategyVariantId));
        return buildCalibrationResult('cycle-deterministic', now.toISOString());
      },
    } as never,
  );

  const firstResult = await runnerA.run({
    cycleId: 'cycle-deterministic',
    startedAt,
    completedAt: now,
    analyzedWindow: {
      from: new Date('2026-03-28T00:10:00.000Z'),
      to: now,
    },
    priorState,
    samples: [sampleA, sampleB],
  });
  const secondResult = await runnerB.run({
    cycleId: 'cycle-deterministic',
    startedAt,
    completedAt: now,
    analyzedWindow: {
      from: new Date('2026-03-28T00:10:00.000Z'),
      to: now,
    },
    priorState,
    samples: [sampleB, sampleA],
  });

  assert.deepStrictEqual(firstObservationOrders, [['variant:a', 'variant:b']]);
  assert.deepStrictEqual(secondObservationOrders, [['variant:a', 'variant:b']]);
  assert.deepStrictEqual(firstResult.summary, secondResult.summary);
  assert.deepStrictEqual(firstResult.events, secondResult.events);
  assert.deepStrictEqual(firstResult.nextState, secondResult.nextState);
  assert.deepStrictEqual(firstResult.summary.degradedContexts, ['context:a', 'context:z']);
  assert.deepStrictEqual(
    firstResult.events.map((event) => event.type),
    ['calibration_updated', 'confidence_shrinkage_changed', 'learning_cycle_completed'],
  );
  assert.strictEqual(JSON.stringify(priorState), priorSnapshot);
}

function createStateFixture(): LearningState {
  const state = createDefaultLearningState(new Date('2026-03-29T00:00:00.000Z'));
  state.strategyVariants['variant:a'] = createDefaultStrategyVariantState('variant:a');
  state.strategyVariants['variant:b'] = createDefaultStrategyVariantState('variant:b');
  return state;
}

function buildCalibrationResult(cycleId: string, createdAt: string): {
  calibration: LearningState['calibration'];
  events: LearningEvent[];
  updates: number;
  degradedContexts: string[];
} {
  return {
    calibration: {
      'context:z': {
        contextKey: 'context:z',
        strategyVariantId: 'variant:b',
        regime: 'trend_burst',
        sampleCount: 2,
        brierScore: 0.22,
        logLoss: 0.61,
        shrinkageFactor: 0.82,
        overconfidenceScore: 0.12,
        health: 'watch',
        version: 2,
        driftSignals: ['log_loss_deterioration'],
        lastUpdatedAt: createdAt,
      },
      'context:a': {
        contextKey: 'context:a',
        strategyVariantId: 'variant:a',
        regime: 'balanced_rotation',
        sampleCount: 2,
        brierScore: 0.27,
        logLoss: 0.76,
        shrinkageFactor: 0.64,
        overconfidenceScore: 0.21,
        health: 'degraded',
        version: 3,
        driftSignals: ['brier_deterioration'],
        lastUpdatedAt: createdAt,
      },
    },
    events: [
      {
        id: `${cycleId}:shrinkage:context:z`,
        type: 'confidence_shrinkage_changed',
        severity: 'warning',
        createdAt,
        cycleId,
        strategyVariantId: 'variant:b',
        contextKey: 'context:z',
        summary: 'Confidence shrinkage changed for context:z.',
        details: {
          shrinkageFactor: 0.82,
        },
      },
      {
        id: `${cycleId}:calibration:context:a`,
        type: 'calibration_updated',
        severity: 'warning',
        createdAt,
        cycleId,
        strategyVariantId: 'variant:a',
        contextKey: 'context:a',
        summary: 'Calibration updated for context:a.',
        details: {
          shrinkageFactor: 0.64,
        },
      },
    ],
    updates: 2,
    degradedContexts: ['context:z', 'context:a'],
  };
}

function buildSample(
  input: Partial<LearningCycleSample> & {
    strategyVariantId: string;
    regime: string;
    observedAt: string;
    expectedEv: number;
    realizedEv: number;
    predictedProbability: number;
    realizedOutcome: number;
  },
): LearningCycleSample {
  return {
    strategyVariantId: input.strategyVariantId,
    regime: input.regime,
    side: input.side ?? 'buy',
    expectedEv: input.expectedEv,
    realizedEv: input.realizedEv,
    fillRate: input.fillRate ?? 1,
    realizedSlippage: input.realizedSlippage ?? 0.001,
    liquidityDepth: input.liquidityDepth ?? 20,
    spread: input.spread ?? 0.02,
    timeToExpirySeconds: input.timeToExpirySeconds ?? 600,
    entryDelayMs: input.entryDelayMs ?? 1500,
    executionStyle: input.executionStyle ?? 'maker',
    observedAt: input.observedAt,
    predictedProbability: input.predictedProbability,
    realizedOutcome: input.realizedOutcome,
  };
}

export const phaseElevenLearningCycleRunnerTests = [
  {
    name: 'phase11 deterministic learning-cycle runner normalizes order and preserves prior state',
    fn: testDeterministicLearningCycleRunnerNormalizesOrderAndLeavesPriorStateUntouched,
  },
];
