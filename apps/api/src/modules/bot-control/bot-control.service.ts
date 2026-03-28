import { Injectable } from '@nestjs/common';
import { AppLogger } from '@api/common/logger';
import { appEnv } from '@api/config/env';
import {
  InvalidStateTransitionError,
  LiveConfigurationError,
  ReadinessError,
} from '@api/common/errors';
import { AuditService } from '@api/modules/audit/audit.service';
import {
  BotControlRepository,
  LiveConfigState,
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
    const [runtimeStatus, liveConfig, pendingCommands, operatingMode, sentinelStatus] =
      await Promise.all([
        this.repository.getOrCreateRuntimeStatus(appEnv.BOT_DEFAULT_STATUS),
        this.repository.getOrCreateLiveConfig(this.defaultLiveConfig),
        this.repository.findPendingCommands(),
        this.repository.getOperatingMode(),
        this.repository.readSentinelStatus(),
      ]);
    const readiness = this.buildReadiness(liveConfig, operatingMode);

    return {
      state: runtimeStatus.state as BotRuntimeState,
      operatingMode,
      sentinelEnabled: operatingMode === 'sentinel_simulation',
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
        source: 'worker_runtime',
        pendingCommands: pendingCommands.map((command) => ({
          id: command.id,
          command: command.command,
          cancelOpenOrders: command.cancelOpenOrders,
          createdAt: command.createdAt,
        })),
      },
    };
  }

  async start(dto: StartBotDto) {
    if (dto.operatingMode) {
      await this.repository.setOperatingMode(
        dto.operatingMode,
        `mode set during start request by ${dto.requestedBy ?? 'unknown'}`,
      );
    }

    const [runtimeStatus, liveConfig, operatingMode] = await Promise.all([
      this.repository.getOrCreateRuntimeStatus(appEnv.BOT_DEFAULT_STATUS),
      this.repository.getOrCreateLiveConfig(this.defaultLiveConfig),
      this.repository.getOperatingMode(),
    ]);

    if (
      runtimeStatus.state !== 'stopped' &&
      runtimeStatus.state !== 'halted_hard'
    ) {
      throw new InvalidStateTransitionError(
        `Bot can only start from "stopped" or "halted_hard". Current state: ${runtimeStatus.state}`,
      );
    }

    const readiness = this.buildReadiness(liveConfig, operatingMode);
    if (!readiness.ready) {
      throw new ReadinessError('Bot readiness checks failed. Cannot queue start.');
    }

    const command = await this.repository.createCommand({
      command: 'start',
      reason: dto.reason ?? 'manual start requested',
      requestedBy: dto.requestedBy,
    });

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
    const runtimeStatus = await this.repository.getOrCreateRuntimeStatus(
      appEnv.BOT_DEFAULT_STATUS,
    );

    if (runtimeStatus.state === 'stopped') {
      await this.auditService.record({
        eventType: 'bot.stop.noop',
        message: 'Stop requested while runtime is already stopped.',
        metadata: {
          reason: dto.reason ?? null,
          requestedBy: dto.requestedBy ?? null,
        },
      });

      return this.getState();
    }

    const command = await this.repository.createCommand({
      command: 'stop',
      reason: dto.reason ?? 'manual stop requested',
      requestedBy: dto.requestedBy,
      cancelOpenOrders: dto.cancelOpenOrders ?? false,
    });

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
    const runtimeStatus = await this.repository.getOrCreateRuntimeStatus(
      appEnv.BOT_DEFAULT_STATUS,
    );

    const command = await this.repository.createCommand({
      command: 'halt',
      reason: dto.reason ?? 'manual emergency halt requested',
      requestedBy: dto.requestedBy,
      cancelOpenOrders: dto.cancelOpenOrders ?? true,
    });

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

  private buildReadiness(liveConfig: {
    maxOpenPositions: number;
    maxDailyLossPct: number;
    maxPerTradeRiskPct: number;
    maxKellyFraction: number;
  }, operatingMode: TradingOperatingMode) {
    const checks = {
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
    };

    return {
      ready: Object.values(checks).every(Boolean),
      checks,
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
