import { PrismaClient } from '@prisma/client';
import { AppLogger } from '@worker/common/logger';
import { RuntimeControlRepository } from './runtime-control.repository';
import { OfficialPolymarketTradingClient } from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';
import { ManageOpenOrdersJob } from '@worker/jobs/manageOpenOrders.job';
import { ReconcileFillsJob } from '@worker/jobs/reconcileFills.job';
import { RefreshPortfolioJob } from '@worker/jobs/refreshPortfolio.job';
import {
  ExternalPortfolioService,
  ExternalPortfolioSnapshot,
} from '@worker/portfolio/external-portfolio.service';
import { VenueOpenOrderHeartbeatService } from './venue-open-order-heartbeat.service';
import { FillStateService } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { OrderIntentRepository } from './order-intent.repository';
import { UserWebSocketStateService } from './user-websocket-state.service';

export interface CrashRecoveryResult {
  recovered: boolean;
  reasonCode: string | null;
  venueOpenOrders: number;
  fillsInserted: number;
  syncFailed: boolean;
  snapshotId: string | null;
  reservedCash: number;
  workingOpenOrders: number;
  ghostExposureDetected: boolean;
  unresolvedIntentCount: number;
}

export class CrashRecoveryService {
  private readonly logger = new AppLogger('CrashRecoveryService');
  private readonly fillStateService = new FillStateService();
  private readonly orderIntentRepository: OrderIntentRepository;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly runtimeControl: RuntimeControlRepository,
    private readonly tradingClient: OfficialPolymarketTradingClient,
    private readonly externalPortfolioService: ExternalPortfolioService,
    private readonly manageOpenOrdersJob: ManageOpenOrdersJob,
    private readonly reconcileFillsJob: ReconcileFillsJob,
    private readonly refreshPortfolioJob: RefreshPortfolioJob,
    private readonly venueHeartbeatService: VenueOpenOrderHeartbeatService,
    private readonly userStreamService?: UserWebSocketStateService,
  ) {
    this.orderIntentRepository = new OrderIntentRepository(prisma);
  }

  async run(): Promise<CrashRecoveryResult> {
    const cycleKey = `crash-recovery:${Date.now()}`;
    await this.runtimeControl.recordReconciliationCheckpoint({
      cycleKey,
      source: 'crash_recovery',
      status: 'processing',
    });

    try {
      const latestFillCheckpoint = await this.runtimeControl.getLatestCheckpoint(
        'fills_reconcile_cycle',
      );
      const unresolvedIntents = await this.orderIntentRepository.loadBlockingUnknownIntents();
      const venueOpenOrders = await this.tradingClient.getOpenOrders();
      await this.runtimeControl.recordReconciliationCheckpoint({
        cycleKey,
        source: 'crash_recovery_open_orders',
        status: 'completed',
        details: {
          venueOpenOrders: venueOpenOrders.length,
        },
      });

      const orderSync = await this.manageOpenOrdersJob.run();
      const fillSync = await this.reconcileFillsJob.run();
      const externalSnapshot = await this.externalPortfolioService.capture({
        cycleKey,
        source: 'crash_recovery_external_truth',
      });
      const portfolio = await this.refreshPortfolioJob.run();
      await this.venueHeartbeatService.sync();
      const localWorkingOrders = await (this.prisma.order as any)?.findMany?.({
        where: {
          status: {
            in: ['submitted', 'acknowledged', 'partially_filled'],
          },
        },
        select: {
          id: true,
        },
      });
      const ghostExposureDetected = this.fillStateService.detectGhostExposure({
        localOrderIds: Array.isArray(localWorkingOrders)
          ? localWorkingOrders
              .map((order) =>
                order && typeof order.id === 'string' ? order.id : null,
              )
              .filter((id): id is string => Boolean(id))
          : [],
        venueOrderIds: venueOpenOrders.map((order) => order.id),
        userStreamOrderIds: this.userStreamService?.getOpenOrderIds() ?? [],
        unresolvedIntentIds: unresolvedIntents.map((intent) => intent.intentId),
      });

      const recovered =
        !orderSync.syncFailed &&
        !fillSync.syncFailed &&
        !ghostExposureDetected &&
        unresolvedIntents.length === 0;
      const result: CrashRecoveryResult = {
        recovered,
        reasonCode: recovered
          ? null
          : ghostExposureDetected
            ? 'ghost_exposure_detected'
            : unresolvedIntents.length > 0
              ? 'order_intent_truth_pending'
              : 'crash_recovery_sync_failed',
        venueOpenOrders: venueOpenOrders.length,
        fillsInserted: fillSync.fillsInserted,
        syncFailed: orderSync.syncFailed || fillSync.syncFailed,
        snapshotId: portfolio.snapshotId,
        reservedCash: externalSnapshot.reservedCash,
        workingOpenOrders: externalSnapshot.workingOpenOrders,
        ghostExposureDetected,
        unresolvedIntentCount: unresolvedIntents.length,
      };

      await this.runtimeControl.recordReconciliationCheckpoint({
        cycleKey,
        source: 'crash_recovery',
        status: recovered ? 'completed' : 'failed',
        details: {
          latestFillCheckpointAt: latestFillCheckpoint?.processedAt?.toISOString() ?? null,
          venueOpenOrders: result.venueOpenOrders,
          reservedCash: result.reservedCash,
          workingOpenOrders: result.workingOpenOrders,
          fillsInserted: result.fillsInserted,
          snapshotId: result.snapshotId,
          syncFailed: result.syncFailed,
          ghostExposureDetected: result.ghostExposureDetected,
          unresolvedIntentCount: result.unresolvedIntentCount,
        },
      });

      this.logger.log('Crash recovery completed.', {
        recovered: result.recovered,
        venueOpenOrders: result.venueOpenOrders,
        reservedCash: result.reservedCash,
        workingOpenOrders: result.workingOpenOrders,
        fillsInserted: result.fillsInserted,
        ghostExposureDetected: result.ghostExposureDetected,
        unresolvedIntentCount: result.unresolvedIntentCount,
      });

      return result;
    } catch (error) {
      const reasonCode =
        error instanceof Error ? error.message : 'crash_recovery_failed';
      await this.runtimeControl.recordReconciliationCheckpoint({
        cycleKey,
        source: 'crash_recovery',
        status: 'failed',
        details: {
          error: reasonCode,
        },
      });
      this.logger.error('Crash recovery failed.', undefined, {
        error: reasonCode,
      });
      return {
        recovered: false,
        reasonCode,
        venueOpenOrders: 0,
        fillsInserted: 0,
        syncFailed: true,
        snapshotId: null,
        reservedCash: 0,
        workingOpenOrders: 0,
        ghostExposureDetected: false,
        unresolvedIntentCount: 0,
      };
    }
  }
}
