import { PrismaClient } from '@prisma/client';
import { AppLogger } from '@worker/common/logger';
import { BotStateStore } from './bot-state';
import { RuntimeControlRepository } from './runtime-control.repository';
import { DiscoverActiveBtcMarketsJob } from '@worker/jobs/discoverActiveBtcMarkets.job';
import { SyncBtcReferenceJob } from '@worker/jobs/syncBtcReference.job';
import { SyncOrderbooksJob } from '@worker/jobs/syncOrderbooks.job';
import { BuildSignalsJob } from '@worker/jobs/buildSignals.job';
import { EvaluateTradeOpportunitiesJob } from '@worker/jobs/evaluateTradeOpportunities.job';
import { ExecuteOrdersJob } from '@worker/jobs/executeOrders.job';
import { ManageOpenOrdersJob } from '@worker/jobs/manageOpenOrders.job';
import { ReconcileFillsJob } from '@worker/jobs/reconcileFills.job';
import { RefreshPortfolioJob } from '@worker/jobs/refreshPortfolio.job';
import { MarketAnalysisAgent } from '@worker/agents/market-analysis.agent';
import { RiskVerificationAgent } from '@worker/agents/risk-verification.agent';
import { ExecutionPortfolioAgent } from '@worker/agents/execution-portfolio.agent';
import { VenueOpenOrderHeartbeatService } from './venue-open-order-heartbeat.service';
import { ExecutionStateWatchdog } from './execution-state-watchdog';
import { permissionsForRuntimeState } from './runtime-state-machine';
import { MarketWebSocketStateService } from '@polymarket-btc-5m-agentic-bot/market-data';
import { UserWebSocketStateService } from './user-websocket-state.service';
import { InventoryLiquidationPolicy } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { LearningStateStore } from './learning-state-store';

export class LiveLoop {
  private readonly logger = new AppLogger('LiveLoop');
  private evaluationHandle: NodeJS.Timeout | null = null;
  private reconcileHandle: NodeJS.Timeout | null = null;
  private portfolioHandle: NodeJS.Timeout | null = null;
  private evaluating = false;
  private reconciling = false;
  private refreshingPortfolio = false;

  private readonly discoverMarketsJob: DiscoverActiveBtcMarketsJob;
  private readonly syncBtcReferenceJob: SyncBtcReferenceJob;
  private readonly syncOrderbooksJob: SyncOrderbooksJob;
  private readonly buildSignalsJob: BuildSignalsJob;
  private readonly evaluateTradesJob: EvaluateTradeOpportunitiesJob;
  private readonly executeOrdersJob: ExecuteOrdersJob;
  private readonly manageOpenOrdersJob: ManageOpenOrdersJob;
  private readonly reconcileFillsJob: ReconcileFillsJob;
  private readonly refreshPortfolioJob: RefreshPortfolioJob;
  private readonly marketAnalysisAgent: MarketAnalysisAgent;
  private readonly riskVerificationAgent: RiskVerificationAgent;
  private readonly executionPortfolioAgent: ExecutionPortfolioAgent;
  private readonly venueHeartbeatService: VenueOpenOrderHeartbeatService;
  private readonly executionStateWatchdog: ExecutionStateWatchdog;
  private readonly liquidationPolicy = new InventoryLiquidationPolicy();
  private venueHeartbeatProtectionActive = false;

