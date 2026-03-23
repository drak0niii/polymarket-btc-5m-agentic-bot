import { PrismaClient } from '@prisma/client';
import { AppLogger } from '@worker/common/logger';
import { BotStateStore, BotRuntimeState } from './bot-state';
import { StartStopManager } from './start-stop-manager';
import { LiveLoop } from './live-loop';
import { appEnv } from '@worker/config/env';
import { RuntimeControlRepository } from './runtime-control.repository';
import { StartupRunbook } from './startup-runbook';
import { ExternalPortfolioService } from '@worker/portfolio/external-portfolio.service';
import { OfficialPolymarketTradingClient } from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';
import { CrashRecoveryService } from './crash-recovery';
import { ManageOpenOrdersJob } from '@worker/jobs/manageOpenOrders.job';
import { ReconcileFillsJob } from '@worker/jobs/reconcileFills.job';
import { RefreshPortfolioJob } from '@worker/jobs/refreshPortfolio.job';
import { VenueOpenOrderHeartbeatService } from './venue-open-order-heartbeat.service';
import { StartupGateService } from './startup-gate.service';
import { runPolymarketAuthenticatedSmoke } from '@worker/smoke/polymarket-auth-smoke';
import { MarketWebSocketStateService } from '@polymarket-btc-5m-agentic-bot/market-data';
import { UserWebSocketStateService } from './user-websocket-state.service';
import { DailyReviewJob } from '@worker/jobs/dailyReview.job';

const LEARNING_CYCLE_POLL_INTERVAL_MS = 60 * 60 * 1000;

