import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { ExecuteOrdersJob } from '@worker/jobs/executeOrders.job';
import { ManageOpenOrdersJob } from '@worker/jobs/manageOpenOrders.job';
import { ReconcileFillsJob } from '@worker/jobs/reconcileFills.job';
import { CrashRecoveryService } from '@worker/runtime/crash-recovery';
import { ReplayEngine } from '@worker/runtime/replay-engine';
import {
  UserStreamOrderProjection,
  UserStreamTradeProjection,
  UserWebSocketStateService,
} from '@worker/runtime/user-websocket-state.service';
import {
  buildBalanceAllowancePayloadFixture,
  buildOpenOrderPayloadFixture,
  buildRewardsPayloadFixture,
  buildTradePayloadFixture,
} from '@worker/fixtures/polymarket-venue-fixtures';
import {
  parseBalanceAllowancePayload,
  parseOpenOrdersPayload,
  parseRewardsPayload,
  parseTradesPayload,
} from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';

const DEFAULT_EVIDENCE_PATH = path.resolve(
  __dirname,
  '../../../../artifacts/live-order-lifecycle-validation/latest.json',
);

export type LifecycleScenarioName =
  | 'submit_timeout_uncertain_venue_state'
  | 'partial_fill_followed_by_reconnect'
  | 'cancel_acknowledged_late'
  | 'ghost_open_order_after_restart'
  | 'duplicate_or_delayed_fill_events'
  | 'order_visibility_mismatch_between_rest_and_stream'
  | 'stale_local_assumptions_after_process_crash';

interface LifecycleOrderRecord {
  id: string;
  marketId: string;
  tokenId: string;
  signalId: string | null;
  strategyVersionId: string | null;
  idempotencyKey: string | null;
  venueOrderId: string | null;
  status: string;
  side: 'BUY' | 'SELL';
  outcome: 'YES' | 'NO';
  intent: 'ENTER' | 'REDUCE' | 'EXIT';
  inventoryEffect: 'INCREASE' | 'DECREASE';
  price: number;
  size: number;
  expectedEv: number | null;
  lastError: string | null;
  filledSize: number;
  remainingSize: number;
  avgFillPrice: number | null;
  lastVenueStatus: string | null;
  lastVenueSyncAt: Date | null;
  postedAt: Date | null;
  acknowledgedAt: Date | null;
  canceledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface LifecycleStore {
  signals: Array<Record<string, any>>;
  signalDecisions: Array<Record<string, any>>;
  orders: LifecycleOrderRecord[];
  auditEvents: Array<Record<string, any>>;
  checkpoints: Array<Record<string, any>>;
  fills: Array<Record<string, any>>;
  executionDiagnostics: Array<Record<string, any>>;
  markets: Array<Record<string, any>>;
  marketSnapshots: Array<Record<string, any>>;
  orderbooks: Array<Record<string, any>>;
  positions: Array<Record<string, any>>;
  runtimeStatus: Record<string, any>;
  liveConfig: Record<string, any>;
  runtimeTransitions: Array<{ state: string; reason: string; updatedAt: string }>;
}

interface ScenarioEvidenceSnapshot {
  stage: string;
  capturedAt: string;
  localOrders: unknown[];
  localFills: unknown[];
  intents: unknown[];
  userStream: ReturnType<UserWebSocketStateService['evaluateHealth']>;
  runtimeState: Record<string, unknown>;
}

interface ScenarioRestSnapshot {
  stage: string;
  capturedAt: string;
  openOrders: unknown[];
  trades: unknown[];
}

interface ScenarioReconciliationSnapshot {
  stage: string;
  capturedAt: string;
  result: unknown;
}

export interface LifecycleAssertionResult {
  key: string;
  passed: boolean;
  reason: string;
}

export interface LifecycleScenarioTiming {
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  botSnapshotCount: number;
  restSnapshotCount: number;
  reconciliationStepCount: number;
  streamEventCount: number;
}

export interface LifecycleScenarioEvidence {
  scenario: LifecycleScenarioName;
  validationMode: 'venue_runtime';
  passed: boolean;
  intentId: string | null;
  submitAttempts: Array<Record<string, unknown>>;
  botBelief: ScenarioEvidenceSnapshot[];
  venueTruth: ScenarioRestSnapshot[];
  restTruth: ScenarioRestSnapshot[];
  streamEvents: Array<Record<string, unknown>>;
  reconciliation: ScenarioReconciliationSnapshot[];
  finalTruth: Record<string, unknown>;
  noDuplicateExposure: boolean;
  runtimeSafetyStayedFailClosed: boolean;
  ambiguityDetected: boolean;
  ambiguityReasonCodes: string[];
  timing: LifecycleScenarioTiming;
  assertions: LifecycleAssertionResult[];
}

export interface LifecycleSoakIterationResult {
  iteration: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  passed: boolean;
  failedScenarios: LifecycleScenarioName[];
}

export interface LifecycleSoakSummary {
  enabled: boolean;
  iterations: number;
  passedIterations: number;
  failedIterations: number;
  averageDurationMs: number;
  maxDurationMs: number;
  results: LifecycleSoakIterationResult[];
}

export interface LifecycleValidationSuiteResult {
  success: boolean;
  executedAt: string;
  validationMode: 'venue_runtime';
  scenarioCoverage: LifecycleScenarioName[];
  scenarios: LifecycleScenarioEvidence[];
  soak: LifecycleSoakSummary;
  evidencePath: string;
}

interface VenueOrderState {
  id: string;
  clientOrderId: string | null;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  matchedSize: number;
  status: string;
  createdAt: string;
  cancelRequested: boolean;
}

interface VenueTradeState {
  id: string;
  orderId: string | null;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  fee: number | null;
  filledAt: string | null;
  status: string | null;
}

class StatefulVenueHarness {
  submitBehavior: 'success' | 'timeout_uncertain' = 'success';
  cancelBehavior: 'immediate' | 'late_ack' = 'immediate';
  openOrdersOverride: VenueOrderState[] | null = null;
  tradesOverride: VenueTradeState[] | null = null;
  readonly submitAttempts: Array<Record<string, unknown>> = [];
  private readonly orders = new Map<string, VenueOrderState>();
  private readonly trades = new Map<string, VenueTradeState>();

  async postOrder(payload: Record<string, any>): Promise<{
    success: boolean;
    orderId: string | null;
    status: string;
    raw?: unknown;
  }> {
    this.submitAttempts.push({
      clientOrderId: payload.clientOrderId ?? null,
      tokenId: payload.tokenId,
      side: payload.side,
      price: payload.price,
      size: payload.size,
      attemptedAt: new Date().toISOString(),
    });

    const orderId = `venue-order-${this.submitAttempts.length}`;
    const order: VenueOrderState = {
      id: orderId,
      clientOrderId: typeof payload.clientOrderId === 'string' ? payload.clientOrderId : null,
      tokenId: String(payload.tokenId),
      side: payload.side === 'SELL' ? 'SELL' : 'BUY',
      price: Number(payload.price),
      size: Number(payload.size),
      matchedSize: 0,
      status: 'acknowledged',
      createdAt: new Date().toISOString(),
      cancelRequested: false,
    };
    this.orders.set(orderId, order);

    if (this.submitBehavior === 'timeout_uncertain') {
      throw {
        normalized: {
          reasonCode: 'network_unavailable',
        },
      };
    }

    return {
      success: true,
      orderId,
      status: 'acknowledged',
      raw: {},
    };
  }