  constructor(
    private readonly stateStore: BotStateStore,
    private readonly prisma: PrismaClient,
    private readonly runtimeControl: RuntimeControlRepository,
    private readonly marketStreamService: MarketWebSocketStateService,
    private readonly userStreamService: UserWebSocketStateService,
    private readonly learningStateStore?: LearningStateStore,
  ) {
    this.discoverMarketsJob = new DiscoverActiveBtcMarketsJob(this.prisma);
    this.syncBtcReferenceJob = new SyncBtcReferenceJob();
    this.syncOrderbooksJob = new SyncOrderbooksJob(this.prisma);
    this.buildSignalsJob = new BuildSignalsJob(
      this.prisma,
      undefined,
      this.learningStateStore,
    );
    this.evaluateTradesJob = new EvaluateTradeOpportunitiesJob(
      this.prisma,
      this.runtimeControl,
      undefined,
      this.learningStateStore,
    );
    this.executeOrdersJob = new ExecuteOrdersJob(
      this.prisma,
      this.runtimeControl,
      this.learningStateStore,
    );
    this.manageOpenOrdersJob = new ManageOpenOrdersJob(this.prisma, this.runtimeControl);
    this.reconcileFillsJob = new ReconcileFillsJob(this.prisma, this.runtimeControl);
    this.refreshPortfolioJob = new RefreshPortfolioJob(this.prisma);
    this.marketAnalysisAgent = new MarketAnalysisAgent(
      this.discoverMarketsJob,
      this.syncBtcReferenceJob,
      this.syncOrderbooksJob,
      this.buildSignalsJob,
    );
    this.riskVerificationAgent = new RiskVerificationAgent(
      this.evaluateTradesJob,
      this.prisma,
    );
    this.executionPortfolioAgent = new ExecutionPortfolioAgent(
      this.executeOrdersJob,
      this.manageOpenOrdersJob,
      this.reconcileFillsJob,
      this.refreshPortfolioJob,
    );
    this.venueHeartbeatService = new VenueOpenOrderHeartbeatService(
      this.prisma,
      this.runtimeControl,
      async (reasonCode) => this.handleVenueHeartbeatDegraded(reasonCode),
    );
    this.executionStateWatchdog = new ExecutionStateWatchdog(this.runtimeControl);
  }

  async start(): Promise<void> {
    const permissions = permissionsForRuntimeState(this.stateStore.getState());
    if (!permissions.allowNewEntries && this.stateStore.getState() !== 'degraded') {
      throw new Error(
        `Live loop can only start from an operational runtime state. Current state: ${this.stateStore.getState()}`,
      );
    }

    const config = await this.runtimeControl.getLiveConfig();
    await this.bootstrapStreamTruth();
    await this.ensureInitialPortfolioTruth();
    await this.venueHeartbeatService.sync();

    if (!this.evaluationHandle) {
      this.evaluationHandle = setInterval(() => {
        void this.tickEvaluation();
      }, config.evaluationIntervalMs);
    }

    if (!this.reconcileHandle) {
      this.reconcileHandle = setInterval(() => {
        void this.tickReconcile();
      }, config.orderReconcileIntervalMs);
    }

    if (!this.portfolioHandle) {
      this.portfolioHandle = setInterval(() => {
        void this.tickPortfolio();
      }, config.portfolioRefreshIntervalMs);
    }

    this.logger.log('Live loop started.', {
      botState: this.stateStore.getState(),
      evaluationIntervalMs: config.evaluationIntervalMs,
      orderReconcileIntervalMs: config.orderReconcileIntervalMs,
      portfolioRefreshIntervalMs: config.portfolioRefreshIntervalMs,
    });
  }

  async stop(): Promise<void> {
    if (this.evaluationHandle) {
      clearInterval(this.evaluationHandle);
      this.evaluationHandle = null;
    }

    if (this.reconcileHandle) {
      clearInterval(this.reconcileHandle);
      this.reconcileHandle = null;
    }

    if (this.portfolioHandle) {
      clearInterval(this.portfolioHandle);
      this.portfolioHandle = null;
    }

    this.venueHeartbeatService.stop();
    this.marketStreamService.stop();
    this.userStreamService.stop();

    this.logger.warn('Live loop stopped.', {
      botState: this.stateStore.getState(),
    });
  }

  async stopEntries(): Promise<void> {
    if (this.evaluationHandle) {
      clearInterval(this.evaluationHandle);
      this.evaluationHandle = null;
    }

    this.logger.warn('Evaluation loop stopped; reconciliation loop remains active.', {
      botState: this.stateStore.getState(),
    });
  }