export class BotRuntime {
  private readonly logger = new AppLogger('BotRuntime');
  private readonly prisma = new PrismaClient({
    log: ['error', 'warn'],
  });
  private readonly runtimeControl = new RuntimeControlRepository(this.prisma, {
    maxOpenPositions: appEnv.MAX_OPEN_POSITIONS,
    maxDailyLossPct: appEnv.MAX_DAILY_LOSS_PCT,
    maxPerTradeRiskPct: appEnv.MAX_PER_TRADE_RISK_PCT,
    maxKellyFraction: appEnv.MAX_KELLY_FRACTION,
    maxConsecutiveLosses: appEnv.MAX_CONSECUTIVE_LOSSES,
    noTradeWindowSeconds: appEnv.NO_TRADE_WINDOW_SECONDS,
    evaluationIntervalMs: appEnv.BOT_EVALUATION_INTERVAL_MS,
    orderReconcileIntervalMs: appEnv.BOT_ORDER_RECONCILE_INTERVAL_MS,
    portfolioRefreshIntervalMs: appEnv.BOT_PORTFOLIO_REFRESH_INTERVAL_MS,
  });
  private readonly tradingClient = new OfficialPolymarketTradingClient({
    host: appEnv.POLY_CLOB_HOST,
    dataApiHost: appEnv.POLY_DATA_API_HOST,
    chainId: appEnv.POLY_CHAIN_ID,
    privateKey: appEnv.POLY_PRIVATE_KEY ?? '',
    apiKey: appEnv.POLY_API_KEY ?? '',
    apiSecret: appEnv.POLY_API_SECRET ?? '',
    apiPassphrase: appEnv.POLY_API_PASSPHRASE ?? '',
    signatureType: appEnv.POLY_SIGNATURE_TYPE,
    funder: appEnv.POLY_FUNDER ?? null,
    profileAddress: appEnv.POLY_PROFILE_ADDRESS ?? null,
    geoBlockToken: appEnv.POLY_GEO_BLOCK_TOKEN ?? null,
    useServerTime: appEnv.POLY_USE_SERVER_TIME,
    maxClockSkewMs: appEnv.POLY_MAX_CLOCK_SKEW_MS,
  });
  private readonly externalPortfolioService = new ExternalPortfolioService(
    this.prisma,
    this.tradingClient,
  );
  private readonly manageOpenOrdersJob = new ManageOpenOrdersJob(
    this.prisma,
    this.runtimeControl,
  );
  private readonly reconcileFillsJob = new ReconcileFillsJob(
    this.prisma,
    this.runtimeControl,
  );
  private readonly refreshPortfolioJob = new RefreshPortfolioJob(this.prisma);
  private readonly startupRunbook = new StartupRunbook(
    this.runtimeControl,
    this.tradingClient,
    this.externalPortfolioService,
    runPolymarketAuthenticatedSmoke,
  );
  private readonly venueHeartbeatService = new VenueOpenOrderHeartbeatService(
    this.prisma,
    this.runtimeControl,
    async () => undefined,
    this.tradingClient,
  );
  private readonly marketStreamService = new MarketWebSocketStateService(
    appEnv.BOT_MAX_MARKET_STREAM_STALENESS_MS,
    {
      url: appEnv.BOT_MARKET_WS_URL ?? undefined,
      restBaseUrl: appEnv.POLY_CLOB_HOST,
    },
  );
  private readonly userStreamService = new UserWebSocketStateService(
    appEnv.BOT_MAX_USER_STREAM_STALENESS_MS,
    {
      url: appEnv.BOT_USER_WS_URL ?? undefined,
      gammaBaseUrl: appEnv.POLY_GAMMA_HOST,
      auth:
        appEnv.POLY_API_KEY && appEnv.POLY_API_SECRET && appEnv.POLY_API_PASSPHRASE
          ? {
              apiKey: appEnv.POLY_API_KEY,
              secret: appEnv.POLY_API_SECRET,
              passphrase: appEnv.POLY_API_PASSPHRASE,
            }
          : null,
      restClient: this.tradingClient,
    },
  );
  private readonly crashRecoveryService = new CrashRecoveryService(
    this.prisma,
    this.runtimeControl,
    this.tradingClient,
    this.externalPortfolioService,
    this.manageOpenOrdersJob,
    this.reconcileFillsJob,
    this.refreshPortfolioJob,
    this.venueHeartbeatService,
    this.userStreamService,
  );
  private readonly startupGateService = new StartupGateService(
    this.runtimeControl,
    this.startupRunbook,
    this.crashRecoveryService,
    this.marketStreamService,
    this.userStreamService,
  );
  private readonly stateStore = new BotStateStore(
    appEnv.BOT_DEFAULT_STATUS,
    (transition) => {
      void this.runtimeControl.updateRuntimeStatus(
        transition.state,
        transition.reason,
      );
    },
  );
  private readonly startStopManager = new StartStopManager(
    this.stateStore,
    this.startupGateService,
  );
  private readonly dailyReviewJob = new DailyReviewJob(this.prisma);
  private readonly liveLoop = new LiveLoop(
    this.stateStore,
    this.prisma,
    this.runtimeControl,
    this.marketStreamService,
    this.userStreamService,
  );
  private heartbeatHandle: NodeJS.Timeout | null = null;
  private controlHandle: NodeJS.Timeout | null = null;
  private learningCycleHandle: NodeJS.Timeout | null = null;
  private processingCommand = false;

  async start(): Promise<void> {
    this.logger.log('Initializing bot runtime.', {
      botState: this.stateStore.getState(),
    });

    await this.prisma.$connect();
    await this.runtimeControl.ensureInitialized(appEnv.BOT_DEFAULT_STATUS);
    const persistedState = await this.runtimeControl.getRuntimeStatus();
    this.stateStore.setState(
      persistedState.state,
      persistedState.reason ?? 'runtime state synced',
    );

    if (persistedState.state === 'running') {
      try {
        await this.startStopManager.assertReadiness();
        this.startStopManager.enterRunning('resumed after startup gate');
        await this.liveLoop.start();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.stateStore.setState('halted_hard', `resume_failed:${message}`);
        await this.runtimeControl.updateRuntimeStatus(
          this.stateStore.getState(),
          this.stateStore.getReason() ?? `resume_failed:${message}`,
        );
        throw error;
      }
    }

    this.startHeartbeat();
    this.startControlPlanePolling();
    this.startLearningCyclePolling();
  }