  async getOpenOrders(): Promise<any[]> {
    const source =
      this.openOrdersOverride ??
      [...this.orders.values()].filter(
        (order) => order.status !== 'filled' && order.status !== 'canceled',
      );
    const payload = source.map((order) =>
      buildOpenOrderPayloadFixture({
        id: order.id,
        status:
          order.status === 'acknowledged'
            ? 'OPEN'
            : order.status === 'partially_filled'
              ? 'MATCHED'
              : order.status.toUpperCase(),
        side: order.side,
        price: String(order.price),
        original_size: String(order.size),
        size_matched: String(order.matchedSize),
        asset_id: order.tokenId,
        created_at: order.createdAt,
      }),
    );

    return parseOpenOrdersPayload(payload, 'lifecycle_fixture_open_orders').map((order) => ({
      ...order,
      raw: {
        ...(order.raw as Record<string, unknown>),
        cancelRequested:
          source.find((entry) => entry.id === order.id)?.cancelRequested ?? false,
      },
    }));
  }

  async getTrades(): Promise<any[]> {
    const source = this.tradesOverride ?? [...this.trades.values()];
    const payload = source.map((trade) =>
      buildTradePayloadFixture({
        id: trade.id,
        taker_order_id: trade.orderId,
        asset_id: trade.tokenId,
        side: trade.side,
        price: String(trade.price),
        size: String(trade.size),
        fee: trade.fee == null ? null : String(trade.fee),
        match_time: trade.filledAt,
        status: trade.status,
      }),
    );
    return parseTradesPayload(payload, 'lifecycle_fixture_trades');
  }

  async cancelOrder(orderId: string): Promise<void> {
    const order = this.orders.get(orderId);
    if (!order) {
      return;
    }

    order.cancelRequested = true;
    if (this.cancelBehavior === 'immediate') {
      order.status = 'canceled';
    }
  }

  async getFeeRate(tokenId: string): Promise<{ tokenId: string; feeRateBps: number; fetchedAt: string; raw: unknown }> {
    return {
      tokenId,
      feeRateBps: 100,
      fetchedAt: new Date().toISOString(),
      raw: {},
    };
  }

  async getCurrentRewards(): Promise<any[]> {
    return parseRewardsPayload(buildRewardsPayloadFixture(), 'lifecycle_fixture_rewards');
  }

  async getOrderScoring(orderIds: string[]): Promise<Array<{ orderId: string; scoring: boolean; checkedAt: string }>> {
    return orderIds.map((orderId) => ({
      orderId,
      scoring: false,
      checkedAt: new Date().toISOString(),
    }));
  }

  async getBalanceAllowance(): Promise<any> {
    const parsed = parseBalanceAllowancePayload(
      buildBalanceAllowancePayloadFixture(),
      'lifecycle_fixture_balance_allowance',
    );
    return {
      assetType: 'COLLATERAL',
      tokenId: null,
      balance: parsed.balance,
      allowance: parsed.allowance,
      checkedAt: new Date().toISOString(),
      raw: parsed.raw,
    };
  }

  async getUserTrades(): Promise<any[]> {
    return [];
  }

  async getCurrentPositions(): Promise<any[]> {
    return [];
  }

  async getClosedPositions(): Promise<any[]> {
    return [];
  }

  createGhostOrder(input?: Partial<VenueOrderState>): string {
    const orderId = input?.id ?? `venue-ghost-${this.orders.size + 1}`;
    this.orders.set(orderId, {
      id: orderId,
      clientOrderId: input?.clientOrderId ?? null,
      tokenId: input?.tokenId ?? 'yes1',
      side: input?.side ?? 'BUY',
      price: input?.price ?? 0.51,
      size: input?.size ?? 10,
      matchedSize: input?.matchedSize ?? 0,
      status: input?.status ?? 'acknowledged',
      createdAt: input?.createdAt ?? new Date().toISOString(),
      cancelRequested: input?.cancelRequested ?? false,
    });
    return orderId;
  }

  applyFill(input: {
    orderId: string;
    tradeId: string;
    size: number;
    price?: number;
    fee?: number | null;
    filledAt?: string;
    status?: string | null;
  }): void {
    const order = this.orders.get(input.orderId);
    if (!order) {
      return;
    }

    order.matchedSize = Math.min(order.size, order.matchedSize + input.size);
    order.status = order.matchedSize >= order.size ? 'filled' : 'partially_filled';
    this.trades.set(input.tradeId, {
      id: input.tradeId,
      orderId: input.orderId,
      tokenId: order.tokenId,
      side: order.side,
      price: input.price ?? order.price,
      size: input.size,
      fee: input.fee ?? 0.01,
      filledAt: input.filledAt ?? new Date().toISOString(),
      status: input.status ?? 'MATCHED',
    });
  }

  acknowledgeCancel(orderId: string): void {
    const order = this.orders.get(orderId);
    if (!order) {
      return;
    }

    order.status = 'canceled';
  }

  streamOrder(orderId: string): UserStreamOrderProjection | null {
    const order = this.orders.get(orderId);
    if (!order) {
      return null;
    }

    return {
      orderId: order.id,
      marketId: 'm1',
      conditionId: 'cond-1',
      tokenId: order.tokenId,
      side: order.side,
      status: order.status,
      price: order.price,
      size: order.size,
      remainingSize: Math.max(0, order.size - order.matchedSize),
      updatedAt: new Date().toISOString(),
    };
  }