  async drainOnce(forceCancelAll: boolean): Promise<{
    canceled: number;
    observed: number;
    syncFailed: boolean;
    fillsInserted: number;
    snapshotId: string | null;
  }> {
    const reconciliation = await this.executionPortfolioAgent.runReconciliation({
      forceCancelAll,
      runtimeState: this.stateStore.getState(),
      operatingMode: this.stateStore.getOperatingMode(),
    });
    const portfolio = await this.executionPortfolioAgent.runPortfolioRefresh({
      runtimeState: this.stateStore.getState(),
    });
    return {
      ...reconciliation,
      snapshotId: portfolio.snapshotId,
    };
  }

  private async ensureInitialPortfolioTruth(): Promise<void> {
    const reconciliation = await this.executionPortfolioAgent.runReconciliation({
      runtimeState: this.stateStore.getState(),
      operatingMode: this.stateStore.getOperatingMode(),
    });
    if (reconciliation.syncFailed) {
      throw new Error('initial_reconciliation_failed:venue_sync_failed');
    }

    const portfolio = await this.executionPortfolioAgent.runPortfolioRefresh({
      runtimeState: this.stateStore.getState(),
    });
    if (!portfolio.snapshotId) {
      throw new Error('initial_portfolio_refresh_failed');
    }

    this.logger.log('Initial reconciliation and portfolio refresh completed.', {
      botState: this.stateStore.getState(),
      fillsInserted: reconciliation.fillsInserted,
      canceled: reconciliation.canceled,
      snapshotId: portfolio.snapshotId,
    });
  }

