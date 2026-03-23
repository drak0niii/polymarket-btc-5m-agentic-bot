import {
  ScopedBudgetPolicy,
  ScopedThrottleBudget,
} from './scoped-throttle-budget';

export type PolymarketVenueRequestScope =
  | 'public'
  | 'private'
  | 'submit'
  | 'cancel'
  | 'heartbeat'
  | 'websocket_reconnect';

export type PolymarketVenueErrorCategory =
  | 'geoblocked'
  | 'closed_only'
  | 'rate_limited'
  | 'auth'
  | 'clock_skew'
  | 'network'
  | 'server'
  | 'validation'
  | 'unknown';

export interface PolymarketVenueAwarenessConfig {
  host: string;
  maxClockSkewMs?: number;
  minIntervalMsByScope?: Partial<Record<PolymarketVenueRequestScope, number>>;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PolymarketNormalizedVenueError {
  scope: PolymarketVenueRequestScope;
  operation: string;
  category: PolymarketVenueErrorCategory;
  reasonCode:
    | 'venue_geoblocked'
    | 'venue_closed_only'
    | 'rate_limited'
    | 'auth_failed'
    | 'clock_skew_detected'
    | 'network_unavailable'
    | 'server_unavailable'
    | 'venue_validation_failed'
    | 'venue_unknown_error';
  message: string;
  httpStatus: number | null;
  retryable: boolean;
  retryAfterMs: number | null;
  raw: unknown;
}

export interface PolymarketVenueGovernanceSnapshot {
  nextAllowedAtByScope: Record<PolymarketVenueRequestScope, number>;
  consecutiveFailuresByScope: Record<PolymarketVenueRequestScope, number>;
}

export interface PolymarketVenueStartupPreflight {
  ready: boolean;
  reasonCode:
    | null
    | 'venue_ok_probe_failed'
    | 'venue_geoblocked'
    | 'clock_skew_probe_failed'
    | 'clock_skew_exceeds_limit'
    | 'venue_closed_only'
    | 'closed_only_probe_failed';
  details: {
    host: string;
    publicProbeOk: boolean;
    serverTimeMs: number | null;
    localTimeMs: number;
    clockSkewMs: number | null;
    maxClockSkewMs: number;
    closedOnly: boolean | null;
  };
}

export class PolymarketVenueError extends Error {
  constructor(readonly normalized: PolymarketNormalizedVenueError) {
    super(`[${normalized.reasonCode}] ${normalized.message}`);
    this.name = 'PolymarketVenueError';
  }
}

const DEFAULT_MIN_INTERVAL_MS_BY_SCOPE: Record<PolymarketVenueRequestScope, number> = {
  public: 75,
  private: 150,
  submit: 250,
  cancel: 100,
  heartbeat: 1_000,
  websocket_reconnect: 500,
};

export class PolymarketVenueAwareness {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxClockSkewMs: number;
  private readonly throttleBudget: ScopedThrottleBudget;

  constructor(private readonly config: PolymarketVenueAwarenessConfig) {
    this.now = config.now ?? (() => Date.now());
    this.sleep =
      config.sleep ??
      (async (ms: number) => {
        await new Promise((resolve) => {
          setTimeout(resolve, ms);
        });
      });
    this.maxClockSkewMs = Math.max(0, config.maxClockSkewMs ?? 5_000);
    this.throttleBudget = new ScopedThrottleBudget(
      this.now,
      this.buildBudgetPolicy(),
    );
  }

  async execute<T>(
    scope: PolymarketVenueRequestScope,
    operation: string,
    action: () => Promise<T>,
  ): Promise<T> {
    await this.awaitTurn(scope);

    try {
      const result = await action();
      this.recordSuccess(scope);
      return result;
    } catch (error) {
      const normalized = this.normalizeError(error, { scope, operation });
      this.recordFailure(scope, normalized);
      throw new PolymarketVenueError(normalized);
    }
  }

