import type {
  ExecutionLearningContext,
  ExecutionLearningState,
  ExecutionPolicyMode,
  LearningEvent,
} from '@polymarket-btc-5m-agentic-bot/domain';
import {
  createDefaultExecutionLearningContext,
  createDefaultExecutionLearningState,
} from '@polymarket-btc-5m-agentic-bot/domain';
import {
  AdverseSelectionMonitor,
  type MakerExecutionObservation,
  type TakerExecutionObservation,
} from './adverse-selection-monitor';
import { buildExecutionLearningContextKey } from './execution-learning-store';
import { ExecutionPolicyVersionStore } from './execution-policy-version-store';

export interface ExecutionLearningObservation {
  strategyVariantId: string;
  regime: string | null;
  route: 'maker' | 'taker';
  fillRatio: number;
  fillDelayMs: number | null;
  slippage: number;
  cancelAttempted: boolean;
  cancelSucceeded: boolean | null;
  partiallyFilled: boolean;
  observedAt: string;
}

export interface ExecutionPolicyUpdateResult {
  executionLearning: ExecutionLearningState;
  variantExecutionLearning: Record<string, ExecutionLearningState>;
  events: LearningEvent[];
  updatedContexts: number;
  createdPolicyVersions: number;
  adverseSelectionContexts: string[];
}

export class ExecutionPolicyUpdater {
  constructor(
    private readonly versionStore: ExecutionPolicyVersionStore,
    private readonly adverseSelectionMonitor = new AdverseSelectionMonitor(),
  ) {}

