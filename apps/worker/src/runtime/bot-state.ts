import {
  BotRuntimeState,
  canTransitionRuntimeState,
  permissionsForRuntimeState,
} from './runtime-state-machine';

export type { BotRuntimeState } from './runtime-state-machine';

export class BotStateStore {
  private state: BotRuntimeState;
  private reason: string | null = null;
  private updatedAt: string = new Date().toISOString();
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
  ) {
    this.state = initialState;
    this.onTransition = onTransition;
  }

  getState(): BotRuntimeState {
    return this.state;
  }

  getReason(): string | null {
    return this.reason;
  }

  getUpdatedAt(): string {
    return this.updatedAt;
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
    this.onTransition?.({
      state: this.state,
      reason: this.reason,
      updatedAt: this.updatedAt,
    });
  }
}