  async preflightStartup(input: {
    getOk: () => Promise<unknown>;
    getServerTime: () => Promise<number>;
    getClosedOnlyMode: () => Promise<unknown>;
  }): Promise<PolymarketVenueStartupPreflight> {
    const details: PolymarketVenueStartupPreflight['details'] = {
      host: this.config.host,
      publicProbeOk: false,
      serverTimeMs: null,
      localTimeMs: this.now(),
      clockSkewMs: null,
      maxClockSkewMs: this.maxClockSkewMs,
      closedOnly: null,
    };

    try {
      await this.execute('public', 'venue_ok_probe', input.getOk);
      details.publicProbeOk = true;
    } catch (error) {
      const normalized = this.fromUnknown(error, {
        scope: 'public',
        operation: 'venue_ok_probe',
      });
      return {
        ready: false,
        reasonCode:
          normalized.reasonCode === 'venue_geoblocked'
            ? 'venue_geoblocked'
            : 'venue_ok_probe_failed',
        details,
      };
    }

    try {
      const serverTime = await this.execute(
        'public',
        'server_time_probe',
        input.getServerTime,
      );
      details.serverTimeMs = this.normalizeServerTimeMs(serverTime);
      details.localTimeMs = this.now();
      details.clockSkewMs = Math.abs(details.localTimeMs - details.serverTimeMs);

      if (details.clockSkewMs > this.maxClockSkewMs) {
        return {
          ready: false,
          reasonCode: 'clock_skew_exceeds_limit',
          details,
        };
      }
    } catch {
      return {
        ready: false,
        reasonCode: 'clock_skew_probe_failed',
        details,
      };
    }

    try {
      const response = await this.execute(
        'private',
        'closed_only_probe',
        input.getClosedOnlyMode,
      );
      details.closedOnly = this.readClosedOnly(response);
      if (details.closedOnly) {
        return {
          ready: false,
          reasonCode: 'venue_closed_only',
          details,
        };
      }
    } catch (error) {
      const normalized = this.fromUnknown(error, {
        scope: 'private',
        operation: 'closed_only_probe',
      });
      return {
        ready: false,
        reasonCode:
          normalized.reasonCode === 'venue_geoblocked'
            ? 'venue_geoblocked'
            : 'closed_only_probe_failed',
        details,
      };
    }

    return {
      ready: true,
      reasonCode: null,
      details,
    };
  }

  getGovernanceSnapshot(): PolymarketVenueGovernanceSnapshot {
    const scopes: PolymarketVenueRequestScope[] = [
      'public',
      'private',
      'submit',
      'cancel',
      'heartbeat',
      'websocket_reconnect',
    ];

    return {
      nextAllowedAtByScope: Object.fromEntries(
        scopes.map((scope) => [scope, this.throttleBudget.snapshot(scope).nextAllowedAt]),
      ) as Record<PolymarketVenueRequestScope, number>,
      consecutiveFailuresByScope: Object.fromEntries(
        scopes.map((scope) => [scope, this.throttleBudget.snapshot(scope).consecutiveFailures]),
      ) as Record<PolymarketVenueRequestScope, number>,
    };
  }