  update(input: {
    priorState: ExecutionLearningState;
    observations: ExecutionLearningObservation[];
    cycleId: string;
    now?: Date;
  }): ExecutionPolicyUpdateResult {
    const now = input.now ?? new Date();
    const grouped = new Map<string, ExecutionLearningObservation[]>();

    for (const observation of input.observations) {
      const contextKey = buildExecutionLearningContextKey(
        observation.strategyVariantId,
        observation.regime,
      );
      const list = grouped.get(contextKey) ?? [];
      list.push(observation);
      grouped.set(contextKey, list);
    }

    let nextState: ExecutionLearningState = {
      ...createDefaultExecutionLearningState(),
      ...input.priorState,
      contexts: {
        ...input.priorState.contexts,
      },
      policyVersions: {
        ...input.priorState.policyVersions,
      },
      activePolicyVersionIds: {
        ...input.priorState.activePolicyVersionIds,
      },
      updatedAt: now.toISOString(),
    };
    const variantExecutionLearning: Record<string, ExecutionLearningState> = {};
    const events: LearningEvent[] = [];
    const adverseSelectionContexts: string[] = [];
    let updatedContexts = 0;
    let createdPolicyVersions = 0;

    for (const [contextKey, contextObservations] of [...grouped.entries()].sort((left, right) =>
      left[0].localeCompare(right[0]),
    )) {
      const first = contextObservations[0];
      if (!first) {
        continue;
      }

      const makerObservations = contextObservations
        .filter((observation) => observation.route === 'maker')
        .map(
          (observation): MakerExecutionObservation => ({
            fillRatio: observation.fillRatio,
            fillDelayMs: observation.fillDelayMs,
            slippage: observation.slippage,
          }),
        );
      const takerObservations = contextObservations
        .filter((observation) => observation.route === 'taker')
        .map(
          (observation): TakerExecutionObservation => ({
            fillRatio: observation.fillRatio,
            slippage: observation.slippage,
          }),
        );
      const adverseSelection = this.adverseSelectionMonitor.assess({
        makerObservations,
        takerObservations,
      });
      const health = inferExecutionHealth({
        sampleCount: contextObservations.length,
        makerFillRate: average(makerObservations.map((item) => item.fillRatio)),
        takerFillRate: average(takerObservations.map((item) => item.fillRatio)),
        averageSlippage: average(contextObservations.map((item) => item.slippage)),
        cancelSuccessRate: ratio(
          contextObservations.filter((item) => item.cancelAttempted && item.cancelSucceeded === true)
            .length,
          contextObservations.filter((item) => item.cancelAttempted).length,
          1,
        ),
        adverseSelectionHealth: adverseSelection.health,
      });
      const mode = inferExecutionPolicyMode({
        makerFillRate: average(makerObservations.map((item) => item.fillRatio)),
        takerFillRate: average(takerObservations.map((item) => item.fillRatio)),
        averageMakerSlippage: average(makerObservations.map((item) => item.slippage)),
        averageTakerSlippage: average(takerObservations.map((item) => item.slippage)),
        adverseSelectionPunished: adverseSelection.punished,
      });
      const context: ExecutionLearningContext = {
        ...(nextState.contexts[contextKey] ??
          createDefaultExecutionLearningContext({
            contextKey,
            strategyVariantId: first.strategyVariantId,
            regime: first.regime,
          })),
        ...mergeExecutionContext(
          nextState.contexts[contextKey] ?? null,
          {
            contextKey,
            strategyVariantId: first.strategyVariantId,
            regime: first.regime,
            sampleCount: contextObservations.length,
            makerSampleCount: makerObservations.length,
            takerSampleCount: takerObservations.length,
            makerFillRate: average(makerObservations.map((item) => item.fillRatio)),
            takerFillRate: average(takerObservations.map((item) => item.fillRatio)),
            averageFillDelayMs: averageNullable(
              contextObservations.map((item) => item.fillDelayMs),
            ),
            averageSlippage: average(contextObservations.map((item) => item.slippage)),
            adverseSelectionScore: adverseSelection.score,
            cancelSuccessRate: ratio(
              contextObservations.filter(
                (item) => item.cancelAttempted && item.cancelSucceeded === true,
              ).length,
              contextObservations.filter((item) => item.cancelAttempted).length,
              1,
            ),
            partialFillRate: ratio(
              contextObservations.filter((item) => item.partiallyFilled).length,
              contextObservations.length,
              0,
            ),
            makerPunished: adverseSelection.punished,
            notes: adverseSelection.reasons,
          },
        ),
        contextKey,
        strategyVariantId: first.strategyVariantId,
        regime: first.regime,
        health,
        activePolicyVersionId:
          nextState.activePolicyVersionIds[contextKey] ??
          nextState.contexts[contextKey]?.activePolicyVersionId ??
          null,
        lastUpdatedAt: now.toISOString(),
      };
      nextState.contexts[contextKey] = context;
      updatedContexts += 1;

      const versioning = this.versionStore.createVersion({
        state: nextState,
        contextKey,
        strategyVariantId: first.strategyVariantId,
        regime: first.regime,
        mode,
        recommendedRoute: mode === 'taker_preferred' ? 'taker' : 'maker',
        recommendedExecutionStyle: mode === 'taker_preferred' ? 'cross' : 'rest',
        sampleCount: context.sampleCount,
        makerFillRateAssumption: context.makerFillRate,
        takerFillRateAssumption: context.takerFillRate,
        expectedFillDelayMs: context.averageFillDelayMs,
        expectedSlippage: context.averageSlippage,
        adverseSelectionScore: context.adverseSelectionScore,
        cancelSuccessRate: context.cancelSuccessRate,
        partialFillRate: context.partialFillRate,
        health: context.health,
        rationale: context.notes,
        sourceCycleId: input.cycleId,
        now,
      });
      nextState = versioning.nextState;
      nextState.contexts[contextKey] = {
        ...context,
        activePolicyVersionId:
          versioning.nextState.activePolicyVersionIds[contextKey] ?? context.activePolicyVersionId,
      };

      if (versioning.changed) {
        createdPolicyVersions += 1;
        events.push({
          id: `${input.cycleId}:execution-policy:${versioning.version.versionId}`,
          type: 'execution_policy_versioned',
          severity:
            versioning.version.health === 'quarantine_candidate'
              ? 'critical'
              : versioning.version.health === 'degraded'
                ? 'warning'
                : 'info',
          createdAt: now.toISOString(),
          cycleId: input.cycleId,
          strategyVariantId: first.strategyVariantId,
          contextKey,
          summary: `Execution policy versioned for ${contextKey}.`,
          details: versioning.version as unknown as Record<string, unknown>,
        });
      }

      events.push({
        id: `${input.cycleId}:execution-learning:${contextKey}`,
        type: 'execution_learning_updated',
        severity:
          context.health === 'quarantine_candidate'
            ? 'critical'
            : context.health === 'degraded'
              ? 'warning'
              : 'info',
        createdAt: now.toISOString(),
        cycleId: input.cycleId,
        strategyVariantId: first.strategyVariantId,
        contextKey,
        summary: `Execution learning updated for ${contextKey}.`,
        details: context as unknown as Record<string, unknown>,
      });

      if (adverseSelection.punished) {
        adverseSelectionContexts.push(contextKey);
        events.push({
          id: `${input.cycleId}:adverse-selection:${contextKey}`,
          type: 'adverse_selection_detected',
          severity:
            adverseSelection.health === 'quarantine_candidate' ? 'critical' : 'warning',
          createdAt: now.toISOString(),
          cycleId: input.cycleId,
          strategyVariantId: first.strategyVariantId,
          contextKey,
          summary: `Adverse selection detected for ${contextKey}.`,
          details: adverseSelection as unknown as Record<string, unknown>,
        });
      }

    }

    for (const strategyVariantId of unique(
      input.observations.map((observation) => observation.strategyVariantId),
    )) {
      const contexts = Object.fromEntries(
        Object.entries(nextState.contexts).filter(
          ([, context]) => context.strategyVariantId === strategyVariantId,
        ),
      );
      const activePolicyVersionIds = Object.fromEntries(
        Object.entries(nextState.activePolicyVersionIds).filter(([contextKey]) =>
          contextKey in contexts,
        ),
      );
      const policyVersions = Object.fromEntries(
        Object.entries(nextState.policyVersions).filter(
          ([, version]) => version.strategyVariantId === strategyVariantId,
        ),
      );
      variantExecutionLearning[strategyVariantId] = {
        ...createDefaultExecutionLearningState(),
        version: nextState.version + (updatedContexts > 0 ? 1 : 0),
        updatedAt: updatedContexts > 0 ? now.toISOString() : input.priorState.updatedAt,
        lastPolicyChangeAt: nextState.lastPolicyChangeAt,
        contexts,
        policyVersions,
        activePolicyVersionIds,
      };
    }

    return {
      executionLearning: {
        ...nextState,
        version: input.priorState.version + (updatedContexts > 0 ? 1 : 0),
        updatedAt: updatedContexts > 0 ? now.toISOString() : input.priorState.updatedAt,
      },
      variantExecutionLearning,
      events,
      updatedContexts,
      createdPolicyVersions,
      adverseSelectionContexts,
    };
  }
}

