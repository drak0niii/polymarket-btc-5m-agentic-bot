import { Injectable } from '@nestjs/common';
import { AppLogger } from '@api/common/logger';
import { appEnv } from '@api/config/env';
import {
  BotControlError,
  ConflictError,
  InvalidStateTransitionError,
  LiveConfigurationError,
  ReadinessError,
} from '@api/common/errors';
import { AuditService } from '@api/modules/audit/audit.service';
import {
  BotControlRepository,
  LiveConfigState,
  ReconciliationCheckpointState,
  RuntimeCommandState,
  SentinelStatusState,
  TradingOperatingMode,
} from './bot-control.repository';
import { StartBotDto } from './dto/start-bot.dto';
import { StopBotDto } from './dto/stop-bot.dto';
import { HaltBotDto } from './dto/halt-bot.dto';
import { SetLiveConfigDto } from './dto/set-live-config.dto';

type BotRuntimeState =
  | 'bootstrapping'
  | 'running'
  | 'degraded'
  | 'reconciliation_only'
  | 'cancel_only'
  | 'halted_hard'
  | 'stopped';

type CommandType = 'start' | 'stop' | 'halt';

const WORKER_HEARTBEAT_STALE_AFTER_MS = Math.max(
  appEnv.BOT_PORTFOLIO_REFRESH_INTERVAL_MS * 2,
  15_000,
);
const STARTUP_GATE_STALE_AFTER_MS = 45_000;

interface StartupGateSnapshot {
  status: 'passed' | 'failed' | 'missing' | 'stale';
  mode: 'live' | 'test' | 'sentinel' | null;
  blockingReasons: string[];
  processedAt: string | null;
}

@Injectable()
export class BotControlService {
  private readonly logger = new AppLogger('BotControlService');
  private readonly defaultLiveConfig: LiveConfigState = {
    maxOpenPositions: appEnv.MAX_OPEN_POSITIONS,
    maxDailyLossPct: appEnv.MAX_DAILY_LOSS_PCT,
    maxPerTradeRiskPct: appEnv.MAX_PER_TRADE_RISK_PCT,
    maxKellyFraction: appEnv.MAX_KELLY_FRACTION,
    maxConsecutiveLosses: appEnv.MAX_CONSECUTIVE_LOSSES,
    noTradeWindowSeconds: appEnv.NO_TRADE_WINDOW_SECONDS,
    evaluationIntervalMs: appEnv.BOT_EVALUATION_INTERVAL_MS,
    orderReconcileIntervalMs: appEnv.BOT_ORDER_RECONCILE_INTERVAL_MS,
    portfolioRefreshIntervalMs: appEnv.BOT_PORTFOLIO_REFRESH_INTERVAL_MS,
  };

  constructor(
    private readonly repository: BotControlRepository,
    private readonly auditService: AuditService,
  ) {}