  normalizeError(
    error: unknown,
    context: {
      scope: PolymarketVenueRequestScope;
      operation: string;
    },
  ): PolymarketNormalizedVenueError {
    if (error instanceof PolymarketVenueError) {
      return error.normalized;
    }

    const status = this.readStatus(error);
    const rawMessage = this.readMessage(error);
    const rawPayload = this.readPayload(error);
    const message = rawMessage ?? this.stringifyPayload(rawPayload) ?? 'Unknown Polymarket error.';
    const searchable = `${message} ${this.stringifyPayload(rawPayload) ?? ''}`.toLowerCase();
    const retryAfterMs = this.readRetryAfterMs(rawPayload, message);

    if (
      status === 451 ||
      ((status === 403 || status === 401) &&
        /(geo|geoblock|restricted|location|jurisdiction|country)/.test(searchable))
    ) {
      return this.buildNormalizedError({
        context,
        category: 'geoblocked',
        reasonCode: 'venue_geoblocked',
        message,
        status,
        retryable: false,
        retryAfterMs,
        raw: error,
      });
    }

    if (/closed[_ -]?only/.test(searchable)) {
      return this.buildNormalizedError({
        context,
        category: 'closed_only',
        reasonCode: 'venue_closed_only',
        message,
        status,
        retryable: false,
        retryAfterMs,
        raw: error,
      });
    }

    if (
      status === 429 ||
      /too many requests|rate limit|rate-limited|retry later/.test(searchable)
    ) {
      return this.buildNormalizedError({
        context,
        category: 'rate_limited',
        reasonCode: 'rate_limited',
        message,
        status,
        retryable: true,
        retryAfterMs,
        raw: error,
      });
    }

    if (
      /server time|clock skew|timestamp|nonce|expired/.test(searchable)
    ) {
      return this.buildNormalizedError({
        context,
        category: 'clock_skew',
        reasonCode: 'clock_skew_detected',
        message,
        status,
        retryable: false,
        retryAfterMs,
        raw: error,
      });
    }

    if (
      status === 401 ||
      /unauthorized|forbidden|api key|passphrase|signature|credentials are needed|signer is needed|auth failed/.test(
        searchable,
      )
    ) {
      return this.buildNormalizedError({
        context,
        category: 'auth',
        reasonCode: 'auth_failed',
        message,
        status,
        retryable: false,
        retryAfterMs,
        raw: error,
      });
    }

    if (
      /timeout|timed out|network|socket hang up|econn|enetunreach|eai_again|fetch failed/.test(
        searchable,
      )
    ) {
      return this.buildNormalizedError({
        context,
        category: 'network',
        reasonCode: 'network_unavailable',
        message,
        status,
        retryable: true,
        retryAfterMs,
        raw: error,
      });
    }

    if (status != null && status >= 500) {
      return this.buildNormalizedError({
        context,
        category: 'server',
        reasonCode: 'server_unavailable',
        message,
        status,
        retryable: true,
        retryAfterMs,
        raw: error,
      });
    }

    if (
      status === 400 ||
      status === 422 ||
      /invalid|unsupported|required|must be|validation|failed before submit/.test(searchable)
    ) {
      return this.buildNormalizedError({
        context,
        category: 'validation',
        reasonCode: 'venue_validation_failed',
        message,
        status,
        retryable: false,
        retryAfterMs,
        raw: error,
      });
    }

    return this.buildNormalizedError({
      context,
      category: 'unknown',
      reasonCode: 'venue_unknown_error',
      message,
      status,
      retryable: false,
      retryAfterMs,
      raw: error,
    });
  }

  fromUnknown(
    error: unknown,
    context: {
      scope: PolymarketVenueRequestScope;
      operation: string;
    },
  ): PolymarketNormalizedVenueError {
    return this.normalizeError(error, context);
  }

  private async awaitTurn(scope: PolymarketVenueRequestScope): Promise<void> {
    await this.throttleBudget.awaitTurn(scope, this.sleep);
  }

  private recordSuccess(scope: PolymarketVenueRequestScope): void {
    this.throttleBudget.recordSuccess(scope);
  }

  private recordFailure(
    scope: PolymarketVenueRequestScope,
    normalized: PolymarketNormalizedVenueError,
  ): void {
    this.throttleBudget.recordFailure(
      scope,
      normalized.retryable,
      normalized.retryAfterMs,
    );
  }

  private buildBudgetPolicy(): Partial<
    Record<PolymarketVenueRequestScope, ScopedBudgetPolicy>
  > {
    const minIntervalMsByScope = {
      ...DEFAULT_MIN_INTERVAL_MS_BY_SCOPE,
      ...(this.config.minIntervalMsByScope ?? {}),
    };
    const baseBackoffMs = Math.max(100, this.config.baseBackoffMs ?? 1_000);
    const maxBackoffMs = Math.max(baseBackoffMs, this.config.maxBackoffMs ?? 15_000);

    return Object.fromEntries(
      (Object.keys(minIntervalMsByScope) as PolymarketVenueRequestScope[]).map((scope) => [
        scope,
        {
          minIntervalMs: minIntervalMsByScope[scope],
          baseBackoffMs,
          maxBackoffMs,
          retryCeiling:
            scope === 'submit'
              ? 1
              : scope === 'cancel'
                ? 2
                : scope === 'websocket_reconnect'
                  ? 5
                  : scope === 'heartbeat'
                    ? 2
                    : 4,
        },
      ]),
    ) as Partial<Record<PolymarketVenueRequestScope, ScopedBudgetPolicy>>;
  }

