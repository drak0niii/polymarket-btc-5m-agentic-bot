import type {
  ExecutionLearningState,
  ExecutionPolicyMode,
  ExecutionPolicyVersion,
  HealthLabel,
  LearningState,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { createDefaultExecutionLearningContext } from '@polymarket-btc-5m-agentic-bot/domain';
import { buildExecutionLearningContextKey } from './execution-learning-store';

export interface ExecutionPolicyVersionPersistenceAdapter {
  loadState(): Promise<LearningState>;
  saveState(state: LearningState): Promise<void>;
}

export class ExecutionPolicyVersionStore {
  constructor(private readonly adapter: ExecutionPolicyVersionPersistenceAdapter) {}

  async getState(): Promise<ExecutionLearningState> {
    const state = await this.adapter.loadState();
    return state.executionLearning;
  }

  async getActiveVersion(contextKey: string): Promise<ExecutionPolicyVersion | null> {
    const state = await this.getState();
    const versionId = state.activePolicyVersionIds[contextKey];
    return versionId ? state.policyVersions[versionId] ?? null : null;
  }

  async getActiveVersionForStrategy(
    strategyVariantId: string,
    regime: string | null,
  ): Promise<ExecutionPolicyVersion | null> {
    const exactKey = buildExecutionLearningContextKey(strategyVariantId, regime);
    const exact = await this.getActiveVersion(exactKey);
    if (exact) {
      return exact;
    }

    return this.getActiveVersion(buildExecutionLearningContextKey(strategyVariantId, null));
  }

  createVersion(input: {
    state: ExecutionLearningState;
    contextKey: string;
    strategyVariantId: string;
    regime: string | null;
    mode: ExecutionPolicyMode;
    recommendedRoute: 'maker' | 'taker';
    recommendedExecutionStyle: 'rest' | 'cross';
    sampleCount: number;
    makerFillRateAssumption: number;
    takerFillRateAssumption: number;
    expectedFillDelayMs: number | null;
    expectedSlippage: number;
    adverseSelectionScore: number;
    cancelSuccessRate: number;
    partialFillRate: number;
    health: HealthLabel;
    rationale: string[];
    sourceCycleId: string | null;
    now?: Date;
  }): {
    nextState: ExecutionLearningState;
    version: ExecutionPolicyVersion;
    changed: boolean;
  } {
    const now = input.now ?? new Date();
    const currentVersionId = input.state.activePolicyVersionIds[input.contextKey] ?? null;
    const currentVersion =
      currentVersionId != null ? input.state.policyVersions[currentVersionId] ?? null : null;

    const proposed = {
      mode: input.mode,
      recommendedRoute: input.recommendedRoute,
      recommendedExecutionStyle: input.recommendedExecutionStyle,
      makerFillRateAssumption: input.makerFillRateAssumption,
      takerFillRateAssumption: input.takerFillRateAssumption,
      expectedFillDelayMs: input.expectedFillDelayMs,
      expectedSlippage: input.expectedSlippage,
      adverseSelectionScore: input.adverseSelectionScore,
      cancelSuccessRate: input.cancelSuccessRate,
      partialFillRate: input.partialFillRate,
      health: input.health,
    };
    if (currentVersion && !hasMaterialPolicyChange(currentVersion, proposed)) {
      return {
        nextState: input.state,
        version: currentVersion,
        changed: false,
      };
    }

    const sequence =
      Object.values(input.state.policyVersions).filter(
        (version) => version.contextKey === input.contextKey,
      ).length + 1;
    const versionId = `execution-policy:${sanitizeContextKey(input.contextKey)}:v${sequence}`;
    const version: ExecutionPolicyVersion = {
      versionId,
      contextKey: input.contextKey,
      strategyVariantId: input.strategyVariantId,
      regime: input.regime,
      mode: input.mode,
      recommendedRoute: input.recommendedRoute,
      recommendedExecutionStyle: input.recommendedExecutionStyle,
      sampleCount: input.sampleCount,
      makerFillRateAssumption: input.makerFillRateAssumption,
      takerFillRateAssumption: input.takerFillRateAssumption,
      expectedFillDelayMs: input.expectedFillDelayMs,
      expectedSlippage: input.expectedSlippage,
      adverseSelectionScore: input.adverseSelectionScore,
      cancelSuccessRate: input.cancelSuccessRate,
      partialFillRate: input.partialFillRate,
      health: input.health,
      rationale: input.rationale,
      sourceCycleId: input.sourceCycleId,
      supersedesVersionId: currentVersion?.versionId ?? null,
      createdAt: now.toISOString(),
    };
    const context =
      input.state.contexts[input.contextKey] ??
      createDefaultExecutionLearningContext({
        contextKey: input.contextKey,
        strategyVariantId: input.strategyVariantId,
        regime: input.regime,
      });

    return {
      nextState: {
        ...input.state,
        updatedAt: now.toISOString(),
        lastPolicyChangeAt: now.toISOString(),
        policyVersions: {
          ...input.state.policyVersions,
          [versionId]: version,
        },
        activePolicyVersionIds: {
          ...input.state.activePolicyVersionIds,
          [input.contextKey]: versionId,
        },
        contexts: {
          ...input.state.contexts,
          [input.contextKey]: {
            ...context,
            activePolicyVersionId: versionId,
            lastUpdatedAt: now.toISOString(),
          },
        },
      },
      version,
      changed: true,
    };
  }
}

function hasMaterialPolicyChange(
  current: ExecutionPolicyVersion,
  proposed: {
    mode: ExecutionPolicyMode;
    recommendedRoute: 'maker' | 'taker';
    recommendedExecutionStyle: 'rest' | 'cross';
    makerFillRateAssumption: number;
    takerFillRateAssumption: number;
    expectedFillDelayMs: number | null;
    expectedSlippage: number;
    adverseSelectionScore: number;
    cancelSuccessRate: number;
    partialFillRate: number;
    health: HealthLabel;
  },
): boolean {
  if (
    current.mode !== proposed.mode ||
    current.recommendedRoute !== proposed.recommendedRoute ||
    current.recommendedExecutionStyle !== proposed.recommendedExecutionStyle ||
    current.health !== proposed.health
  ) {
    return true;
  }

  return (
    Math.abs(current.makerFillRateAssumption - proposed.makerFillRateAssumption) >= 0.05 ||
    Math.abs(current.takerFillRateAssumption - proposed.takerFillRateAssumption) >= 0.05 ||
    Math.abs((current.expectedFillDelayMs ?? 0) - (proposed.expectedFillDelayMs ?? 0)) >= 2_000 ||
    Math.abs(current.expectedSlippage - proposed.expectedSlippage) >= 0.002 ||
    Math.abs(current.adverseSelectionScore - proposed.adverseSelectionScore) >= 0.05 ||
    Math.abs(current.cancelSuccessRate - proposed.cancelSuccessRate) >= 0.1 ||
    Math.abs(current.partialFillRate - proposed.partialFillRate) >= 0.1
  );
}

function sanitizeContextKey(contextKey: string): string {
  return contextKey.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