  async stop(): Promise<void> {
    this.logger.warn('Stopping bot runtime.', {
      botState: this.stateStore.getState(),
    });

    if (this.heartbeatHandle) {
      clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }

    if (this.controlHandle) {
      clearInterval(this.controlHandle);
      this.controlHandle = null;
    }

    if (this.learningCycleHandle) {
      clearInterval(this.learningCycleHandle);
      this.learningCycleHandle = null;
    }

    await this.liveLoop.stop();
    this.stateStore.setState('stopped', 'runtime stopped');
    await this.runtimeControl.updateRuntimeStatus('stopped', 'runtime stopped');
    await this.prisma.$disconnect();
  }

  getState(): BotRuntimeState {
    return this.stateStore.getState();
  }

  async requestStart(reason = 'manual start requested'): Promise<void> {
    await this.startStopManager.start(reason);
    this.startStopManager.enterRunning(reason);
    try {
      await this.liveLoop.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.stateStore.setState('halted_hard', `start_failed:${message}`);
      await this.runtimeControl.updateRuntimeStatus(
        this.stateStore.getState(),
        this.stateStore.getReason() ?? `start_failed:${message}`,
      );
      throw error;
    }
    await this.runtimeControl.updateRuntimeStatus(
      this.stateStore.getState(),
      this.stateStore.getReason() ?? reason,
    );
  }

  async requestStop(
    reason = 'manual stop requested',
    cancelOpenOrders = false,
  ): Promise<void> {
    await this.startStopManager.stop(reason);
    await this.liveLoop.stopEntries();
    await this.runtimeControl.updateRuntimeStatus(
      this.stateStore.getState(),
      this.stateStore.getReason() ?? reason,
    );

    const stopDeadline = Date.now() + appEnv.BOT_STOP_DRAIN_TIMEOUT_MS;
    let sawSyncFailure = false;
    let lastDrainSnapshotId: string | null = null;
    let workingOrdersRemaining = false;
    do {
      const drain = await this.liveLoop.drainOnce(cancelOpenOrders);
      sawSyncFailure = sawSyncFailure || drain.syncFailed;
      lastDrainSnapshotId = drain.snapshotId;
      if (!cancelOpenOrders) {
        break;
      }
      workingOrdersRemaining = await this.hasWorkingOrders();
      if (!workingOrdersRemaining && !drain.syncFailed) {
        break;
      }
    } while (Date.now() < stopDeadline);

    if (cancelOpenOrders) {
      workingOrdersRemaining = await this.hasWorkingOrders();
      if (sawSyncFailure || workingOrdersRemaining) {
        const haltReason = sawSyncFailure
          ? 'stop_drain_failed:venue_sync_failed'
          : 'stop_drain_failed:working_orders_remaining';
        this.startStopManager.halt(haltReason);
        await this.prisma.auditEvent.create({
          data: {
            eventType: 'runtime.stop.escalated_to_halt',
            message:
              'Stop drain detected unresolved exposure. Runtime escalated to halted.',
            metadata: {
              reason: haltReason,
              cancelOpenOrders,
              sawSyncFailure,
              workingOrdersRemaining,
              snapshotId: lastDrainSnapshotId,
            } as object,
          },
        });
        await this.liveLoop.stop();
        await this.runtimeControl.updateRuntimeStatus(
          this.stateStore.getState(),
          this.stateStore.getReason() ?? haltReason,
        );
        return;
      }
    }

    await this.liveLoop.stop();
    this.startStopManager.completeStop('runtime stopped cleanly');
    await this.runtimeControl.updateRuntimeStatus(
      this.stateStore.getState(),
      this.stateStore.getReason() ?? reason,
    );
  }

  private startHeartbeat(): void {
    if (this.heartbeatHandle) {
      return;
    }

    this.heartbeatHandle = setInterval(() => {
      void this.emitHeartbeat();
    }, Math.max(appEnv.BOT_PORTFOLIO_REFRESH_INTERVAL_MS, 5000));
  }

  private startControlPlanePolling(): void {
    if (this.controlHandle) {
      return;
    }

    this.controlHandle = setInterval(() => {
      void this.processNextCommand();
    }, 1_000);
  }

  private startLearningCyclePolling(): void {
    if (this.learningCycleHandle) {
      return;
    }

    void this.runDailyLearningCycleIfDue();
    this.learningCycleHandle = setInterval(() => {
      void this.runDailyLearningCycleIfDue();
    }, LEARNING_CYCLE_POLL_INTERVAL_MS);
  }

