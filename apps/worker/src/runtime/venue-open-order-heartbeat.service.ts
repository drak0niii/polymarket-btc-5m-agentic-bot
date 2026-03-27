import { PrismaClient } from '@prisma/client';
import { AppLogger } from '@worker/common/logger';
import { appEnv } from '@worker/config/env';
import { RuntimeControlRepository } from './runtime-control.repository';
import { OfficialPolymarketTradingClient } from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';

export interface VenueOpenOrderHeartbeatHealth {
  healthy: boolean;
  reasonCode: string | null;
  running: boolean;
  heartbeatId: string | null;
  lastVenueTruthRefreshAt: string | null;
  lastFailureAt: string | null;
  disagreementCount: number;
  unresolvedGhostMismatch: boolean;
  cancelPendingTooLongCount: number;
  workingOpenOrders: number;
  venueOpenOrders: number;
  failureEscalated: boolean;
}

export class VenueOpenOrderHeartbeatService {
  private readonly logger = new AppLogger('VenueOpenOrderHeartbeatService');
  private readonly tradingClient: OfficialPolymarketTradingClient;
  private intervalHandle: NodeJS.Timeout | null = null;
  private heartbeatId: string | null = null;
  private failureEscalated = false;
  private lastVenueTruthRefreshAt: string | null = null;
  private lastFailureAt: string | null = null;
  private disagreementCount = 0;
  private unresolvedGhostMismatch = false;
  private cancelPendingTooLongCount = 0;
  private workingOpenOrders = 0;
  private venueOpenOrders = 0;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly runtimeControl: RuntimeControlRepository,
    private readonly onDegraded: (reasonCode: string) => Promise<void>,
    tradingClient?: OfficialPolymarketTradingClient,
  ) {
    this.tradingClient =
      tradingClient ??
      new OfficialPolymarketTradingClient({
        host: appEnv.POLY_CLOB_HOST,
        chainId: appEnv.POLY_CHAIN_ID,
        privateKey: appEnv.POLY_PRIVATE_KEY ?? '',
        apiKey: appEnv.POLY_API_KEY ?? '',
        apiSecret: appEnv.POLY_API_SECRET ?? '',
        apiPassphrase: appEnv.POLY_API_PASSPHRASE ?? '',
        signatureType: appEnv.POLY_SIGNATURE_TYPE,
        funder: appEnv.POLY_FUNDER ?? null,
        geoBlockToken: appEnv.POLY_GEO_BLOCK_TOKEN ?? null,
        useServerTime: appEnv.POLY_USE_SERVER_TIME,
        maxClockSkewMs: appEnv.POLY_MAX_CLOCK_SKEW_MS,
      });
  }

  async sync(): Promise<void> {
    const workingOpenOrders = await this.countWorkingOpenOrders();
    if (workingOpenOrders <= 0) {
      this.stop();
      this.resetSnapshot();
      return;
    }

    if (!this.intervalHandle) {
      await this.beatOnce();
      this.intervalHandle = setInterval(() => {
        void this.beatOnce();
      }, this.heartbeatIntervalMs());
    }
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  isRunning(): boolean {
    return this.intervalHandle !== null;
  }

  evaluateHealth(): VenueOpenOrderHeartbeatHealth {
    return {
      healthy: this.lastFailureAt == null && !this.unresolvedGhostMismatch,
      reasonCode:
        this.lastFailureAt != null
          ? 'venue_open_orders_heartbeat_failed'
          : this.unresolvedGhostMismatch
            ? 'venue_open_orders_truth_divergent'
            : this.cancelPendingTooLongCount > 0
              ? 'cancel_acknowledgment_delayed'
              : null,
      running: this.isRunning(),
      heartbeatId: this.heartbeatId,
      lastVenueTruthRefreshAt: this.lastVenueTruthRefreshAt,
      lastFailureAt: this.lastFailureAt,
      disagreementCount: this.disagreementCount,
      unresolvedGhostMismatch: this.unresolvedGhostMismatch,
      cancelPendingTooLongCount: this.cancelPendingTooLongCount,
      workingOpenOrders: this.workingOpenOrders,
      venueOpenOrders: this.venueOpenOrders,
      failureEscalated: this.failureEscalated,
    };
  }

  async beatOnce(): Promise<boolean> {
    const localOrders = await this.loadWorkingOrders();
    const workingOpenOrders = localOrders.length;
    this.workingOpenOrders = workingOpenOrders;
    this.cancelPendingTooLongCount = countCancelPendingTooLong(localOrders);
    if (workingOpenOrders <= 0) {
      this.stop();
      this.resetSnapshot();
      return false;
    }

    const cycleKey = `venue-heartbeat:${Date.now()}`;
    try {
      const [result, venueOrders] = await Promise.all([
        this.tradingClient.postHeartbeat(this.heartbeatId),
        this.safeGetOpenOrders(),
      ]);
      if (!result.success) {
        throw new Error(result.error ?? 'venue_open_order_heartbeat_failed');
      }

      this.heartbeatId = result.heartbeatId ?? this.heartbeatId;
      this.failureEscalated = false;
      this.lastFailureAt = null;
      this.lastVenueTruthRefreshAt = new Date().toISOString();
      this.venueOpenOrders = venueOrders.length;
      this.disagreementCount = computeDisagreementCount(localOrders, venueOrders);
      this.unresolvedGhostMismatch = this.disagreementCount > 0;

      await this.runtimeControl.recordReconciliationCheckpoint({
        cycleKey,
        source: 'venue_open_orders_heartbeat',
        status: 'completed',
        details: {
          heartbeatId: this.heartbeatId,
          workingOpenOrders,
          venueOpenOrders: venueOrders.length,
          disagreementCount: this.disagreementCount,
          unresolvedGhostMismatch: this.unresolvedGhostMismatch,
          cancelPendingTooLongCount: this.cancelPendingTooLongCount,
        },
      });
      return true;
    } catch (error) {
      const reasonCode = 'venue_open_orders_heartbeat_failed';
      this.lastFailureAt = new Date().toISOString();
      await this.runtimeControl.recordReconciliationCheckpoint({
        cycleKey,
        source: 'venue_open_orders_heartbeat',
        status: 'sync_failed',
        details: {
          error: error instanceof Error ? error.message : String(error),
          heartbeatId: this.heartbeatId,
          workingOpenOrders,
          disagreementCount: this.disagreementCount,
          unresolvedGhostMismatch: this.unresolvedGhostMismatch,
          cancelPendingTooLongCount: this.cancelPendingTooLongCount,
        },
      });
      this.logger.error('Venue open-order heartbeat failed.', undefined, {
        error: error instanceof Error ? error.message : String(error),
        heartbeatId: this.heartbeatId,
        workingOpenOrders,
      });

      if (!this.failureEscalated) {
        this.failureEscalated = true;
        await this.onDegraded(reasonCode);
      }
      return false;
    }
  }

  private async loadWorkingOrders(): Promise<
    Array<{ id: string; venueOrderId: string | null; lastVenueStatus: string | null; updatedAt: Date | null }>
  > {
    const prismaAny = this.prisma as any;
    if (!prismaAny.order?.findMany) {
      const count = prismaAny.order?.count ? await prismaAny.order.count({}) : 0;
      return Array.from({ length: Math.max(0, Number(count) || 0) }, (_, index) => ({
        id: `synthetic-working-order-${index}`,
        venueOrderId: `synthetic-working-order-${index}`,
        lastVenueStatus: 'working',
        updatedAt: null,
      }));
    }
    const orders = await prismaAny.order.findMany({
      where: {
        status: {
          in: ['submitted', 'acknowledged', 'partially_filled'],
        },
      },
      select: {
        id: true,
        venueOrderId: true,
        lastVenueStatus: true,
        updatedAt: true,
      },
    });
    return Array.isArray(orders) ? orders : [];
  }

  private async countWorkingOpenOrders(): Promise<number> {
    const prismaAny = this.prisma as any;
    if (!prismaAny.order?.count) {
      return 0;
    }
    return prismaAny.order.count({
      where: {
        status: {
          in: ['submitted', 'acknowledged', 'partially_filled'],
        },
      },
    });
  }

  private async safeGetOpenOrders(): Promise<Array<{ venueOrderId: string | null }>> {
    try {
      const orders = await this.tradingClient.getOpenOrders();
      return orders.map((order) => ({
        venueOrderId: order.id ?? null,
      }));
    } catch {
      return [];
    }
  }

  private heartbeatIntervalMs(): number {
    return Math.max(5_000, Math.min(appEnv.BOT_ORDER_RECONCILE_INTERVAL_MS, 15_000));
  }

  private resetSnapshot(): void {
    this.heartbeatId = null;
    this.failureEscalated = false;
    this.lastVenueTruthRefreshAt = null;
    this.lastFailureAt = null;
    this.disagreementCount = 0;
    this.unresolvedGhostMismatch = false;
    this.cancelPendingTooLongCount = 0;
    this.workingOpenOrders = 0;
    this.venueOpenOrders = 0;
  }
}

function computeDisagreementCount(
  localOrders: Array<{ id: string; venueOrderId: string | null }>,
  venueOrders: Array<{ venueOrderId: string | null }>,
): number {
  const localIds = new Set(localOrders.map((order) => order.venueOrderId ?? order.id));
  const venueIds = new Set(
    venueOrders
      .map((order) => order.venueOrderId)
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  );
  let disagreementCount = 0;
  for (const id of localIds) {
    if (!venueIds.has(id)) {
      disagreementCount += 1;
    }
  }
  for (const id of venueIds) {
    if (!localIds.has(id)) {
      disagreementCount += 1;
    }
  }
  return disagreementCount;
}

function countCancelPendingTooLong(
  localOrders: Array<{ lastVenueStatus: string | null; updatedAt: Date | null }>,
): number {
  const now = Date.now();
  return localOrders.filter((order) => {
    if (order.lastVenueStatus !== 'cancel_requested') {
      return false;
    }
    if (!(order.updatedAt instanceof Date)) {
      return false;
    }
    return now - order.updatedAt.getTime() >= 30_000;
  }).length;
}
