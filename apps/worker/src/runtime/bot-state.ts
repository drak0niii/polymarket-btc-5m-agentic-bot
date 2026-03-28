import fsSync from 'fs';
import path from 'path';
import type { TradingOperatingMode } from '@polymarket-btc-5m-agentic-bot/domain';
import {
  BotRuntimeState,
  canTransitionRuntimeState,
  permissionsForRuntimeState,
} from './runtime-state-machine';
import { resolveRepositoryRoot } from './learning-state-store';

export type { BotRuntimeState } from './runtime-state-machine';

interface PersistedBotState {
  state: BotRuntimeState;
  operatingMode: TradingOperatingMode;
  reason: string | null;
  updatedAt: string;
}

export class BotStateStore {
  private state: BotRuntimeState;
  private operatingMode: TradingOperatingMode;
  private reason: string | null = null;
  private updatedAt: string = new Date().toISOString();
  private readonly stateFilePath: string;
  private readonly onTransition?:
    | ((input: { state: BotRuntimeState; reason: string; updatedAt: string }) => void)
    | undefined;

  constructor(
    initialState: BotRuntimeState,
    onTransition?: (input: {
      state: BotRuntimeState;
      reason: string;
      updatedAt: string;
    }) => void,
    initialOperatingMode: TradingOperatingMode = 'live_trading',
    stateFilePath = path.join(
      resolveRepositoryRoot(),
      'artifacts/runtime/bot-state.latest.json',
    ),
  ) {
    this.stateFilePath = stateFilePath;
    const persisted = this.readPersistedState();
    this.state = persisted?.state ?? initialState;
    this.operatingMode = persisted?.operatingMode ?? initialOperatingMode;
    this.reason = persisted?.reason ?? null;
    this.updatedAt = persisted?.updatedAt ?? new Date().toISOString();
    this.onTransition = onTransition;
    this.persistState();
  }

  getState(): BotRuntimeState {
    return this.state;
  }

  getReason(): string | null {
    return this.reason;
  }

  getOperatingMode(): TradingOperatingMode {
    return this.operatingMode;
  }

  getUpdatedAt(): string {
    return this.updatedAt;
  }

  isSentinelEnabled(): boolean {
    return this.operatingMode === 'sentinel_simulation';
  }

  isRunning(): boolean {
    return this.state === 'running';
  }

  canAcceptNewEntries(): boolean {
    return permissionsForRuntimeState(this.state).allowNewEntries;
  }

  canEvaluateStrategy(): boolean {
    return permissionsForRuntimeState(this.state).allowStrategyEvaluation;
  }

  canSubmitOrders(): boolean {
    return permissionsForRuntimeState(this.state).allowOrderSubmit;
  }

  canCancelOrders(): boolean {
    return permissionsForRuntimeState(this.state).allowOrderCancel;
  }

  canEmergencyCancelOrders(): boolean {
    return permissionsForRuntimeState(this.state).allowEmergencyCancel;
  }

  canReconcile(): boolean {
    return permissionsForRuntimeState(this.state).allowReconciliation;
  }

  canRefreshPortfolio(): boolean {
    return permissionsForRuntimeState(this.state).allowPortfolioRefresh;
  }

  canHeartbeat(): boolean {
    return permissionsForRuntimeState(this.state).allowHeartbeat;
  }

  setState(nextState: BotRuntimeState, reason: string): void {
    if (!canTransitionRuntimeState(this.state, nextState)) {
      throw new Error(
        `Illegal runtime state transition from ${this.state} to ${nextState}.`,
      );
    }

    this.state = nextState;
    this.reason = reason;
    this.updatedAt = new Date().toISOString();
    this.persistState();
    this.onTransition?.({
      state: this.state,
      reason: this.reason,
      updatedAt: this.updatedAt,
    });
  }

  setOperatingMode(nextMode: TradingOperatingMode, reason: string): void {
    if (this.operatingMode === nextMode) {
      return;
    }

    this.operatingMode = nextMode;
    this.reason = reason;
    this.updatedAt = new Date().toISOString();
    this.persistState();
  }

  refreshOperatingModeFromDisk(): TradingOperatingMode {
    const persisted = this.readPersistedState();
    if (!persisted || persisted.operatingMode === this.operatingMode) {
      return this.operatingMode;
    }

    this.operatingMode = persisted.operatingMode;
    this.reason = persisted.reason ?? this.reason;
    this.updatedAt = persisted.updatedAt ?? this.updatedAt;
    return this.operatingMode;
  }

  private readPersistedState(): PersistedBotState | null {
    try {
      const content = fsSync.readFileSync(this.stateFilePath, 'utf8');
      const parsed = JSON.parse(content) as Partial<PersistedBotState>;
      if (
        typeof parsed.state !== 'string' ||
        typeof parsed.operatingMode !== 'string' ||
        (parsed.operatingMode !== 'live_trading' &&
          parsed.operatingMode !== 'sentinel_simulation')
      ) {
        return null;
      }

      return {
        state: parsed.state as BotRuntimeState,
        operatingMode: parsed.operatingMode,
        reason: typeof parsed.reason === 'string' ? parsed.reason : null,
        updatedAt:
          typeof parsed.updatedAt === 'string'
            ? parsed.updatedAt
            : new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  private persistState(): void {
    fsSync.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
    const persisted: PersistedBotState = {
      state: this.state,
      operatingMode: this.operatingMode,
      reason: this.reason,
      updatedAt: this.updatedAt,
    };
    fsSync.writeFileSync(
      this.stateFilePath,
      `${JSON.stringify(persisted, null, 2)}\n`,
      'utf8',
    );
  }
}