  async getState() {
    const [
      runtimeStatus,
      liveConfig,
      pendingCommands,
      activeCommands,
      recentCommands,
      latestStartCommand,
      latestStopCommand,
      latestHaltCommand,
      operatingMode,
      sentinelStatus,
      startupGateCheckpoint,
    ] =
      await Promise.all([
        this.repository.getOrCreateRuntimeStatus(appEnv.BOT_DEFAULT_STATUS),
        this.repository.getOrCreateLiveConfig(this.defaultLiveConfig),
        this.repository.findPendingCommands(),
        this.repository.findActiveCommands(),
        this.repository.findRecentCommands(),
        this.repository.findLatestCommand('start'),
        this.repository.findLatestCommand('stop'),
        this.repository.findLatestCommand('halt'),
        this.repository.getOperatingMode(),
        this.repository.readSentinelStatus(),
        this.repository.findLatestCheckpoint('startup_gate_verdict'),
      ]);
    const startupGate = this.readStartupGate(startupGateCheckpoint);
    const readiness = this.buildReadiness(
      runtimeStatus,
      liveConfig,
      operatingMode,
      startupGate,
    );
    const operatingModeState = this.buildOperatingModeResponse(
      operatingMode,
      sentinelStatus,
    );

    return {
      state: runtimeStatus.state as BotRuntimeState,
      operatingMode,
      sentinelEnabled: operatingMode === 'sentinel_simulation',
      eligibleForLiveTrading: operatingModeState.eligibleForLiveTrading,
      warningText: operatingModeState.warningText,
      recommendedLiveEnable: sentinelStatus?.recommendedLiveEnable ?? false,
      sentinelStatus,
      deploymentTier: appEnv.BOT_DEPLOYMENT_TIER,
      liveConfig: {
        maxOpenPositions: liveConfig.maxOpenPositions,
        maxDailyLossPct: liveConfig.maxDailyLossPct,
        maxPerTradeRiskPct: liveConfig.maxPerTradeRiskPct,
        maxKellyFraction: liveConfig.maxKellyFraction,
        maxConsecutiveLosses: liveConfig.maxConsecutiveLosses,
        noTradeWindowSeconds: liveConfig.noTradeWindowSeconds,
        evaluationIntervalMs: liveConfig.evaluationIntervalMs,
        orderReconcileIntervalMs: liveConfig.orderReconcileIntervalMs,
        portfolioRefreshIntervalMs: liveConfig.portfolioRefreshIntervalMs,
      },
      lastTransitionAt: runtimeStatus.updatedAt.toISOString(),
      lastTransitionReason: runtimeStatus.reason,
      readiness,
      controlPlane: {
        source: this.isWorkerAvailable(runtimeStatus)
          ? 'worker_runtime'
          : 'worker_runtime_stale',
        activeCommands: activeCommands.map((command) => this.serializeCommand(command)),
        latestCommandByType: {
          start: this.serializeCommand(latestStartCommand),
          stop: this.serializeCommand(latestStopCommand),
          halt: this.serializeCommand(latestHaltCommand),
        },
        pendingCommands: pendingCommands.map((command) => ({
          id: command.id,
          command: command.command,
          cancelOpenOrders: command.cancelOpenOrders,
          createdAt: command.createdAt.toISOString(),
        })),
        recentCommands: recentCommands.map((command) => this.serializeCommand(command)),
      },
    };
  }

  async start(dto: StartBotDto) {
    if (dto.operatingMode) {
      await this.assertOperatingModeAllowed(dto.operatingMode);
      await this.repository.setOperatingMode(
        dto.operatingMode,
        `mode set during start request by ${dto.requestedBy ?? 'unknown'}`,
      );
    }

    const [runtimeStatus, liveConfig, operatingMode, startupGateCheckpoint] = await Promise.all([
      this.repository.getOrCreateRuntimeStatus(appEnv.BOT_DEFAULT_STATUS),
      this.repository.getOrCreateLiveConfig(this.defaultLiveConfig),
      this.repository.getOperatingMode(),
      this.repository.findLatestCheckpoint('startup_gate_verdict'),
    ]);

    if (
      runtimeStatus.state !== 'stopped' &&
      runtimeStatus.state !== 'halted_hard'
    ) {
      throw new InvalidStateTransitionError(
        `Bot can only start from "stopped" or "halted_hard". Current state: ${runtimeStatus.state}`,
      );
    }

    const startupGate = this.readStartupGate(startupGateCheckpoint);
    const readiness = this.buildReadiness(
      runtimeStatus,
      liveConfig,
      operatingMode,
      startupGate,
    );
    if (!readiness.ready) {
      await this.recordBlockedCommand({
        command: 'start',
        reason: dto.reason ?? 'manual start requested',
        requestedBy: dto.requestedBy,
        failureMessage: `Start rejected before queueing. ${readiness.blockingReasons.join(', ')}`,
        cancelOpenOrders: false,
      });
      throw new ReadinessError(
        `Bot readiness checks failed. Cannot queue start. Blocking checks: ${readiness.blockingReasons.join(', ')}`,
      );
    }

    const queued = await this.repository.enqueueCommand({
      command: 'start',
      reason: dto.reason ?? 'manual start requested',
      requestedBy: dto.requestedBy,
      blockedReason: 'Another start command is already pending or processing.',
    });
    if (!queued.admitted) {
      await this.auditCommandBlocked(
        queued.command,
        queued.command.failureMessage ?? 'Another start command is already pending or processing.',
      );
      throw new ConflictError(
        queued.command.failureMessage ??
          `start command ${queued.conflictingCommand?.id ?? 'unknown'} is already active.`,
      );
    }
    const command = queued.command;

    await this.auditService.record({
      eventType: 'bot.start.command_queued',
      message: 'Start command queued for worker runtime.',
      metadata: {
        commandId: command.id,
        reason: dto.reason ?? null,
        requestedBy: dto.requestedBy ?? null,
      },
    });

    this.logger.log('Start command queued.', {
      botState: runtimeStatus.state,
    });

    return this.getState();
  }

