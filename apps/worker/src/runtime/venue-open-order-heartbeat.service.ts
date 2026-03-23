import { PrismaClient } from '@prisma/client';
import { AppLogger } from '@worker/common/logger';
import { appEnv } from '@worker/config/env';
import { RuntimeControlRepository } from './runtime-control.repository';
import { OfficialPolymarketTradingClient } from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';

export class VenueOpenOrderHeartbeatService {
  private readonly logger = new AppLogger('VenueOpenOrderHeartbeatService');
  private readonly tradingClient: OfficialPolymarketTradingClient;
  private intervalHandle: NodeJS.Timeout | null = null;
  private heartbeatId: string | null = null;
  private failureEscalated = false;

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
      this.heartbeatId = null;
      this.failureEscalated = false;
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

  async beatOnce(): Promise<boolean> {
    const workingOpenOrders = await this.countWorkingOpenOrders();
    if (workingOpenOrders <= 0) {
      this.stop();
      this.heartbeatId = null;
      this.failureEscalated = false;
      return false;
    }

    const cycleKey = `venue-heartbeat:${Date.now()}`;
    try {
      const result = await this.tradingClient.postHeartbeat(this.heartbeatId);
      if (!result.success) {
        throw new Error(result.error ?? 'venue_open_order_heartbeat_failed');
      }

      this.heartbeatId = result.heartbeatId ?? this.heartbeatId;
      this.failureEscalated = false;
      await this.runtimeControl.recordReconciliationCheckpoint({
        cycleKey,
        source: 'venue_open_orders_heartbeat',
        status: 'completed',
        details: {
          heartbeatId: this.heartbeatId,
          workingOpenOrders,
        },
      });
      return true;
    } catch (error) {
      const reasonCode = 'venue_open_orders_heartbeat_failed';
      await this.runtimeControl.recordReconciliationCheckpoint({
        cycleKey,
        source: 'venue_open_orders_heartbeat',
        status: 'sync_failed',
        details: {
          error: error instanceof Error ? error.message : String(error),
          heartbeatId: this.heartbeatId,
          workingOpenOrders,
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

  private async countWorkingOpenOrders(): Promise<number> {
    return this.prisma.order.count({
      where: {
        status: {
          in: ['submitted', 'acknowledged', 'partially_filled'],
        },
      },
    });
  }

  private heartbeatIntervalMs(): number {
    return Math.max(5_000, Math.min(appEnv.BOT_ORDER_RECONCILE_INTERVAL_MS, 15_000));
  }
}