function inferExecutionHealth(input: {
  sampleCount: number;
  makerFillRate: number;
  takerFillRate: number;
  averageSlippage: number;
  cancelSuccessRate: number;
  adverseSelectionHealth: 'healthy' | 'watch' | 'degraded' | 'quarantine_candidate';
}): 'healthy' | 'watch' | 'degraded' | 'quarantine_candidate' {
  if (
    input.sampleCount >= 6 &&
    (input.adverseSelectionHealth === 'quarantine_candidate' ||
      input.averageSlippage >= 0.02 ||
      input.cancelSuccessRate < 0.4 ||
      input.takerFillRate < 0.5)
  ) {
    return 'quarantine_candidate';
  }

  if (
    input.sampleCount >= 4 &&
    (input.adverseSelectionHealth === 'degraded' ||
      input.averageSlippage >= 0.01 ||
      input.cancelSuccessRate < 0.7 ||
      input.makerFillRate < 0.3)
  ) {
    return 'degraded';
  }

  if (
    input.sampleCount >= 3 &&
    (input.adverseSelectionHealth === 'watch' ||
      input.averageSlippage >= 0.006 ||
      input.cancelSuccessRate < 0.85 ||
      input.makerFillRate < 0.45)
  ) {
    return 'watch';
  }

  return 'healthy';
}

