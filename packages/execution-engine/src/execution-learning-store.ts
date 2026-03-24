import type {
  ExecutionLearningContext,
  ExecutionLearningState,
  LearningState,
} from '@polymarket-btc-5m-agentic-bot/domain';

export interface ExecutionLearningPersistenceAdapter {
  loadState(): Promise<LearningState>;
  saveState(state: LearningState): Promise<void>;
}

export class ExecutionLearningStore {
  constructor(private readonly adapter: ExecutionLearningPersistenceAdapter) {}

  async getState(): Promise<ExecutionLearningState> {
    const state = await this.adapter.loadState();
    return state.executionLearning;
  }

  async getContext(contextKey: string): Promise<ExecutionLearningContext | null> {
    const state = await this.getState();
    return state.contexts[contextKey] ?? null;
  }

  async getForStrategy(
    strategyVariantId: string,
    regime: string | null,
  ): Promise<ExecutionLearningContext | null> {
    const state = await this.getState();
    const exactKey = buildExecutionLearningContextKey(strategyVariantId, regime);
    if (state.contexts[exactKey]) {
      return state.contexts[exactKey] ?? null;
    }

    return state.contexts[buildExecutionLearningContextKey(strategyVariantId, null)] ?? null;
  }

  async getAllForStrategy(strategyVariantId: string): Promise<ExecutionLearningContext[]> {
    const state = await this.getState();
    return Object.values(state.contexts)
      .filter((context) => context.strategyVariantId === strategyVariantId)
      .sort((left, right) => left.contextKey.localeCompare(right.contextKey));
  }

  async saveState(executionLearning: ExecutionLearningState): Promise<void> {
    const state = await this.adapter.loadState();
    await this.adapter.saveState({
      ...state,
      executionLearning,
      updatedAt: new Date().toISOString(),
    });
  }
}

export function buildExecutionLearningContextKey(
  strategyVariantId: string,
  regime: string | null,
): string {
  return `execution:strategy:${normalizeKeyPart(strategyVariantId)}|regime:${normalizeKeyPart(
    regime ?? 'all',
  )}`;
}

function normalizeKeyPart(value: string): string {
  return value.trim().length > 0 ? value.trim() : 'unknown';
}