  async stop(dto: StopBotDto) {
    const [runtimeStatus, activeStart] = await Promise.all([
      this.repository.getOrCreateRuntimeStatus(appEnv.BOT_DEFAULT_STATUS),
      this.repository.findActiveCommand('start'),
    ]);

    if (runtimeStatus.state === 'stopped' && !activeStart) {
      await this.recordBlockedCommand({
        command: 'stop',
        reason: dto.reason ?? 'manual stop requested',
        requestedBy: dto.requestedBy,
        cancelOpenOrders: dto.cancelOpenOrders ?? false,
        failureMessage:
          'Stop rejected before queueing. Runtime is already stopped and no start command is active.',
      });

      return this.getState();
    }

    const queued = await this.repository.enqueueCommand({
      command: 'stop',
      reason: dto.reason ?? 'manual stop requested',
      requestedBy: dto.requestedBy,
      cancelOpenOrders: dto.cancelOpenOrders ?? false,
      blockedReason: 'Another stop command is already pending or processing.',
    });
    if (!queued.admitted) {
      await this.auditCommandBlocked(
        queued.command,
        queued.command.failureMessage ?? 'Another stop command is already pending or processing.',
      );
      throw new ConflictError(
        queued.command.failureMessage ??
          `stop command ${queued.conflictingCommand?.id ?? 'unknown'} is already active.`,
      );
    }
    const command = queued.command;

    await this.auditService.record({
      eventType: 'bot.stop.command_queued',
      message: 'Stop command queued for worker runtime.',
      metadata: {
        commandId: command.id,
        reason: dto.reason ?? null,
        requestedBy: dto.requestedBy ?? null,
        cancelOpenOrders: dto.cancelOpenOrders ?? false,
      },
    });

    this.logger.warn('Stop command queued.', {
      botState: runtimeStatus.state,
    });

    return this.getState();
  }

  async halt(dto: HaltBotDto) {
    const [runtimeStatus, activeStart] = await Promise.all([
      this.repository.getOrCreateRuntimeStatus(appEnv.BOT_DEFAULT_STATUS),
      this.repository.findActiveCommand('start'),
    ]);

    if (
      (runtimeStatus.state === 'stopped' || runtimeStatus.state === 'halted_hard') &&
      !activeStart
    ) {
      const failureMessage = `Emergency halt is not available from "${runtimeStatus.state}".`;
      await this.recordBlockedCommand({
        command: 'halt',
        reason: dto.reason ?? 'manual emergency halt requested',
        requestedBy: dto.requestedBy,
        cancelOpenOrders: dto.cancelOpenOrders ?? true,
        failureMessage,
      });
      throw new InvalidStateTransitionError(
        failureMessage,
      );
    }

    const queued = await this.repository.enqueueCommand({
      command: 'halt',
      reason: dto.reason ?? 'manual emergency halt requested',
      requestedBy: dto.requestedBy,
      cancelOpenOrders: dto.cancelOpenOrders ?? true,
      blockedReason: 'Another halt command is already pending or processing.',
    });
    if (!queued.admitted) {
      await this.auditCommandBlocked(
        queued.command,
        queued.command.failureMessage ?? 'Another halt command is already pending or processing.',
      );
      throw new ConflictError(
        queued.command.failureMessage ??
          `halt command ${queued.conflictingCommand?.id ?? 'unknown'} is already active.`,
      );
    }
    const command = queued.command;

    await this.auditService.record({
      eventType: 'bot.halt.command_queued',
      message: 'Emergency halt command queued for worker runtime.',
      metadata: {
        commandId: command.id,
        reason: dto.reason ?? null,
        requestedBy: dto.requestedBy ?? null,
        cancelOpenOrders: dto.cancelOpenOrders ?? true,
      },
    });

    this.logger.error('Halt command queued.', undefined, {
      botState: runtimeStatus.state,
    });

    return this.getState();
  }