function inferExecutionPolicyMode(input: {
  makerFillRate: number;
  takerFillRate: number;
  averageMakerSlippage: number;
  averageTakerSlippage: number;
  adverseSelectionPunished: boolean;
}): ExecutionPolicyMode {
  if (
    input.adverseSelectionPunished ||
    (input.makerFillRate > 0 &&
      input.makerFillRate < 0.35 &&
      input.takerFillRate >= input.makerFillRate)
  ) {
    return 'taker_preferred';
  }

  if (
    input.makerFillRate >= 0.55 &&
    input.averageMakerSlippage <= input.averageTakerSlippage + 0.003
  ) {
    return 'maker_preferred';
  }

  return 'balanced';
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function averageNullable(values: Array<number | null>): number | null {
  const usable = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (usable.length === 0) {
    return null;
  }
  return average(usable);
}

function ratio(numerator: number, denominator: number, fallback: number): number {
  if (denominator <= 0) {
    return fallback;
  }
  return numerator / denominator;
}

function mergeExecutionContext(
  prior: ExecutionLearningContext | null,
  current: {
    contextKey: string;
    strategyVariantId: string;
    regime: string | null;
    sampleCount: number;
    makerSampleCount: number;
    takerSampleCount: number;
    makerFillRate: number;
    takerFillRate: number;
    averageFillDelayMs: number | null;
    averageSlippage: number;
    adverseSelectionScore: number;
    cancelSuccessRate: number;
    partialFillRate: number;
    makerPunished: boolean;
    notes: string[];
  },
): Omit<
  ExecutionLearningContext,
  'health' | 'activePolicyVersionId' | 'lastUpdatedAt'
> {
  const baseline =
    prior ??
    createDefaultExecutionLearningContext({
      contextKey: current.contextKey,
      strategyVariantId: current.strategyVariantId,
      regime: current.regime,
    });
  const sampleCount = baseline.sampleCount + current.sampleCount;
  const makerSampleCount = baseline.makerSampleCount + current.makerSampleCount;
  const takerSampleCount = baseline.takerSampleCount + current.takerSampleCount;

  return {
    contextKey: current.contextKey,
    strategyVariantId: current.strategyVariantId,
    regime: current.regime,
    sampleCount,
    makerSampleCount,
    takerSampleCount,
    makerFillRate: weightedAverage(
      baseline.makerFillRate,
      baseline.makerSampleCount,
      current.makerFillRate,
      current.makerSampleCount,
    ),
    takerFillRate: weightedAverage(
      baseline.takerFillRate,
      baseline.takerSampleCount,
      current.takerFillRate,
      current.takerSampleCount,
    ),
    averageFillDelayMs: weightedAverageNullable(
      baseline.averageFillDelayMs,
      baseline.sampleCount,
      current.averageFillDelayMs,
      current.sampleCount,
    ),
    averageSlippage: weightedAverage(
      baseline.averageSlippage,
      baseline.sampleCount,
      current.averageSlippage,
      current.sampleCount,
    ),
    adverseSelectionScore: weightedAverage(
      baseline.adverseSelectionScore,
      baseline.sampleCount,
      current.adverseSelectionScore,
      current.sampleCount,
    ),
    cancelSuccessRate: weightedAverage(
      baseline.cancelSuccessRate,
      baseline.sampleCount,
      current.cancelSuccessRate,
      current.sampleCount,
    ),
    partialFillRate: weightedAverage(
      baseline.partialFillRate,
      baseline.sampleCount,
      current.partialFillRate,
      current.sampleCount,
    ),
    makerPunished: baseline.makerPunished || current.makerPunished,
    notes: unique([...baseline.notes, ...current.notes]),
  };
}

function weightedAverage(
  priorValue: number,
  priorWeight: number,
  nextValue: number,
  nextWeight: number,
): number {
  if (priorWeight <= 0) {
    return nextWeight > 0 ? nextValue : 0;
  }
  if (nextWeight <= 0) {
    return priorValue;
  }
  return (priorValue * priorWeight + nextValue * nextWeight) / (priorWeight + nextWeight);
}

function weightedAverageNullable(
  priorValue: number | null,
  priorWeight: number,
  nextValue: number | null,
  nextWeight: number,
): number | null {
  if (priorValue == null) {
    return nextValue;
  }
  if (nextValue == null) {
    return priorValue;
  }
  return weightedAverage(priorValue, priorWeight, nextValue, nextWeight);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