  private buildNormalizedError(input: {
    context: {
      scope: PolymarketVenueRequestScope;
      operation: string;
    };
    category: PolymarketVenueErrorCategory;
    reasonCode: PolymarketNormalizedVenueError['reasonCode'];
    message: string;
    status: number | null;
    retryable: boolean;
    retryAfterMs: number | null;
    raw: unknown;
  }): PolymarketNormalizedVenueError {
    return {
      scope: input.context.scope,
      operation: input.context.operation,
      category: input.category,
      reasonCode: input.reasonCode,
      message: input.message,
      httpStatus: input.status,
      retryable: input.retryable,
      retryAfterMs: input.retryAfterMs,
      raw: input.raw,
    };
  }

  private readStatus(error: unknown): number | null {
    if (!error || typeof error !== 'object') {
      return null;
    }

    const record = error as Record<string, unknown>;
    const direct = Number(record.status ?? Number.NaN);
    if (Number.isFinite(direct)) {
      return direct;
    }

    const response = record.response;
    if (response && typeof response === 'object') {
      const responseStatus = Number(
        (response as Record<string, unknown>).status ?? Number.NaN,
      );
      if (Number.isFinite(responseStatus)) {
        return responseStatus;
      }
    }

    const normalized = record.normalized;
    if (normalized && typeof normalized === 'object') {
      const normalizedStatus = Number(
        (normalized as Record<string, unknown>).httpStatus ?? Number.NaN,
      );
      if (Number.isFinite(normalizedStatus)) {
        return normalizedStatus;
      }
    }

    return null;
  }

  private readMessage(error: unknown): string | null {
    if (error instanceof Error) {
      return error.message;
    }
    if (!error || typeof error !== 'object') {
      return typeof error === 'string' ? error : null;
    }

    const record = error as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim().length > 0) {
      return record.message;
    }
    if (typeof record.error === 'string' && record.error.trim().length > 0) {
      return record.error;
    }
    return null;
  }

  private readPayload(error: unknown): unknown {
    if (!error || typeof error !== 'object') {
      return null;
    }

    const record = error as Record<string, unknown>;
    if (record.data != null) {
      return record.data;
    }

    if (record.response && typeof record.response === 'object') {
      return (record.response as Record<string, unknown>).data ?? null;
    }

    return null;
  }

  private readRetryAfterMs(payload: unknown, message: string): number | null {
    if (payload && typeof payload === 'object') {
      const record = payload as Record<string, unknown>;
      const directMs = Number(
        record.retryAfterMs ??
          record.retry_after_ms ??
          record.retryAfter ??
          Number.NaN,
      );
      if (Number.isFinite(directMs) && directMs > 0) {
        return directMs;
      }

      const retryAfterSeconds = Number(record.retry_after ?? Number.NaN);
      if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
        return retryAfterSeconds * 1_000;
      }
    }

    const secondsMatch = message.match(/retry after (\d+(?:\.\d+)?)s/i);
    if (secondsMatch) {
      return Math.round(Number(secondsMatch[1]) * 1_000);
    }

    const msMatch = message.match(/retry after (\d+)ms/i);
    if (msMatch) {
      return Number(msMatch[1]);
    }

    return null;
  }

  private readClosedOnly(response: unknown): boolean {
    if (!response || typeof response !== 'object') {
      return false;
    }

    const record = response as Record<string, unknown>;
    return record.closed_only === true || record.closedOnly === true;
  }

  private stringifyPayload(payload: unknown): string | null {
    if (payload == null) {
      return null;
    }

    if (typeof payload === 'string') {
      return payload;
    }

    try {
      return JSON.stringify(payload);
    } catch {
      return String(payload);
    }
  }

  private normalizeServerTimeMs(serverTime: number): number {
    if (!Number.isFinite(serverTime) || serverTime <= 0) {
      throw new Error('Polymarket server time probe returned an invalid timestamp.');
    }

    return serverTime < 1_000_000_000_000 ? Math.round(serverTime * 1_000) : serverTime;
  }
}