  async setLiveConfig(dto: SetLiveConfigDto) {
    if (dto.operatingMode) {
      await this.assertOperatingModeAllowed(dto.operatingMode);
      await this.repository.setOperatingMode(
        dto.operatingMode,
        `mode set during live-config update by ${dto.updatedBy ?? 'unknown'}`,
      );
    }

    this.validateLiveConfig(dto);
    await this.repository.getOrCreateLiveConfig(this.defaultLiveConfig);

    const liveConfig = await this.repository.updateLiveConfig({
      ...(dto.maxOpenPositions !== undefined
        ? { maxOpenPositions: dto.maxOpenPositions }
        : {}),
      ...(dto.maxDailyLossPct !== undefined
        ? { maxDailyLossPct: dto.maxDailyLossPct }
        : {}),
      ...(dto.maxPerTradeRiskPct !== undefined
        ? { maxPerTradeRiskPct: dto.maxPerTradeRiskPct }
        : {}),
      ...(dto.maxKellyFraction !== undefined
        ? { maxKellyFraction: dto.maxKellyFraction }
        : {}),
      ...(dto.maxConsecutiveLosses !== undefined
        ? { maxConsecutiveLosses: dto.maxConsecutiveLosses }
        : {}),
      ...(dto.noTradeWindowSeconds !== undefined
        ? { noTradeWindowSeconds: dto.noTradeWindowSeconds }
        : {}),
      ...(dto.evaluationIntervalMs !== undefined
        ? { evaluationIntervalMs: dto.evaluationIntervalMs }
        : {}),
      ...(dto.orderReconcileIntervalMs !== undefined
        ? { orderReconcileIntervalMs: dto.orderReconcileIntervalMs }
        : {}),
      ...(dto.portfolioRefreshIntervalMs !== undefined
        ? { portfolioRefreshIntervalMs: dto.portfolioRefreshIntervalMs }
        : {}),
    });

    await this.auditService.record({
      eventType: 'bot.live_config.updated',
      message: 'Live bot configuration updated.',
      metadata: {
        updatedBy: dto.updatedBy ?? null,
        config: liveConfig,
      },
    });

    this.logger.log('Live bot configuration updated.');

    return this.getState();
  }

  async getOperatingMode() {
    const [operatingMode, sentinelStatus] = await Promise.all([
      this.repository.getOperatingMode(),
      this.repository.readSentinelStatus(),
    ]);

    return this.buildOperatingModeResponse(operatingMode, sentinelStatus);
  }

  async setOperatingMode(input: {
    operatingMode: TradingOperatingMode;
    requestedBy?: string | null;
  }) {
    await this.assertOperatingModeAllowed(input.operatingMode);
    await this.repository.setOperatingMode(
      input.operatingMode,
      `mode set by ${input.requestedBy ?? 'api'} via bot-control`,
    );
    await this.auditService.record({
      eventType: 'bot.operating_mode.updated',
      message: 'Bot operating mode updated.',
      metadata: {
        operatingMode: input.operatingMode,
        requestedBy: input.requestedBy ?? null,
      },
    });

    const sentinelStatus = await this.repository.readSentinelStatus();
    return this.buildOperatingModeResponse(input.operatingMode, sentinelStatus);
  }

  private buildReadiness(
    runtimeStatus: {
      state: string;
      reason: string | null;
      lastHeartbeatAt: Date | null;
      updatedAt: Date;
    },
    liveConfig: {
      maxOpenPositions: number;
      maxDailyLossPct: number;
      maxPerTradeRiskPct: number;
      maxKellyFraction: number;
    },
    operatingMode: TradingOperatingMode,
    startupGate: StartupGateSnapshot,
  ) {
    const workerHeartbeat = this.isWorkerAvailable(runtimeStatus);
    const expectedStartupGateMode =
      operatingMode === 'sentinel_simulation'
        ? 'sentinel'
        : appEnv.IS_TEST
          ? 'test'
          : 'live';
    const startupGatePassed =
      startupGate.status === 'passed' && startupGate.mode === expectedStartupGateMode;
    const checks: Record<string, boolean> = {
      env: Boolean(appEnv.DATABASE_URL && appEnv.REDIS_URL),
      signing:
        operatingMode === 'sentinel_simulation' ? true : Boolean(appEnv.POLY_PRIVATE_KEY),
      credentials: Boolean(
        operatingMode === 'sentinel_simulation' ||
          (appEnv.POLY_API_KEY &&
            appEnv.POLY_API_SECRET &&
            appEnv.POLY_API_PASSPHRASE),
      ),
      liveMode:
        operatingMode === 'sentinel_simulation' ||
        appEnv.BOT_LIVE_EXECUTION_ENABLED === true,
      riskConfig:
        liveConfig.maxOpenPositions > 0 &&
        liveConfig.maxDailyLossPct > 0 &&
        liveConfig.maxPerTradeRiskPct > 0 &&
        liveConfig.maxKellyFraction > 0,
      workerHeartbeat,
      startupGate: startupGatePassed,
    };
    const blockingReasons: string[] = Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);

