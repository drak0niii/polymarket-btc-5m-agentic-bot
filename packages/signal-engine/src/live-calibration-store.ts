import type {
  CalibrationState,
  LearningState,
} from '@polymarket-btc-5m-agentic-bot/domain';

export interface CalibrationPersistenceAdapter {
  loadState(): Promise<LearningState>;
  saveState(state: LearningState): Promise<void>;
}

export class LiveCalibrationStore {
  constructor(private readonly adapter: CalibrationPersistenceAdapter) {}

  async getAll(): Promise<Record<string, CalibrationState>> {
    const state = await this.adapter.loadState();
    return state.calibration;
  }

  async get(contextKey: string): Promise<CalibrationState | null> {
    const state = await this.adapter.loadState();
    return state.calibration[contextKey] ?? null;
  }

  async getForStrategy(
    strategyVariantId: string,
    regime: string | null,
  ): Promise<CalibrationState | null> {
    const state = await this.adapter.loadState();
    const exactKey = buildCalibrationContextKey(strategyVariantId, regime);
    if (state.calibration[exactKey]) {
      return state.calibration[exactKey];
    }

    return state.calibration[buildCalibrationContextKey(strategyVariantId, null)] ?? null;
  }

  async saveAll(calibration: Record<string, CalibrationState>): Promise<void> {
    const state = await this.adapter.loadState();
    await this.adapter.saveState({
      ...state,
      calibration,
      updatedAt: new Date().toISOString(),
    });
  }
}

export function buildCalibrationContextKey(
  strategyVariantId: string,
  regime: string | null,
): string {
  return `strategy:${normalizeKeyPart(strategyVariantId)}|regime:${normalizeKeyPart(
    regime ?? 'all',
  )}`;
}

function normalizeKeyPart(value: string): string {
  return value.trim().length > 0 ? value.trim() : 'unknown';
}
