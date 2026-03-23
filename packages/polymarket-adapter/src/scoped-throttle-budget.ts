import { PolymarketVenueRequestScope } from './polymarket-venue-awareness';

export interface ScopedBudgetPolicy {
  minIntervalMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  retryCeiling: number;
}

export interface ScopedBudgetSnapshot {
  nextAllowedAt: number;
  consecutiveFailures: number;
  retryCeiling: number;
}

const DEFAULT_POLICY: Record<PolymarketVenueRequestScope, ScopedBudgetPolicy> = {
  public: { minIntervalMs: 75, baseBackoffMs: 250, maxBackoffMs: 5_000, retryCeiling: 4 },
  private: { minIntervalMs: 150, baseBackoffMs: 500, maxBackoffMs: 8_000, retryCeiling: 3 },
  submit: { minIntervalMs: 250, baseBackoffMs: 1_000, maxBackoffMs: 10_000, retryCeiling: 1 },
  cancel: { minIntervalMs: 100, baseBackoffMs: 400, maxBackoffMs: 6_000, retryCeiling: 2 },
  heartbeat: { minIntervalMs: 1_000, baseBackoffMs: 200, maxBackoffMs: 4_000, retryCeiling: 2 },
  websocket_reconnect: {
    minIntervalMs: 500,
    baseBackoffMs: 1_000,
    maxBackoffMs: 15_000,
    retryCeiling: 5,
  },
};

export class ScopedThrottleBudget {
  private readonly nextAllowedAt = new Map<PolymarketVenueRequestScope, number>();
  private readonly consecutiveFailures = new Map<PolymarketVenueRequestScope, number>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly policy: Partial<Record<PolymarketVenueRequestScope, ScopedBudgetPolicy>> = {},
  ) {}

  policyFor(scope: PolymarketVenueRequestScope): ScopedBudgetPolicy {
    return this.policy[scope] ?? DEFAULT_POLICY[scope];
  }

  async awaitTurn(
    scope: PolymarketVenueRequestScope,
    sleep: (ms: number) => Promise<void>,
  ): Promise<void> {
    const waitMs = Math.max(0, (this.nextAllowedAt.get(scope) ?? 0) - this.now());
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    this.nextAllowedAt.set(scope, this.now() + this.policyFor(scope).minIntervalMs);
  }

  recordSuccess(scope: PolymarketVenueRequestScope): void {
    this.consecutiveFailures.set(scope, 0);
  }

  recordFailure(
    scope: PolymarketVenueRequestScope,
    retryable: boolean,
    retryAfterMs?: number | null,
  ): void {
    if (!retryable) {
      return;
    }
    const failures = (this.consecutiveFailures.get(scope) ?? 0) + 1;
    this.consecutiveFailures.set(scope, failures);
    const policy = this.policyFor(scope);
    const backoffMs =
      retryAfterMs && retryAfterMs > 0
        ? retryAfterMs
        : Math.min(policy.maxBackoffMs, policy.baseBackoffMs * 2 ** (failures - 1));
    this.nextAllowedAt.set(scope, Math.max(this.nextAllowedAt.get(scope) ?? 0, this.now() + backoffMs));
  }

  canRetry(scope: PolymarketVenueRequestScope): boolean {
    return (this.consecutiveFailures.get(scope) ?? 0) < this.policyFor(scope).retryCeiling;
  }

  snapshot(scope: PolymarketVenueRequestScope): ScopedBudgetSnapshot {
    return {
      nextAllowedAt: this.nextAllowedAt.get(scope) ?? 0,
      consecutiveFailures: this.consecutiveFailures.get(scope) ?? 0,
      retryCeiling: this.policyFor(scope).retryCeiling,
    };
  }
}