    if (!workerHeartbeat) {
      blockingReasons.push(this.buildWorkerAvailabilityReason(runtimeStatus));
    }

    if (startupGate.status === 'missing') {
      blockingReasons.push('startup_gate_missing');
    } else if (startupGate.status === 'stale') {
      blockingReasons.push('startup_gate_stale');
    } else if (startupGate.mode !== expectedStartupGateMode) {
      blockingReasons.push(
        `startup_gate_mode_mismatch:expected_${expectedStartupGateMode}_got_${startupGate.mode ?? 'unknown'}`,
      );
    } else if (startupGate.status === 'failed') {
      blockingReasons.push(
        `startup_gate_failed:${startupGate.blockingReasons.join('|') || 'unknown'}`,
      );
    }

    return {
      ready: Object.values(checks).every(Boolean),
      checks,
      blockingReasons,
    };
  }

  private buildOperatingModeResponse(
    operatingMode: TradingOperatingMode,
    sentinelStatus: SentinelStatusState | null,
  ) {
    const warningText =
      operatingMode === 'live_trading' && !(sentinelStatus?.recommendedLiveEnable ?? false)
        ? 'Sentinel has not reached readiness thresholds yet. Live trading remains user-controlled.'
        : operatingMode === 'sentinel_simulation'
          ? 'Sentinel simulation never places real orders.'
          : null;

    return {
      operatingMode,
      sentinelEnabled: operatingMode === 'sentinel_simulation',
      eligibleForLiveTrading: sentinelStatus?.recommendedLiveEnable ?? false,
      warningText,
      sentinelStatus,
    };
  }

  private serializeCommand(command: RuntimeCommandState | null) {
    if (!command) {
      return null;
    }

    return {
      id: command.id,
      command: command.command,
      reason: command.reason,
      requestedBy: command.requestedBy,
      cancelOpenOrders: command.cancelOpenOrders,
      status: command.status,
      failureMessage: command.failureMessage,
      createdAt: command.createdAt.toISOString(),
      updatedAt: command.updatedAt.toISOString(),
      processedAt: command.processedAt?.toISOString() ?? null,
    };
  }

  private async assertOperatingModeAllowed(
    operatingMode: TradingOperatingMode,
  ): Promise<void> {
    if (operatingMode !== 'live_trading') {
      return;
    }

    const sentinelStatus = await this.repository.readSentinelStatus();

    if (!(sentinelStatus?.recommendedLiveEnable ?? false)) {
      throw new BotControlError(
        sentinelStatus?.recommendationMessage ??
          'Live trading is blocked until sentinel readiness recommends it.',
      );
    }
  }

  private async recordBlockedCommand(input: {
    command: CommandType;
    reason: string;
    requestedBy?: string | null;
    failureMessage: string;
    cancelOpenOrders?: boolean;
  }): Promise<void> {
    const command = (await this.repository.createCommand({
      command: input.command,
      reason: input.reason,
      requestedBy: input.requestedBy,
      cancelOpenOrders: input.cancelOpenOrders,
      status: 'blocked',
      failureMessage: input.failureMessage,
    })) as RuntimeCommandState;
    await this.auditCommandBlocked(command, input.failureMessage);
  }

  private async auditCommandBlocked(
    command: RuntimeCommandState,
    failureMessage: string,
  ): Promise<void> {
    await this.auditService.record({
      eventType: `bot.${command.command}.command_blocked`,
      message: `${command.command} command rejected before queueing.`,
      metadata: {
        commandId: command.id,
        reason: command.reason,
        requestedBy: command.requestedBy,
        cancelOpenOrders: command.cancelOpenOrders,
        failureMessage,
      },
    });
  }

  private readStartupGate(
    checkpoint: ReconciliationCheckpointState | null,
  ): StartupGateSnapshot {
    if (!checkpoint?.processedAt) {
      return {
        status: 'missing',
        mode: null,
        blockingReasons: [],
        processedAt: null,
      };
    }

    if (Date.now() - checkpoint.processedAt.getTime() > STARTUP_GATE_STALE_AFTER_MS) {
      return {
        status: 'stale',
        mode: this.readStartupGateMode(checkpoint.details),
        blockingReasons: this.readStartupGateBlockingReasons(checkpoint.details),
        processedAt: checkpoint.processedAt.toISOString(),
      };
    }

    return {
      status: checkpoint.status === 'completed' ? 'passed' : 'failed',
      mode: this.readStartupGateMode(checkpoint.details),
      blockingReasons: this.readStartupGateBlockingReasons(checkpoint.details),
      processedAt: checkpoint.processedAt.toISOString(),
    };
  }

  private readStartupGateMode(
    details: Record<string, unknown> | null,
  ): StartupGateSnapshot['mode'] {
    const mode = details?.mode;
    if (mode === 'live' || mode === 'test' || mode === 'sentinel') {
      return mode;
    }

    return null;
  }

  private readStartupGateBlockingReasons(
    details: Record<string, unknown> | null,
  ): string[] {
    const reasons = details?.blockingReasons;
    if (!Array.isArray(reasons)) {
      return [];
    }

    return reasons.filter((reason): reason is string => typeof reason === 'string');
  }

  private isWorkerAvailable(runtimeStatus: {
    lastHeartbeatAt: Date | null;
  }): boolean {
    if (!runtimeStatus.lastHeartbeatAt) {
      return false;
    }

    return Date.now() - runtimeStatus.lastHeartbeatAt.getTime() <= WORKER_HEARTBEAT_STALE_AFTER_MS;
  }

  private buildWorkerAvailabilityReason(runtimeStatus: {
    lastHeartbeatAt: Date | null;
  }): string {
    if (!runtimeStatus.lastHeartbeatAt) {
      return 'worker_heartbeat_missing';
    }

    return 'worker_heartbeat_stale';
  }

  private validateLiveConfig(dto: SetLiveConfigDto): void {
    if (dto.maxOpenPositions !== undefined && dto.maxOpenPositions < 1) {
      throw new LiveConfigurationError('maxOpenPositions must be at least 1.');
    }

    if (dto.maxDailyLossPct !== undefined && dto.maxDailyLossPct <= 0) {
      throw new LiveConfigurationError('maxDailyLossPct must be greater than 0.');
    }

    if (dto.maxPerTradeRiskPct !== undefined && dto.maxPerTradeRiskPct <= 0) {
      throw new LiveConfigurationError(
        'maxPerTradeRiskPct must be greater than 0.',
      );
    }

    if (dto.maxKellyFraction !== undefined && dto.maxKellyFraction <= 0) {
      throw new LiveConfigurationError('maxKellyFraction must be greater than 0.');
    }

    if (dto.maxConsecutiveLosses !== undefined && dto.maxConsecutiveLosses < 1) {
      throw new LiveConfigurationError(
        'maxConsecutiveLosses must be at least 1.',
      );
    }

    if (dto.noTradeWindowSeconds !== undefined && dto.noTradeWindowSeconds < 0) {
      throw new LiveConfigurationError(
        'noTradeWindowSeconds must be at least 0.',
      );
    }

    if (dto.evaluationIntervalMs !== undefined && dto.evaluationIntervalMs <= 0) {
      throw new LiveConfigurationError(
        'evaluationIntervalMs must be greater than 0.',
      );
    }

    if (
      dto.orderReconcileIntervalMs !== undefined &&
      dto.orderReconcileIntervalMs <= 0
    ) {
      throw new LiveConfigurationError(
        'orderReconcileIntervalMs must be greater than 0.',
      );
    }

    if (
      dto.portfolioRefreshIntervalMs !== undefined &&
      dto.portfolioRefreshIntervalMs <= 0
    ) {
      throw new LiveConfigurationError(
        'portfolioRefreshIntervalMs must be greater than 0.',
      );
    }
  }
}