  private async tickEvaluation(): Promise<void> {
    this.stateStore.refreshOperatingModeFromDisk();
    const permissions = permissionsForRuntimeState(this.stateStore.getState());
    if (
      this.evaluating ||
      !permissions.allowStrategyEvaluation ||
      !permissions.allowNewEntries
    ) {
      return;
    }

    this.evaluating = true;
    try {
      await this.enforceStreamHealth();
      await this.enforceLiquidationPolicy();
      const config = await this.runtimeControl.getLiveConfig();
      const marketResult = await this.marketAnalysisAgent.run(this.stateStore.getState());
      await this.refreshStreamSubscriptions();
      if (!marketResult.marketAuthorityPassed) {
        await this.prisma.auditEvent.create({
          data: {
            eventType: 'market.authority.veto',
            message: 'Market analysis authority vetoed this evaluation tick.',
            metadata: {
              reason: marketResult.marketAuthorityReason,
              checks: marketResult.checks,
            } as object,
          },
        });
        return;
      }

      if (!this.stateStore.canAcceptNewEntries()) {
        return;
      }

      const riskResult = await this.riskVerificationAgent.run(config);
      if (riskResult.killSwitchTriggered) {
        await this.prisma.auditEvent.create({
          data: {
            eventType: 'risk.kill_switch_triggered',
            message: 'Risk kill switch triggered; runtime halted.',
          metadata: {
              reason: riskResult.killSwitchReason,
              safetyState: riskResult.safetyState ?? null,
              safetyReasonCodes: riskResult.safetyReasonCodes ?? [],
            } as object,
          },
        });
        this.stateStore.setState(
          'halted_hard',
          riskResult.killSwitchReason ?? 'risk_kill_switch_triggered',
        );
        await this.stopEntries();
        return;
      }
      if (riskResult.allowEntries === false) {
        await this.prisma.auditEvent.create({
          data: {
            eventType: 'risk.final_veto_triggered',
            message: 'Risk verification agent vetoed new entries this tick.',
            metadata: {
              reason: riskResult.finalVetoReason ?? riskResult.killSwitchReason,
              vetoedSignals: riskResult.vetoedSignals ?? 0,
              safetyState: riskResult.safetyState ?? null,
              safetyReasonCodes: riskResult.safetyReasonCodes ?? [],
            } as object,
          },
        });
        return;
      }

      if (!this.stateStore.canAcceptNewEntries()) {
        return;
      }
      const executionResult = await this.executionPortfolioAgent.runExecution({
        canSubmit: () => this.stateStore.canAcceptNewEntries(),
        runtimeState: this.stateStore.getState(),
        operatingMode: this.stateStore.getOperatingMode(),
        authority: {
          marketAuthorityPassed: marketResult.marketAuthorityPassed,
          marketAuthorityReason: marketResult.marketAuthorityReason,
          riskAuthorityPassed: riskResult.allowEntries ?? true,
          riskAuthorityReason:
            riskResult.finalVetoReason ?? riskResult.killSwitchReason,
        },
      });
      if (executionResult.blockedByAuthority) {
        await this.prisma.auditEvent.create({
          data: {
            eventType: 'execution.authority.veto',
            message: 'Execution and portfolio agent blocked order submission.',
            metadata: {
              reason: executionResult.blockReason,
            } as object,
          },
        });
        return;
      }

      await this.venueHeartbeatService.sync();

      this.logger.debug('Evaluation tick executed.', {
        botState: this.stateStore.getState(),
        createdSignals: marketResult.createdSignals,
        approvedSignals: riskResult.approved,
        rejectedSignals: riskResult.rejected,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.auditEvent.create({
        data: {
          eventType: 'runtime.halt.evaluation_error',
          message: 'Evaluation tick failed and runtime halted.',
          metadata: {
            error: message,
          } as object,
        },
      });
      this.stateStore.setState('halted_hard', `evaluation_tick_failed:${message}`);
      this.logger.error('Evaluation tick failed, runtime halted.', undefined, {
        error: message,
      });
      await this.stop();
    } finally {
      this.evaluating = false;
    }
  }

  private async tickReconcile(): Promise<void> {
    this.stateStore.refreshOperatingModeFromDisk();
    const permissions = permissionsForRuntimeState(this.stateStore.getState());
    if (this.reconciling || !permissions.allowReconciliation) {
      return;
    }

    this.reconciling = true;
    try {
      await this.enforceStreamHealth();
      await this.enforceLiquidationPolicy();
      await this.executionPortfolioAgent.runReconciliation({
        runtimeState: this.stateStore.getState(),
        operatingMode: this.stateStore.getOperatingMode(),
      });
      await this.venueHeartbeatService.sync();
      this.logger.debug('Reconcile tick executed.', {
        botState: this.stateStore.getState(),
      });
    } catch (error) {
      this.logger.error('Reconcile tick failed.', undefined, {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.reconciling = false;
    }
  }

  private async tickPortfolio(): Promise<void> {
    this.stateStore.refreshOperatingModeFromDisk();
    const permissions = permissionsForRuntimeState(this.stateStore.getState());
    if (this.refreshingPortfolio || !permissions.allowPortfolioRefresh) {
      return;
    }

    this.refreshingPortfolio = true;
    try {
      await this.enforceStreamHealth();
      await this.enforceLiquidationPolicy();
      await this.executionPortfolioAgent.runPortfolioRefresh({
        runtimeState: this.stateStore.getState(),
      });
      await this.venueHeartbeatService.sync();
      this.logger.debug('Portfolio tick executed.', {
        botState: this.stateStore.getState(),
      });
    } catch (error) {
      this.logger.error('Portfolio tick failed.', undefined, {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.refreshingPortfolio = false;
    }
  }

  private async handleVenueHeartbeatDegraded(reasonCode: string): Promise<void> {
    if (this.venueHeartbeatProtectionActive) {
      return;
    }

    this.venueHeartbeatProtectionActive = true;
    try {
      await this.prisma.auditEvent.create({
        data: {
          eventType: 'venue.heartbeat.degraded',
          message: 'Venue open-order heartbeat degraded; entries were blocked and reconciliation was forced.',
          metadata: {
            reasonCode,
            botState: this.stateStore.getState(),
          } as object,
        },
      });

      if (this.stateStore.getState() === 'running') {
        this.stateStore.setState('reconciliation_only', reasonCode);
        await this.stopEntries();
      }

      await this.executionPortfolioAgent.runReconciliation({
        runtimeState: this.stateStore.getState(),
        operatingMode: this.stateStore.getOperatingMode(),
      });
      await this.executionPortfolioAgent.runPortfolioRefresh({
        runtimeState: this.stateStore.getState(),
      });
    } finally {
      this.venueHeartbeatProtectionActive = false;
    }
  }

  private async bootstrapStreamTruth(): Promise<void> {
    const markets = await this.loadTrackedMarkets();
    await this.marketStreamService.start(
      markets.flatMap((market) => [market.tokenIdYes, market.tokenIdNo]).filter(
        (tokenId): tokenId is string => Boolean(tokenId),
      ),
    );
    await this.userStreamService.start(
      markets.map((market) => ({
        marketId: market.id,
        tokenIds: [market.tokenIdYes, market.tokenIdNo].filter(
          (tokenId): tokenId is string => Boolean(tokenId),
        ),
      })),
    );
  }

  private async loadTrackedMarkets(): Promise<
    Array<{
      id: string;
      tokenIdYes: string | null;
      tokenIdNo: string | null;
    }>
  > {
    return this.prisma.market.findMany({
      where: {
        status: 'active',
      },
      select: {
        id: true,
        tokenIdYes: true,
        tokenIdNo: true,
      },
      take: 100,
    });
  }

  private async refreshStreamSubscriptions(): Promise<void> {
    const markets = await this.loadTrackedMarkets();
    await this.marketStreamService.syncSubscriptions(
      markets.flatMap((market) => [market.tokenIdYes, market.tokenIdNo]).filter(
        (tokenId): tokenId is string => Boolean(tokenId),
      ),
    );
    await this.userStreamService.syncSubscriptions(
      markets.map((market) => ({
        marketId: market.id,
        tokenIds: [market.tokenIdYes, market.tokenIdNo].filter(
          (tokenId): tokenId is string => Boolean(tokenId),
        ),
      })),
    );
  }

  private async enforceStreamHealth(): Promise<void> {
    const marketHealth = this.marketStreamService.evaluateHealth();
    const userHealth = this.userStreamService.evaluateHealth();
    await this.enforceExecutionStateTruth(userHealth);

    if (!marketHealth.healthy && this.stateStore.getState() === 'running') {
      this.stateStore.setState('degraded', marketHealth.reasonCode ?? 'market_stream_unhealthy');
      await this.prisma.auditEvent.create({
        data: {
          eventType: 'runtime.market_stream.degraded',
          message: 'Market stream truth became unhealthy; runtime degraded and entries blocked.',
          metadata: marketHealth as unknown as object,
        },
      });
    }

    if (!userHealth.healthy && this.stateStore.getState() !== 'halted_hard') {
      if (this.stateStore.getState() === 'running' || this.stateStore.getState() === 'degraded') {
        this.stateStore.setState(
          'reconciliation_only',
          userHealth.reasonCode ?? 'user_stream_unhealthy',
        );
        await this.stopEntries();
      }
      await this.executionPortfolioAgent.runReconciliation({
        runtimeState: this.stateStore.getState(),
        operatingMode: this.stateStore.getOperatingMode(),
      });
      await this.prisma.auditEvent.create({
        data: {
          eventType: 'runtime.user_stream.degraded',
          message:
            'User stream truth became unhealthy; runtime moved to reconciliation-only mode.',
          metadata: userHealth as unknown as object,
        },
      });
    }
  }

  private async enforceExecutionStateTruth(userHealth: ReturnType<UserWebSocketStateService['evaluateHealth']>): Promise<void> {
    const heartbeatHealth = this.venueHeartbeatService.evaluateHealth();
    const openOrderStatuses = await this.prisma.order.findMany({
      where: {
        status: {
          in: ['submitted', 'acknowledged', 'partially_filled', 'filled'],
        },
      },
      select: {
        id: true,
        status: true,
        lastError: true,
        lastVenueStatus: true,
        updatedAt: true,
      },
      take: 100,
    });
    const now = Date.now();
    const retryingCount = openOrderStatuses.filter((order) =>
      typeof order.lastError === 'string' && order.lastError.toLowerCase().includes('retry'),
    ).length;
    const failedCount = openOrderStatuses.filter((order) =>
      typeof order.lastError === 'string' &&
      (order.lastError.toLowerCase().includes('failed') ||
        order.lastError.toLowerCase().includes('reject'))
    ).length;
    const locallyFilledAbsent = openOrderStatuses.filter((order) => {
      if (order.status !== 'filled') {
        return false;
      }
      const status = String(order.lastVenueStatus ?? '').toLowerCase();
      return status.includes('missing_from_open_orders') || status.includes('absent_from_venue');
    });
    const oldestLocallyFilledAbsentAgeMs =
      locallyFilledAbsent.length === 0
        ? null
        : Math.max(
            0,
            now -
              Math.min(
                ...locallyFilledAbsent.map((order) => order.updatedAt?.getTime() ?? now),
              ),
          );

    const watchdogDecision = await this.executionStateWatchdog.evaluate({
      currentState: this.stateStore.getState(),
      anomalyInput: {
        userStream: {
          stale: userHealth.stale,
          liveOrdersWhileStale: userHealth.liveOrdersWhileStale,
          connected: userHealth.connected,
          reconnectAttempt: userHealth.reconnectAttempt,
          openOrders: userHealth.openOrders,
          lastTrafficAgeMs: userHealth.lastTrafficAgeMs,
          divergenceDetected: userHealth.divergenceDetected,
        },
        venueTruth: {
          disagreementCount: heartbeatHealth.disagreementCount,
          unresolvedGhostMismatch: heartbeatHealth.unresolvedGhostMismatch,
          lastVenueTruthAgeMs: heartbeatHealth.lastVenueTruthRefreshAt
            ? Math.max(0, now - new Date(heartbeatHealth.lastVenueTruthRefreshAt).getTime())
            : null,
          workingOpenOrders: heartbeatHealth.workingOpenOrders,
          cancelPendingTooLongCount: heartbeatHealth.cancelPendingTooLongCount,
        },
        lifecycle: {
          retryingCount,
          failedCount,
          ghostExposureDetected: heartbeatHealth.unresolvedGhostMismatch,
          unresolvedIntentCount: 0,
          locallyFilledButAbsentCount: locallyFilledAbsent.length,
          oldestLocallyFilledAbsentAgeMs,
        },
      },
    });

    if (!watchdogDecision.transitionRequest) {
      return;
    }

    const nextState = watchdogDecision.transitionRequest.nextState;
    if (nextState === this.stateStore.getState()) {
      return;
    }

    this.stateStore.setState(
      nextState,
      watchdogDecision.reasonCodes.join('|') || watchdogDecision.transitionRequest.reasonCode,
    );
    await this.runtimeControl.updateRuntimeStatus(
      this.stateStore.getState(),
      this.stateStore.getReason() ?? watchdogDecision.transitionRequest.reasonCode,
    );
    await this.prisma.auditEvent.create({
      data: {
        eventType: 'runtime.execution_state_watchdog_transition',
        message: 'Execution-state watchdog requested a runtime downgrade.',
        metadata: watchdogDecision as unknown as object,
      },
    });

    if (nextState === 'reconciliation_only' || nextState === 'cancel_only') {
      await this.stopEntries();
    }
  }

  private async enforceLiquidationPolicy(): Promise<void> {
    const [nearExpiryMarkets, latestExternalCheckpoint] = await Promise.all([
      this.loadNearExpiryExposureMarkets(),
      this.runtimeControl.getLatestCheckpoint('external_portfolio_reconcile'),
    ]);
    const btcSnapshot = this.syncBtcReferenceJob.getLastSnapshot();
    const userHealth = this.userStreamService.evaluateHealth();
    const checkpointDetails =
      latestExternalCheckpoint?.details &&
      typeof latestExternalCheckpoint.details === 'object'
        ? (latestExternalCheckpoint.details as Record<string, unknown>)
        : {};
    const checkpointSnapshot =
      checkpointDetails.snapshot && typeof checkpointDetails.snapshot === 'object'
        ? (checkpointDetails.snapshot as Record<string, unknown>)
        : {};
    const checkpointDivergence =
      checkpointSnapshot.divergence && typeof checkpointSnapshot.divergence === 'object'
        ? (checkpointSnapshot.divergence as Record<string, unknown>)
        : {};
    const divergenceStatus =
      typeof checkpointDivergence.status === 'string'
        ? checkpointDivergence.status
        : null;
    const plan = this.liquidationPolicy.evaluate([
      {
        trigger: 'near_expiry',
        active: nearExpiryMarkets.length > 0,
        severity: 'medium',
        reasonCode: 'liquidation_near_expiry',
        affectedMarketIds: nearExpiryMarkets,
        evidence: { nearExpiryMarkets },
      },
      {
        trigger: 'btc_reference_stale',
        active: !btcSnapshot,
        severity: 'medium',
        reasonCode: 'liquidation_btc_reference_stale',
        evidence: {
          lastObservedAt: btcSnapshot?.observedAt ?? null,
        },
      },
      {
        trigger: 'user_stream_lost',
        active: !userHealth.healthy,
        severity: 'high',
        reasonCode: userHealth.reasonCode ?? 'liquidation_user_stream_lost',
        evidence: userHealth as unknown as Record<string, unknown>,
      },
      {
        trigger: 'portfolio_truth_divergence',
        active: divergenceStatus === 'blocking' || divergenceStatus === 'recoverable',
        severity: divergenceStatus === 'blocking' ? 'high' : 'medium',
        reasonCode: `liquidation_${divergenceStatus ?? 'portfolio_truth'}`,
        evidence: {
          divergenceStatus,
        },
      },
    ]);

    if (!plan.active) {
      return;
    }

    if (plan.transitionTo && this.stateStore.getState() !== plan.transitionTo) {
      this.stateStore.setState(plan.transitionTo, plan.reasonCodes.join('|'));
      await this.runtimeControl.updateRuntimeStatus(
        this.stateStore.getState(),
        this.stateStore.getReason() ?? plan.reasonCodes.join('|'),
      );
    }

    if (plan.forceCancelAll) {
      await this.executionPortfolioAgent.runReconciliation({
        forceCancelAll: true,
        runtimeState: this.stateStore.getState(),
        operatingMode: this.stateStore.getOperatingMode(),
      });
    }

    await this.prisma.auditEvent.create({
      data: {
        eventType: 'runtime.inventory_liquidation_policy',
        message: 'Inventory liquidation policy triggered a runtime protection plan.',
        metadata: plan as unknown as object,
      },
    });
  }

  private async loadNearExpiryExposureMarkets(): Promise<string[]> {
    const now = Date.now();
    const markets = await this.prisma.market.findMany({
      where: {
        OR: [
          {
            positions: {
              some: {
                status: 'open',
              },
            },
          },
          {
            orders: {
              some: {
                status: {
                  in: ['submitted', 'acknowledged', 'partially_filled'],
                },
              },
            },
          },
        ],
      },
      select: {
        id: true,
        expiresAt: true,
      },
      take: 50,
    });

    return markets
      .filter((market) => {
        if (!(market.expiresAt instanceof Date)) {
          return false;
        }
        const secondsToExpiry = Math.floor((market.expiresAt.getTime() - now) / 1000);
        return secondsToExpiry <= 30;
      })
      .map((market) => market.id);
  }
}