  private async runDailyLearningCycleIfDue(): Promise<void> {
    try {
      const summary = await this.dailyReviewJob.runDueCycle(new Date());
      if (!summary) {
        return;
      }

      this.logger.log('Daily learning cycle summary recorded.', {
        cycleId: summary.cycleId,
        status: summary.status,
        realizedOutcomeCount: summary.realizedOutcomeCount,
        calibrationUpdates: summary.calibrationUpdates,
      });
    } catch (error) {
      this.logger.error('Daily learning cycle polling failed.', undefined, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async processNextCommand(): Promise<void> {
    if (this.processingCommand) {
      return;
    }

    this.processingCommand = true;
    try {
      const command = await this.runtimeControl.claimNextPendingCommand();
      if (!command) {
        return;
      }

      try {
        switch (command.command) {
          case 'start': {
            await this.requestStart(command.reason);
            break;
          }
          case 'stop': {
            await this.requestStop(command.reason, command.cancelOpenOrders);
            const stopAppliedInState = this.stateStore.getState();
            await this.prisma.auditEvent.create({
              data: {
                eventType:
                  stopAppliedInState === 'halted_hard'
                    ? 'runtime.stop.applied_with_halt'
                    : 'runtime.stop.applied',
                message:
                  stopAppliedInState === 'halted_hard'
                    ? 'Stop command escalated to halted due to unresolved exposure.'
                    : 'Stop command applied and runtime drained.',
                metadata: {
                  commandId: command.id,
                  cancelOpenOrders: command.cancelOpenOrders,
                  resultingState: stopAppliedInState,
                } as object,
              },
            });
            break;
          }
          case 'halt': {
            this.startStopManager.halt(command.reason);
            await this.liveLoop.stopEntries();
            let drainSyncFailed = false;
            let workingOrdersRemaining = false;
            let snapshotId: string | null = null;
            if (command.cancelOpenOrders) {
              const drain = await this.liveLoop.drainOnce(true);
              drainSyncFailed = drain.syncFailed;
              snapshotId = drain.snapshotId;
              workingOrdersRemaining = await this.hasWorkingOrders();
              if (drainSyncFailed || workingOrdersRemaining) {
                this.startStopManager.halt(
                  `${command.reason}:unresolved_exposure_after_halt`,
                );
              }
            }
            await this.liveLoop.stop();
            await this.prisma.auditEvent.create({
              data: {
                eventType: 'runtime.halt.applied',
                message: 'Halt command applied.',
                metadata: {
                  commandId: command.id,
                  reason: command.reason,
                  cancelOpenOrders: command.cancelOpenOrders,
                  drainSyncFailed,
                  workingOrdersRemaining,
                  snapshotId,
                } as object,
              },
            });
            await this.runtimeControl.updateRuntimeStatus(
              this.stateStore.getState(),
              this.stateStore.getReason() ?? command.reason,
            );
            break;
          }
          default: {
            throw new Error(`Unsupported command: ${command.command}`);
          }
        }

        await this.runtimeControl.completeCommand(command.id, 'applied');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.runtimeControl.completeCommand(command.id, 'failed', message);
        this.logger.error('Runtime command failed.', undefined, {
          commandId: command.id,
          command: command.command,
          error: message,
        });
      }
    } finally {
      this.processingCommand = false;
    }
  }

  private async hasWorkingOrders(): Promise<boolean> {
    const count = await this.prisma.order.count({
      where: {
        status: {
          in: ['submitted', 'acknowledged', 'partially_filled'],
        },
      },
    });
    return count > 0;
  }

  private async emitHeartbeat(): Promise<void> {
    const state = this.stateStore.getState();
    const reason = this.stateStore.getReason();

    try {
      const freshness = await this.runtimeControl.heartbeat(state, reason);
      if (!freshness.healthy) {
        this.logger.warn('Runtime heartbeat detected degraded operational freshness.', {
          botState: state,
          reasonCode: freshness.reasonCode,
          details: freshness.details,
        });
        return;
      }

      this.logger.debug('Runtime heartbeat.', {
        botState: state,
      });
    } catch (error) {
      this.logger.error('Runtime heartbeat failed.', undefined, {
        botState: state,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