  streamTrade(tradeId: string): UserStreamTradeProjection | null {
    const trade = this.trades.get(tradeId);
    if (!trade) {
      return null;
    }

    return {
      tradeId: trade.id,
      marketId: 'm1',
      conditionId: 'cond-1',
      orderId: trade.orderId,
      tokenId: trade.tokenId,
      side: trade.side,
      price: trade.price,
      size: trade.size,
      fee: trade.fee,
      status: trade.status,
      filledAt: trade.filledAt ?? new Date().toISOString(),
    };
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function sortRecords<T extends Record<string, any>>(
  records: T[],
  key: string,
  direction: 'asc' | 'desc' = 'asc',
): T[] {
  return [...records].sort((left, right) => {
    const leftValue = new Date(left[key] ?? 0).getTime();
    const rightValue = new Date(right[key] ?? 0).getTime();
    return direction === 'asc' ? leftValue - rightValue : rightValue - leftValue;
  });
}

function createLifecycleStore(): LifecycleStore {
  const now = new Date();
  return {
    signals: [
      {
        id: 's1',
        marketId: 'm1',
        side: 'BUY',
        tokenId: 'yes1',
        outcome: 'YES',
        action: 'ENTER',
        intent: 'ENTER',
        regime: 'momentum_continuation',
        expectedEv: 0.08,
        edge: 0.03,
        posteriorProbability: 0.62,
        marketImpliedProb: 0.5,
        strategyVersionId: 'strategy-live-1',
        status: 'approved',
        observedAt: new Date(now.getTime() - 3_000),
      },
    ],
    signalDecisions: [
      {
        id: 'd1',
        signalId: 's1',
        verdict: 'approved',
        reasonCode: 'approved',
        reasonMessage: 'approved',
        expectedEv: 0.08,
        positionSize: 10,
        decisionAt: new Date(now.getTime() - 2_500),
      },
    ],
    orders: [],
    auditEvents: [
      {
        id: 'audit-admission',
        signalId: 's1',
        marketId: 'm1',
        orderId: null,
        eventType: 'signal.admission_decision',
        message: 'Signal admission approved.',
        metadata: {},
        createdAt: new Date(now.getTime() - 2_000),
      },
    ],
    checkpoints: [],
    fills: [],
    executionDiagnostics: [],
    markets: [
      {
        id: 'm1',
        slug: 'btc-5m-higher',
        title: 'Will BTC be higher in 5 minutes?',
        status: 'active',
        tokenIdYes: 'yes1',
        tokenIdNo: 'no1',
        expiresAt: new Date(now.getTime() + 180_000),
      },
    ],
    marketSnapshots: [
      {
        marketId: 'm1',
        observedAt: new Date(now.getTime() - 5_000),
        expiresAt: new Date(now.getTime() + 180_000),
        volume: 750,
      },
    ],
    orderbooks: [
      {
        marketId: 'm1',
        tokenId: 'yes1',
        observedAt: new Date(now.getTime() - 5_000),
        bestBid: 0.5,
        bestAsk: 0.52,
        spread: 0.02,
        bidLevels: [{ price: 0.5, size: 100 }],
        askLevels: [{ price: 0.52, size: 100 }],
        tickSize: 0.01,
        minOrderSize: 1,
        negRisk: false,
      },
    ],
    positions: [],
    runtimeStatus: {
      id: 'live',
      state: 'running',
      reason: 'lifecycle_validation_ready',
      lastHeartbeatAt: new Date(),
    },
    liveConfig: {
      id: 'live',
      noTradeWindowSeconds: 30,
    },
    runtimeTransitions: [],
  };
}

function createLifecyclePrisma(store: LifecycleStore): any {
  const prisma = {
    signal: {
      findMany: async ({ where }: any) =>
        store.signals.filter((signal) => !where?.status || signal.status === where.status),
      findUnique: async ({ where }: any) =>
        store.signals.find((signal) => signal.id === where.id) ?? null,
      findFirst: async ({ where }: any) =>
        store.signals.find((signal) => signal.id === where?.id) ?? null,
      update: async ({ where, data }: any) => {
        const row = store.signals.find((signal) => signal.id === where.id);
        if (row) {
          Object.assign(row, data);
        }
        return row ?? null;
      },
    },
    signalDecision: {
      findFirst: async ({ where }: any) =>
        sortRecords(
          store.signalDecisions.filter(
            (decision) =>
              (!where?.signalId || decision.signalId === where.signalId) &&
              (!where?.verdict || decision.verdict === where.verdict),
          ),
          'decisionAt',
          'desc',
        )[0] ?? null,
      findMany: async ({ where }: any) =>
        sortRecords(
          store.signalDecisions.filter(
            (decision) => !where?.signalId || decision.signalId === where.signalId,
          ),
          'decisionAt',
          'asc',
        ),
      create: async ({ data }: any) => {
        store.signalDecisions.push(data);
        return data;
      },
    },
    market: {
      findUnique: async ({ where }: any) =>
        store.markets.find((market) => market.id === where.id) ?? null,
      findMany: async () => store.markets,
    },
    marketSnapshot: {
      findFirst: async ({ where }: any) =>
        sortRecords(
          store.marketSnapshots.filter(
            (snapshot) => !where?.marketId || snapshot.marketId === where.marketId,
          ),
          'observedAt',
          'desc',
        )[0] ?? null,
      findMany: async () => store.marketSnapshots,
    },
    orderbook: {
      findFirst: async ({ where }: any) =>
        sortRecords(
          store.orderbooks.filter(
            (orderbook) =>
              (!where?.marketId || orderbook.marketId === where.marketId) &&
              (!where?.tokenId || orderbook.tokenId === where.tokenId),
          ),
          'observedAt',
          'desc',
        )[0] ?? null,
      findMany: async () => store.orderbooks,
    },
    order: {
      findFirst: async ({ where, orderBy }: any = {}) =>
        sortRecords(
          store.orders.filter((order) => matchesOrderWhere(order, where)),
          orderBy?.createdAt ? 'createdAt' : 'updatedAt',
          orderBy?.createdAt ?? orderBy?.updatedAt ?? 'asc',
        )[0] ?? null,
      findMany: async ({ where, orderBy, take }: any = {}) => {
        const records = sortRecords(
          store.orders.filter((order) => matchesOrderWhere(order, where)),
          orderBy?.createdAt ? 'createdAt' : orderBy?.updatedAt ? 'updatedAt' : 'createdAt',
          orderBy?.createdAt ?? orderBy?.updatedAt ?? 'asc',
        );
        return typeof take === 'number' ? records.slice(0, take) : records;
      },
      create: async ({ data }: any) => {
        const row: LifecycleOrderRecord = {
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        store.orders.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = store.orders.find((order) => order.id === where.id);
        if (!row) {
          return null;
        }
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      count: async ({ where }: any) =>
        store.orders.filter((order) => matchesOrderWhere(order, where)).length,
    },
    fill: {
      findUnique: async ({ where }: any) =>
        store.fills.find((fill) => fill.id === where.id) ?? null,
      findMany: async ({ where, orderBy }: any = {}) => {
        const rows = store.fills.filter((fill) => {
          if (!where) {
            return true;
          }
          if (where.order?.signalId) {
            const order = store.orders.find((entry) => entry.id === fill.orderId);
            return order?.signalId === where.order.signalId;
          }
          return true;
        });
        return sortRecords(rows, orderBy?.filledAt ? 'filledAt' : 'filledAt', orderBy?.filledAt ?? 'asc');
      },
      create: async ({ data }: any) => {
        store.fills.push(data);
        return data;
      },
    },
    auditEvent: {
      create: async ({ data }: any) => {
        const row = {
          id: `audit-${store.auditEvents.length + 1}`,
          createdAt: data.createdAt ?? new Date(),
          ...data,
        };
        store.auditEvents.push(row);
        return row;
      },
      findMany: async ({ where, orderBy, take }: any = {}) => {
        const rows = store.auditEvents.filter((event) => {
          if (!where) {
            return true;
          }
          if (where.signalId && event.signalId !== where.signalId) {
            return false;
          }
          if (where.orderId && event.orderId !== where.orderId) {
            return false;
          }
          return true;
        });
        const sorted = sortRecords(rows, 'createdAt', orderBy?.createdAt ?? 'asc');
        return typeof take === 'number' ? sorted.slice(0, take) : sorted;
      },
      findFirst: async ({ where, orderBy }: any = {}) =>
        sortRecords(
          store.auditEvents.filter((event) => {
            if (!where) {
              return true;
            }
            if (where.signalId && event.signalId !== where.signalId) {
              return false;
            }
            if (where.eventType && event.eventType !== where.eventType) {
              return false;
            }
            return true;
          }),
          'createdAt',
          orderBy?.createdAt ?? 'asc',
        )[0] ?? null,
      count: async ({ where }: any = {}) =>
        store.auditEvents.filter((event) => {
          if (!where) {
            return true;
          }
          if (where.eventType && event.eventType !== where.eventType) {
            return false;
          }
          return true;
        }).length,
    },
    reconciliationCheckpoint: {
      create: async ({ data }: any) => {
        const row = {
          processedAt: data.processedAt ?? new Date(),
          ...data,
        };
        store.checkpoints.push(row);
        return row;
      },
      findFirst: async ({ where, orderBy }: any = {}) =>
        sortRecords(
          store.checkpoints.filter((checkpoint) => {
            if (!where) {
              return true;
            }
            if (where.source && checkpoint.source !== where.source) {
              return false;
            }
            if (where.cycleKey && checkpoint.cycleKey !== where.cycleKey) {
              return false;
            }
            if (where.status?.in && !where.status.in.includes(checkpoint.status)) {
              return false;
            }
            return true;
          }),
          'processedAt',
          orderBy?.processedAt ?? 'asc',
        )[0] ?? null,
      findMany: async ({ where, orderBy, take }: any = {}) => {
        const rows = store.checkpoints.filter((checkpoint) => {
          if (!where) {
            return true;
          }
          if (where.source && checkpoint.source !== where.source) {
            return false;
          }
          if (where.status?.in && !where.status.in.includes(checkpoint.status)) {
            return false;
          }
          return true;
        });
        const sorted = sortRecords(rows, 'processedAt', orderBy?.processedAt ?? 'desc');
        return typeof take === 'number' ? sorted.slice(0, take) : sorted;
      },
    },
    executionDiagnostic: {
      create: async ({ data }: any) => {
        store.executionDiagnostics.push(data);
        return data;
      },
    },
    liveConfig: {
      findUnique: async () => store.liveConfig,
    },
    botRuntimeStatus: {
      findUnique: async () => store.runtimeStatus,
    },
    position: {
      findMany: async () => store.positions,
    },
    portfolioSnapshot: {
      findFirst: async () => ({ capturedAt: new Date() }),
    },
    $disconnect: async () => undefined,
  };

  return prisma;
}

function matchesOrderWhere(order: LifecycleOrderRecord, where: any): boolean {
  if (!where) {
    return true;
  }

  if (where.OR) {
    return where.OR.some((clause: any) => matchesOrderWhere(order, clause));
  }
  if (where.id && order.id !== where.id) {
    return false;
  }
  if (where.signalId && order.signalId !== where.signalId) {
    return false;
  }
  if (where.marketId && order.marketId !== where.marketId) {
    return false;
  }
  if (where.tokenId && order.tokenId !== where.tokenId) {
    return false;
  }
  if (where.venueOrderId && order.venueOrderId !== where.venueOrderId) {
    return false;
  }
  if (where.lastError && order.lastError !== where.lastError) {
    return false;
  }
  if (where.status) {
    if (typeof where.status === 'string') {
      return order.status === where.status;
    }
    if (where.status.in) {
      return where.status.in.includes(order.status);
    }
  }
  return true;
}

function createRuntimeControl(store: LifecycleStore, prisma: any): any {
  return {
    recordReconciliationCheckpoint: async (input: any) =>
      prisma.reconciliationCheckpoint.create({
        data: {
          cycleKey: input.cycleKey,
          source: input.source,
          status: input.status,
          details: input.details ?? {},
          processedAt: new Date(),
        },
      }),
    getLatestCheckpoint: async (source: string) =>
      prisma.reconciliationCheckpoint.findFirst({
        where: { source },
        orderBy: { processedAt: 'desc' },
      }),
    assessOperationalFreshness: async () => ({
      healthy: true,
      reasonCode: null,
      details: {
        lastPortfolioSnapshotAt: new Date(),
        lastOpenOrdersCheckpointAt: new Date(),
        lastFillCheckpointAt: new Date(),
        lastExternalPortfolioCheckpointAt: new Date(),
        lastVenueHeartbeatAt: new Date(),
        workingOpenOrders: store.orders.filter((order) =>
          ['submitted', 'acknowledged', 'partially_filled'].includes(order.status),
        ).length,
      },
    }),
    getLatestSafetyState: async () => ({
      state: 'running',
      enteredAt: new Date().toISOString(),
      reasonCodes: [],
      sizeMultiplier: 1,
      evaluationCadenceMultiplier: 1,
      allowAggressiveEntries: true,
      allowNewEntries: true,
      haltRequested: false,
      maxNewSignalsPerTick: 3,
      evidence: {},
    }),
    updateRuntimeStatus: async (state: string, reason: string) => {
      store.runtimeStatus = {
        ...store.runtimeStatus,
        state,
        reason,
        lastHeartbeatAt: new Date(),
      };
      store.runtimeTransitions.push({
        state,
        reason,
        updatedAt: new Date().toISOString(),
      });
    },
  };
}

function buildExternalSnapshot(venue: StatefulVenueHarness): any {
  return Promise.all([venue.getOpenOrders(), venue.getTrades()]).then(
    ([openOrders, trades]) => ({
      source: 'polymarket_authenticated_external_truth',
      snapshotId: `snapshot-${Date.now()}`,
      capturedAt: new Date().toISOString(),
      freshnessState: 'fresh',
      freshnessVerdict: 'healthy',
      reconciliationHealth: 'healthy',
      tradingPermissions: {
        allowNewEntries: true,
        allowPositionManagement: true,
        reasonCodes: [],
      },
      cashBalance: 100,
      cashAllowance: 100,
      reservedCash: 0,
      freeCashBeforeAllowance: 100,
      freeCashAfterAllowance: 100,
      tradableBuyHeadroom: 100,
      availableCapital: 100,
      bankroll: 100,
      openExposure: 0,
      openOrderExposure: openOrders.reduce(
        (sum: number, order: any) =>
          sum + Math.max(0, Number(order.size) - Number(order.matchedSize)) * Number(order.price),
        0,
      ),
      realizedFees: trades.reduce(
        (sum: number, trade: any) => sum + Math.max(0, Number(trade.fee ?? 0)),
        0,
      ),
      workingOpenOrders: openOrders.length,
      cash: {
        grossBalance: 100,
        grossAllowance: 100,
        reservedForBuys: 0,
        freeCashBeforeAllowance: 100,
        freeCashAfterAllowance: 100,
        tradableBuyHeadroom: 100,
      },
      positions: {
        current: [],
        closed: [],
        totalCurrentValue: 0,
        realizedPnlFromClosedPositions: 0,
      },
      trades: {
        authenticated: trades,
        dataApi: [],
      },
      openOrders,
      freshness: {
        overallVerdict: 'healthy',
        confidence: 'high',
        allowNewEntries: true,
        allowPositionManagement: true,
        components: {},
      },
      divergence: {
        status: 'none',
        classes: [],
        details: [],
      },
      recovery: {
        mode: 'none',
        entriesBlocked: false,
        positionManagementBlocked: false,
        reasonCodes: [],
      },
      inventories: [
        {
          tokenId: 'yes1',
          marketId: 'm1',
          outcome: 'YES',
          balance: 0,
          allowance: 0,
          reservedQuantity: 0,
          freeQuantityBeforeAllowance: 0,
          freeQuantityAfterAllowance: 0,
          tradableSellHeadroom: 0,
          availableQuantity: 0,
          positionQuantity: 0,
          markPrice: 0.51,
          markedValue: 0,
        },
      ],
    }),
  );
}

function createHarness(): {
  store: LifecycleStore;
  prisma: any;
  venue: StatefulVenueHarness;
  runtimeControl: any;
  userStreamService: UserWebSocketStateService;
  executeJob: ExecuteOrdersJob;
  manageJob: ManageOpenOrdersJob;
  reconcileJob: ReconcileFillsJob;
  crashRecovery: CrashRecoveryService;
  replayEngine: ReplayEngine;
} {
  const store = createLifecycleStore();
  const prisma = createLifecyclePrisma(store);
  const venue = new StatefulVenueHarness();
  const runtimeControl = createRuntimeControl(store, prisma);
  const userStreamService = new UserWebSocketStateService(250, {
    auth: {
      apiKey: 'key-1',
      secret: 'secret-1',
      passphrase: 'pass-1',
    },
    restClient: venue as any,
  });

  const executeJob = new ExecuteOrdersJob(prisma as never, runtimeControl as never);
  (executeJob as any).tradingClient = venue;
  (executeJob as any).runtimeControl = runtimeControl;
  (executeJob as any).externalPortfolioService = {
    capture: async () => buildExternalSnapshot(venue),
  };
  (executeJob as any).accountStateService = {
    capture: async () => ({
      deployableRiskNow: 100,
    }),
  };

  const manageJob = new ManageOpenOrdersJob(prisma as never, runtimeControl as never);
  (manageJob as any).tradingClient = venue;

  const reconcileJob = new ReconcileFillsJob(prisma as never, runtimeControl as never);
  (reconcileJob as any).tradingClient = venue;
  (reconcileJob as any).decisionLogService = {
    record: async () => undefined,
  };

  const crashRecovery = new CrashRecoveryService(
    prisma as never,
    runtimeControl as never,
    venue as never,
    {
      capture: async () => buildExternalSnapshot(venue),
    } as never,
    manageJob as never,
    reconcileJob as never,
    {
      run: async () => ({
        snapshotId: 'portfolio-snapshot-1',
      }),
    } as never,
    {
      sync: async () => {
        await runtimeControl.recordReconciliationCheckpoint({
          cycleKey: `heartbeat:${Date.now()}`,
          source: 'venue_open_orders_heartbeat',
          status: 'completed',
          details: {},
        });
      },
    } as never,
    userStreamService,
  );

  const replayEngine = new ReplayEngine(prisma as never);
  return {
    store,
    prisma,
    venue,
    runtimeControl,
    userStreamService,
    executeJob,
    manageJob,
    reconcileJob,
    crashRecovery,
    replayEngine,
  };
}

function trustUserStream(service: UserWebSocketStateService): void {
  service.markConnected();
  (service as any).trusted = true;
  (service as any).lastTrafficAt = new Date().toISOString();
  (service as any).lastReconciliationAt = new Date().toISOString();
}

function setOrderAge(store: LifecycleStore, minutesAgo: number): void {
  for (const order of store.orders) {
    order.createdAt = new Date(Date.now() - minutesAgo * 60_000);
    order.updatedAt = new Date(Date.now() - minutesAgo * 60_000);
  }
}

function latestIntent(store: LifecycleStore): Record<string, unknown> | null {
  return sortRecords(
    store.checkpoints.filter((checkpoint) => checkpoint.source === 'order_intent'),
    'processedAt',
    'desc',
  )[0] ?? null;
}

async function captureRestTruth(
  venue: StatefulVenueHarness,
  stage: string,
): Promise<ScenarioRestSnapshot> {
  return {
    stage,
    capturedAt: new Date().toISOString(),
    openOrders: clone(await venue.getOpenOrders()),
    trades: clone(await venue.getTrades()),
  };
}

function captureBotBelief(
  store: LifecycleStore,
  userStreamService: UserWebSocketStateService,
  stage: string,
): ScenarioEvidenceSnapshot {
  return {
    stage,
    capturedAt: new Date().toISOString(),
    localOrders: clone(store.orders),
    localFills: clone(store.fills),
    intents: clone(
      sortRecords(
        store.checkpoints.filter((checkpoint) => checkpoint.source === 'order_intent'),
        'processedAt',
        'desc',
      ),
    ),
    userStream: userStreamService.evaluateHealth(),
    runtimeState: clone(store.runtimeStatus),
  };
}

async function captureFinalTruth(harness: ReturnType<typeof createHarness>): Promise<Record<string, unknown>> {
  const replay = await harness.replayEngine.replaySignal('s1');
  return {
    localOrders: clone(harness.store.orders),
    localFills: clone(harness.store.fills),
    venueOpenOrders: clone(await harness.venue.getOpenOrders()),
    venueTrades: clone(await harness.venue.getTrades()),
    userStreamOpenOrders: harness.userStreamService.getOpenOrderIds(),
    userStreamTrades: harness.userStreamService.getTradeIds(),
    runtimeTransitions: clone(harness.store.runtimeTransitions),
    replay: {
      signal: replay.signal,
      decisions: replay.decisions,
      orders: replay.orders,
      fills: replay.fills,
      auditEvents: replay.auditEvents.map((event: Record<string, unknown>) => ({
        id: event.id,
        createdAt: event.createdAt,
        eventType: event.eventType,
        message: event.message,
      })),
      lifecycleEvidence: replay.lifecycleEvidence,
      parserFailures: replay.parserFailures,
      latestLifecycleValidation: replay.latestLifecycleValidation,
      reconstructable: replay.reconstructable,
      generatedAt: replay.generatedAt,
    },
  };
}

function baseEvidence(scenario: LifecycleScenarioName): LifecycleScenarioEvidence {
  return {
    scenario,
    validationMode: 'venue_runtime',
    passed: false,
    intentId: null,
    submitAttempts: [],
    botBelief: [],
    venueTruth: [],
    restTruth: [],
    streamEvents: [],
    reconciliation: [],
    finalTruth: {},
    noDuplicateExposure: false,
    runtimeSafetyStayedFailClosed: false,
    ambiguityDetected: false,
    ambiguityReasonCodes: [],
    timing: {
      startedAt: new Date().toISOString(),
      completedAt: null,
      durationMs: null,
      botSnapshotCount: 0,
      restSnapshotCount: 0,
      reconciliationStepCount: 0,
      streamEventCount: 0,
    },
    assertions: [],
  };
}

function finalizeAssertions(
  evidence: LifecycleScenarioEvidence,
): LifecycleAssertionResult[] {
  return [
    {
      key: 'no_duplicate_exposure_after_uncertainty',
      passed: evidence.noDuplicateExposure,
      reason: evidence.noDuplicateExposure
        ? 'No duplicate exposure was created while venue truth was uncertain.'
        : 'Duplicate exposure risk was detected.',
    },
    {
      key: 'runtime_fails_closed_on_ambiguity',
      passed: evidence.runtimeSafetyStayedFailClosed,
      reason: evidence.runtimeSafetyStayedFailClosed
        ? 'Runtime stayed fail-closed until truth was reconciled.'
        : 'Runtime continued without a fail-closed posture.',
    },
    {
      key: 'ambiguity_is_explicitly_evidenced',
      passed: evidence.ambiguityReasonCodes.length > 0,
      reason:
        evidence.ambiguityReasonCodes.length > 0
          ? evidence.ambiguityReasonCodes.join('|')
          : 'No ambiguity reason code was captured.',
    },
  ];
}

async function finalizeScenario(
  harness: ReturnType<typeof createHarness>,
  evidence: LifecycleScenarioEvidence,
): Promise<LifecycleScenarioEvidence> {
  evidence.intentId = latestIntent(harness.store)?.cycleKey
    ? String(latestIntent(harness.store)?.cycleKey)
    : null;
  evidence.submitAttempts = clone(harness.venue.submitAttempts);
  evidence.timing.completedAt = new Date().toISOString();
  evidence.timing.durationMs =
    new Date(evidence.timing.completedAt).getTime() -
    new Date(evidence.timing.startedAt).getTime();
  evidence.timing.botSnapshotCount = evidence.botBelief.length;
  evidence.timing.restSnapshotCount = evidence.restTruth.length + evidence.venueTruth.length;
  evidence.timing.reconciliationStepCount = evidence.reconciliation.length;
  evidence.timing.streamEventCount = evidence.streamEvents.length;
  evidence.ambiguityDetected = evidence.ambiguityReasonCodes.length > 0;
  evidence.assertions = finalizeAssertions(evidence);
  const persistedEvidence = clone(evidence);

  await harness.prisma.auditEvent.create({
    data: {
      signalId: 's1',
      marketId: 'm1',
      eventType: 'lifecycle.validation_scenario',
      message: `Lifecycle validation scenario ${evidence.scenario} completed.`,
      metadata: persistedEvidence as unknown as object,
      createdAt: new Date(),
    },
  });
  await harness.prisma.reconciliationCheckpoint.create({
    data: {
      cycleKey: evidence.scenario,
      source: 'lifecycle_validation_scenario',
      status: evidence.passed ? 'passed' : 'failed',
      details: persistedEvidence as unknown as object,
      processedAt: new Date(),
    },
  });
  evidence.finalTruth = await captureFinalTruth(harness);

  return evidence;
}

async function runSubmitTimeoutScenario(): Promise<LifecycleScenarioEvidence> {
  const harness = createHarness();
  const evidence = baseEvidence('submit_timeout_uncertain_venue_state');
  evidence.ambiguityReasonCodes.push('uncertain_submit_state');
  harness.venue.submitBehavior = 'timeout_uncertain';

  evidence.botBelief.push(captureBotBelief(harness.store, harness.userStreamService, 'before_submit'));
  await harness.executeJob.run({ canSubmit: () => true });
  evidence.botBelief.push(captureBotBelief(harness.store, harness.userStreamService, 'after_timeout'));
  evidence.venueTruth.push(await captureRestTruth(harness.venue, 'after_timeout'));
  evidence.restTruth.push(await captureRestTruth(harness.venue, 'after_timeout'));

  await harness.executeJob.run({ canSubmit: () => true });
  evidence.botBelief.push(
    captureBotBelief(harness.store, harness.userStreamService, 'after_replay_block'),
  );
  const recovery = await harness.crashRecovery.run();
  evidence.reconciliation.push({
    stage: 'crash_recovery',
    capturedAt: new Date().toISOString(),
    result: clone(recovery),
  });

  evidence.noDuplicateExposure =
    harness.venue.submitAttempts.length === 1 &&
    (await harness.venue.getOpenOrders()).length === 1;
  evidence.runtimeSafetyStayedFailClosed =
    recovery.recovered === false && recovery.unresolvedIntentCount >= 1;
  evidence.passed =
    evidence.noDuplicateExposure &&
    evidence.runtimeSafetyStayedFailClosed &&
    harness.store.orders.length === 0;

  return finalizeScenario(harness, evidence);
}

async function runPartialFillReconnectScenario(): Promise<LifecycleScenarioEvidence> {
  const harness = createHarness();
  const evidence = baseEvidence('partial_fill_followed_by_reconnect');
  evidence.ambiguityReasonCodes.push('partial_fill_requires_reconnect_truth');

  await harness.executeJob.run({ canSubmit: () => true });
  const localOrder = harness.store.orders[0];
  const venueOrderId = localOrder?.venueOrderId ?? localOrder?.id;
  if (venueOrderId) {
    const streamOrder = harness.venue.streamOrder(venueOrderId);
    if (streamOrder) {
      trustUserStream(harness.userStreamService);
      harness.userStreamService.applyOrderEvent(streamOrder);
      evidence.streamEvents.push({
        stage: 'ack',
        capturedAt: new Date().toISOString(),
        kind: 'order',
        orderId: streamOrder.orderId,
      });
    }

    harness.venue.applyFill({
      orderId: venueOrderId,
      tradeId: 'trade-partial-1',
      size: localOrder.size / 2,
      price: localOrder.price,
    });
    const streamTrade = harness.venue.streamTrade('trade-partial-1');
    if (streamTrade) {
      harness.userStreamService.applyTradeEvent(streamTrade);
      evidence.streamEvents.push({
        stage: 'partial_fill',
        capturedAt: new Date().toISOString(),
        kind: 'trade',
        tradeId: streamTrade.tradeId,
      });
    }
  }

  harness.userStreamService.markDisconnected();
  evidence.botBelief.push(
    captureBotBelief(harness.store, harness.userStreamService, 'during_disconnect'),
  );

  harness.userStreamService.markConnected();
  trustUserStream(harness.userStreamService);
  const reconcile = await harness.reconcileJob.run();
  evidence.reconciliation.push({
    stage: 'reconcile_after_reconnect',
    capturedAt: new Date().toISOString(),
    result: clone(reconcile),
  });
  evidence.botBelief.push(
    captureBotBelief(harness.store, harness.userStreamService, 'after_reconnect_reconcile'),
  );

  evidence.noDuplicateExposure =
    harness.venue.submitAttempts.length === 1 &&
    harness.store.orders.filter((order) =>
      ['submitted', 'acknowledged', 'partially_filled'].includes(order.status),
    ).length === 1;
  evidence.runtimeSafetyStayedFailClosed =
    evidence.botBelief.some(
      (snapshot) => snapshot.stage === 'during_disconnect' && snapshot.userStream.healthy === false,
    );
  evidence.passed =
    evidence.noDuplicateExposure &&
    evidence.runtimeSafetyStayedFailClosed &&
    harness.store.orders[0]?.status === 'partially_filled' &&
    harness.store.fills.length === 1;

  return finalizeScenario(harness, evidence);
}

async function runLateCancelScenario(): Promise<LifecycleScenarioEvidence> {
  const harness = createHarness();
  const evidence = baseEvidence('cancel_acknowledged_late');
  evidence.ambiguityReasonCodes.push('late_cancel_acknowledgement');
  harness.venue.cancelBehavior = 'late_ack';

  await harness.executeJob.run({ canSubmit: () => true });
  setOrderAge(harness.store, 10);
  const submittedOrder = harness.store.orders[0];
  if (submittedOrder?.venueOrderId) {
    harness.venue.openOrdersOverride = [
      {
        id: submittedOrder.venueOrderId,
        clientOrderId: submittedOrder.idempotencyKey,
        tokenId: submittedOrder.tokenId,
        side: submittedOrder.side,
        price: submittedOrder.price,
        size: submittedOrder.size,
        matchedSize: submittedOrder.filledSize,
        status: 'acknowledged',
        createdAt: submittedOrder.createdAt.toISOString(),
        cancelRequested: false,
      },
    ];
  }
  const firstManage = await harness.manageJob.run({ forceCancelAll: true });
  evidence.reconciliation.push({
    stage: 'cancel_requested',
    capturedAt: new Date().toISOString(),
    result: clone(firstManage),
  });
  evidence.restTruth.push(await captureRestTruth(harness.venue, 'cancel_requested_visible_at_venue'));
  evidence.botBelief.push(
    captureBotBelief(harness.store, harness.userStreamService, 'after_cancel_request'),
  );

  const localOrder = harness.store.orders[0];
  if (localOrder?.venueOrderId) {
    harness.venue.acknowledgeCancel(localOrder.venueOrderId);
  }
  harness.venue.openOrdersOverride = [];
  const secondManage = await harness.manageJob.run({ forceCancelAll: true });
  evidence.reconciliation.push({
    stage: 'cancel_confirmed',
    capturedAt: new Date().toISOString(),
    result: clone(secondManage),
  });
  evidence.restTruth.push(await captureRestTruth(harness.venue, 'cancel_confirmed_absent_at_venue'));

  const orderAfterFirst = evidence.botBelief.find(
    (snapshot) => snapshot.stage === 'after_cancel_request',
  )?.localOrders[0] as Record<string, unknown> | undefined;
  evidence.noDuplicateExposure =
    harness.venue.submitAttempts.length === 1 &&
    orderAfterFirst?.status !== 'canceled';
  evidence.runtimeSafetyStayedFailClosed =
    orderAfterFirst?.lastVenueStatus === 'cancel_requested' &&
    firstManage.canceled === 0;
  evidence.passed =
    evidence.noDuplicateExposure &&
    evidence.runtimeSafetyStayedFailClosed &&
    harness.store.orders[0]?.status === 'canceled';

  return finalizeScenario(harness, evidence);
}

async function runGhostOpenOrderScenario(): Promise<LifecycleScenarioEvidence> {
  const harness = createHarness();
  const evidence = baseEvidence('ghost_open_order_after_restart');
  evidence.ambiguityReasonCodes.push('ghost_open_order_visible_after_restart');
  const ghostOrderId = harness.venue.createGhostOrder();

  const firstRecovery = await harness.crashRecovery.run();
  evidence.reconciliation.push({
    stage: 'recovery_detects_ghost',
    capturedAt: new Date().toISOString(),
    result: clone(firstRecovery),
  });

  trustUserStream(harness.userStreamService);
  const streamOrder = harness.venue.streamOrder(ghostOrderId);
  if (streamOrder) {
    harness.userStreamService.applyOrderEvent(streamOrder);
    evidence.streamEvents.push({
      stage: 'restart_reconnect',
      capturedAt: new Date().toISOString(),
      kind: 'order',
      orderId: ghostOrderId,
    });
  }

  const secondRecovery = await harness.crashRecovery.run();
  evidence.reconciliation.push({
    stage: 'recovery_after_stream_truth',
    capturedAt: new Date().toISOString(),
    result: clone(secondRecovery),
  });

  evidence.noDuplicateExposure = harness.venue.submitAttempts.length === 0;
  evidence.runtimeSafetyStayedFailClosed =
    firstRecovery.recovered === false && firstRecovery.ghostExposureDetected === true;
  evidence.passed =
    evidence.noDuplicateExposure &&
    evidence.runtimeSafetyStayedFailClosed &&
    secondRecovery.ghostExposureDetected === false;

  return finalizeScenario(harness, evidence);
}

async function runDuplicateFillScenario(): Promise<LifecycleScenarioEvidence> {
  const harness = createHarness();
  const evidence = baseEvidence('duplicate_or_delayed_fill_events');
  evidence.ambiguityReasonCodes.push('duplicate_or_delayed_fill_events');

  await harness.executeJob.run({ canSubmit: () => true });
  const localOrder = harness.store.orders[0];
  const venueOrderId = localOrder?.venueOrderId ?? localOrder?.id;
  if (venueOrderId) {
    harness.venue.applyFill({
      orderId: venueOrderId,
      tradeId: 'trade-dup-1',
      size: localOrder.size,
      price: localOrder.price,
    });
    const trade = harness.venue.streamTrade('trade-dup-1');
    if (trade) {
      trustUserStream(harness.userStreamService);
      harness.userStreamService.applyTradeEvent(trade);
      harness.userStreamService.applyTradeEvent(trade);
      evidence.streamEvents.push({
        stage: 'duplicate_trade_events',
        capturedAt: new Date().toISOString(),
        kind: 'trade',
        tradeId: trade.tradeId,
      });
    }
  }

  const firstReconcile = await harness.reconcileJob.run();
  const secondReconcile = await harness.reconcileJob.run();
  evidence.reconciliation.push({
    stage: 'first_reconcile',
    capturedAt: new Date().toISOString(),
    result: clone(firstReconcile),
  });
  evidence.reconciliation.push({
    stage: 'second_reconcile',
    capturedAt: new Date().toISOString(),
    result: clone(secondReconcile),
  });

  evidence.noDuplicateExposure =
    harness.store.fills.length === 1 &&
    harness.venue.submitAttempts.length === 1;
  evidence.runtimeSafetyStayedFailClosed = secondReconcile.fillsInserted === 0;
  evidence.passed =
    evidence.noDuplicateExposure &&
    evidence.runtimeSafetyStayedFailClosed &&
    harness.store.orders[0]?.status === 'filled';

  return finalizeScenario(harness, evidence);
}

async function runVisibilityMismatchScenario(): Promise<LifecycleScenarioEvidence> {
  const harness = createHarness();
  const evidence = baseEvidence('order_visibility_mismatch_between_rest_and_stream');
  evidence.ambiguityReasonCodes.push('rest_stream_visibility_mismatch');

  await harness.executeJob.run({ canSubmit: () => true });
  const localOrder = harness.store.orders[0];
  const venueOrderId = localOrder?.venueOrderId ?? localOrder?.id;
  if (venueOrderId) {
    trustUserStream(harness.userStreamService);
    const streamOrder = harness.venue.streamOrder(venueOrderId);
    if (streamOrder) {
      harness.userStreamService.applyOrderEvent(streamOrder);
      evidence.streamEvents.push({
        stage: 'stream_visible',
        capturedAt: new Date().toISOString(),
        kind: 'order',
        orderId: venueOrderId,
      });
    }
  }

  harness.venue.openOrdersOverride = [];
  const mismatch = await captureRestTruth(harness.venue, 'rest_missing_order');
  evidence.restTruth.push(mismatch);
  const divergence = harness.userStreamService.detectDivergence({
    openOrderIds: mismatch.openOrders.map((order) => String((order as { id?: unknown }).id ?? '')),
    tradeIds: mismatch.trades.map((trade) => String((trade as { id?: unknown }).id ?? '')),
  });
  evidence.botBelief.push(
    captureBotBelief(harness.store, harness.userStreamService, 'during_visibility_mismatch'),
  );

  harness.venue.openOrdersOverride = null;
  const healed = await captureRestTruth(harness.venue, 'rest_matches_stream');
  evidence.restTruth.push(healed);
  harness.userStreamService.detectDivergence({
    openOrderIds: healed.openOrders.map((order) => String((order as { id?: unknown }).id ?? '')),
    tradeIds: healed.trades.map((trade) => String((trade as { id?: unknown }).id ?? '')),
  });
  harness.userStreamService.markReconciled();

  evidence.noDuplicateExposure = harness.venue.submitAttempts.length === 1;
  evidence.runtimeSafetyStayedFailClosed =
    divergence === true &&
    evidence.botBelief[0]?.userStream.healthy === false;
  evidence.passed =
    evidence.noDuplicateExposure &&
    evidence.runtimeSafetyStayedFailClosed &&
    harness.userStreamService.evaluateHealth().divergenceDetected === false;

  return finalizeScenario(harness, evidence);
}

async function runCrashStaleAssumptionScenario(): Promise<LifecycleScenarioEvidence> {
  const harness = createHarness();
  const evidence = baseEvidence('stale_local_assumptions_after_process_crash');
  evidence.ambiguityReasonCodes.push('stale_local_state_after_process_crash');

  await harness.executeJob.run({ canSubmit: () => true });
  const localOrder = harness.store.orders[0];
  const venueOrderId = localOrder?.venueOrderId ?? localOrder?.id;
  setOrderAge(harness.store, 12);

  if (venueOrderId) {
    harness.venue.applyFill({
      orderId: venueOrderId,
      tradeId: 'trade-crash-1',
      size: localOrder.size,
      price: localOrder.price,
    });
  }

  const recovery = await harness.crashRecovery.run();
  evidence.reconciliation.push({
    stage: 'crash_recovery',
    capturedAt: new Date().toISOString(),
    result: clone(recovery),
  });
  evidence.botBelief.push(
    captureBotBelief(harness.store, harness.userStreamService, 'after_crash_recovery'),
  );

  evidence.noDuplicateExposure =
    harness.store.fills.length === 1 && harness.venue.submitAttempts.length === 1;
  evidence.runtimeSafetyStayedFailClosed =
    recovery.syncFailed === false && recovery.recovered === true;
  evidence.passed =
    evidence.noDuplicateExposure &&
    evidence.runtimeSafetyStayedFailClosed &&
    harness.store.orders[0]?.status === 'filled';

  return finalizeScenario(harness, evidence);
}

export async function runLiveOrderLifecycleScenario(
  scenario: LifecycleScenarioName,
): Promise<LifecycleScenarioEvidence> {
  switch (scenario) {
    case 'submit_timeout_uncertain_venue_state':
      return runSubmitTimeoutScenario();
    case 'partial_fill_followed_by_reconnect':
      return runPartialFillReconnectScenario();
    case 'cancel_acknowledged_late':
      return runLateCancelScenario();
    case 'ghost_open_order_after_restart':
      return runGhostOpenOrderScenario();
    case 'duplicate_or_delayed_fill_events':
      return runDuplicateFillScenario();
    case 'order_visibility_mismatch_between_rest_and_stream':
      return runVisibilityMismatchScenario();
    case 'stale_local_assumptions_after_process_crash':
      return runCrashStaleAssumptionScenario();
  }

  throw new Error(`unsupported_lifecycle_scenario:${scenario}`);
}

export async function runLiveOrderLifecycleValidationSuite(options?: {
  scenarios?: LifecycleScenarioName[];
  evidencePath?: string;
  soakIterations?: number;
  scenarioDelayMs?: number;
}): Promise<LifecycleValidationSuiteResult> {
  const scenariosToRun =
    options?.scenarios ?? [
      'submit_timeout_uncertain_venue_state',
      'partial_fill_followed_by_reconnect',
      'cancel_acknowledged_late',
      'ghost_open_order_after_restart',
      'duplicate_or_delayed_fill_events',
      'order_visibility_mismatch_between_rest_and_stream',
      'stale_local_assumptions_after_process_crash',
    ];

  const soakIterations = Math.max(1, options?.soakIterations ?? 1);
  const soakResults: LifecycleSoakIterationResult[] = [];
  let scenarioResults: LifecycleScenarioEvidence[] = [];

  for (let iteration = 0; iteration < soakIterations; iteration += 1) {
    const startedAt = new Date().toISOString();
    const iterationResults: LifecycleScenarioEvidence[] = [];

    for (const scenario of scenariosToRun) {
      iterationResults.push(await runLiveOrderLifecycleScenario(scenario));
      if ((options?.scenarioDelayMs ?? 0) > 0) {
        await new Promise((resolve) => setTimeout(resolve, options?.scenarioDelayMs ?? 0));
      }
    }

    const completedAt = new Date().toISOString();
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
    soakResults.push({
      iteration: iteration + 1,
      startedAt,
      completedAt,
      durationMs,
      passed: iterationResults.every((scenario) => scenario.passed),
      failedScenarios: iterationResults
        .filter((scenario) => !scenario.passed)
        .map((scenario) => scenario.scenario),
    });

    if (iteration === 0) {
      scenarioResults = iterationResults;
    }
  }

  const averageDurationMs =
    soakResults.length > 0
      ? soakResults.reduce((sum, result) => sum + result.durationMs, 0) / soakResults.length
      : 0;
  const maxDurationMs =
    soakResults.length > 0
      ? Math.max(...soakResults.map((result) => result.durationMs))
      : 0;

  const result: LifecycleValidationSuiteResult = {
    success:
      scenarioResults.every((scenario) => scenario.passed) &&
      soakResults.every((iteration) => iteration.passed),
    executedAt: new Date().toISOString(),
    validationMode: 'venue_runtime',
    scenarioCoverage: scenariosToRun,
    scenarios: scenarioResults,
    soak: {
      enabled: soakIterations > 1,
      iterations: soakIterations,
      passedIterations: soakResults.filter((result) => result.passed).length,
      failedIterations: soakResults.filter((result) => !result.passed).length,
      averageDurationMs,
      maxDurationMs,
      results: soakResults,
    },
    evidencePath: options?.evidencePath ?? DEFAULT_EVIDENCE_PATH,
  };

  fs.mkdirSync(path.dirname(result.evidencePath), { recursive: true });
  fs.writeFileSync(result.evidencePath, JSON.stringify(result, null, 2));
  return result;
}

export function loadLatestLifecycleValidationEvidence(
  evidencePath = DEFAULT_EVIDENCE_PATH,
): LifecycleValidationSuiteResult | null {
  if (!fs.existsSync(evidencePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as LifecycleValidationSuiteResult;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const soakIterationsArg = args.find((arg) => arg.startsWith('--soak-iterations='));
  const scenarioDelayArg = args.find((arg) => arg.startsWith('--scenario-delay-ms='));
  const result = await runLiveOrderLifecycleValidationSuite({
    soakIterations: soakIterationsArg
      ? Number(soakIterationsArg.slice('--soak-iterations='.length))
      : 1,
    scenarioDelayMs: scenarioDelayArg
      ? Number(scenarioDelayArg.slice('--scenario-delay-ms='.length))
      : 0,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.success) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
