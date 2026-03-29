import { PrismaClient } from '@prisma/client';
import { AppLogger } from '@worker/common/logger';
import { SafetyState } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import {
  BotRuntimeState,
  normalizePersistedRuntimeState,
} from './runtime-state-machine';

export interface RuntimeCommand {
  id: string;
  command: 'start' | 'stop' | 'halt';
  reason: string;
  requestedBy: string | null;
  cancelOpenOrders: boolean;
  status: string;
  createdAt: Date;
}

export interface RecoveredRuntimeCommand {
  id: string;
  command: RuntimeCommand['command'];
  previousStatus: 'processing';
  recoveredStatus: 'applied' | 'failed';
  failureMessage: string | null;
  createdAt: Date;
}

export interface RuntimeLiveConfig {
  maxOpenPositions: number;
  maxDailyLossPct: number;
  maxPerTradeRiskPct: number;
  maxKellyFraction: number;
  maxConsecutiveLosses: number;
  noTradeWindowSeconds: number;
  evaluationIntervalMs: number;
  orderReconcileIntervalMs: number;
  portfolioRefreshIntervalMs: number;
}

export interface RuntimeOperationalFreshness {
  healthy: boolean;
  reasonCode: string | null;
  details: {
    lastPortfolioSnapshotAt: Date | null;
    lastOpenOrdersCheckpointAt: Date | null;
    lastFillCheckpointAt: Date | null;
    lastExternalPortfolioCheckpointAt: Date | null;
    lastVenueHeartbeatAt: Date | null;
    workingOpenOrders: number;
  };
}

export interface PersistedSafetyState {
  state: SafetyState;
  enteredAt: string;
  reasonCodes: string[];
  sizeMultiplier: number;
  evaluationCadenceMultiplier: number;
  allowAggressiveEntries: boolean;
  allowNewEntries: boolean;
  haltRequested: boolean;
  maxNewSignalsPerTick: number;
  evidence: Record<string, unknown>;
}

export class RuntimeControlRepository {
  private readonly logger = new AppLogger('RuntimeControlRepository');

  constructor(
    private readonly prisma: PrismaClient,
    private readonly defaults: RuntimeLiveConfig,
  ) {}

  async ensureInitialized(initialState: BotRuntimeState): Promise<void> {
    const prismaAny = this.prisma as any;

    await Promise.all([
      prismaAny.botRuntimeStatus.upsert({
        where: { id: 'live' },
        update: {},
        create: {
          id: 'live',
          state: initialState,
          reason: 'worker initialized',
          lastHeartbeatAt: new Date(),
        },
      }),
      prismaAny.liveConfig.upsert({
        where: { id: 'live' },
        update: {},
        create: {
          id: 'live',
          maxOpenPositions: this.defaults.maxOpenPositions,
          maxDailyLossPct: this.defaults.maxDailyLossPct,
          maxPerTradeRiskPct: this.defaults.maxPerTradeRiskPct,
          maxKellyFraction: this.defaults.maxKellyFraction,
          maxConsecutiveLosses: this.defaults.maxConsecutiveLosses,
          noTradeWindowSeconds: this.defaults.noTradeWindowSeconds,
          evaluationIntervalMs: this.defaults.evaluationIntervalMs,
          orderReconcileIntervalMs: this.defaults.orderReconcileIntervalMs,
          portfolioRefreshIntervalMs: this.defaults.portfolioRefreshIntervalMs,
        },
      }),
    ]);
  }

  async getRuntimeStatus(): Promise<{
    state: BotRuntimeState;
    reason: string | null;
  }> {
    const prismaAny = this.prisma as any;
    const status = await prismaAny.botRuntimeStatus.findUnique({
      where: { id: 'live' },
    });

    if (!status) {
      return {
        state: 'stopped',
        reason: 'status_missing',
      };
    }

    return {
      state: normalizePersistedRuntimeState(status.state),
      reason: status.reason ?? null,
    };
  }

  async updateRuntimeStatus(
    state: BotRuntimeState,
    reason: string,
    heartbeat = false,
  ): Promise<void> {
    const prismaAny = this.prisma as any;
    await prismaAny.botRuntimeStatus.upsert({
      where: { id: 'live' },
      update: {
        state,
        reason,
        ...(heartbeat ? { lastHeartbeatAt: new Date() } : {}),
      },
      create: {
        id: 'live',
        state,
        reason,
        lastHeartbeatAt: heartbeat ? new Date() : null,
      },
    });
  }

  async heartbeat(
    state: BotRuntimeState,
    reason: string | null,
  ): Promise<RuntimeOperationalFreshness> {
    const freshness =
      state === 'running' ||
      state === 'degraded' ||
      state === 'reconciliation_only' ||
      state === 'cancel_only'
        ? await this.assessOperationalFreshness()
        : {
            healthy: true,
            reasonCode: null,
            details: {
              lastPortfolioSnapshotAt: null,
              lastOpenOrdersCheckpointAt: null,
              lastFillCheckpointAt: null,
              lastExternalPortfolioCheckpointAt: null,
              lastVenueHeartbeatAt: null,
              workingOpenOrders: 0,
            },
          };

    const heartbeatReason = freshness.healthy
      ? reason ?? 'heartbeat'
      : `degraded:${freshness.reasonCode ?? 'operational_freshness_failed'}`;

    await this.updateRuntimeStatus(state, heartbeatReason, true);
    return freshness;
  }

  async getLiveConfig(): Promise<RuntimeLiveConfig> {
    const prismaAny = this.prisma as any;
    const config = await prismaAny.liveConfig.findUnique({
      where: { id: 'live' },
    });

    if (!config) {
      return this.defaults;
    }

    return {
      maxOpenPositions: config.maxOpenPositions,
      maxDailyLossPct: config.maxDailyLossPct,
      maxPerTradeRiskPct: config.maxPerTradeRiskPct,
      maxKellyFraction: config.maxKellyFraction,
      maxConsecutiveLosses: config.maxConsecutiveLosses,
      noTradeWindowSeconds: config.noTradeWindowSeconds,
      evaluationIntervalMs: config.evaluationIntervalMs,
      orderReconcileIntervalMs: config.orderReconcileIntervalMs,
      portfolioRefreshIntervalMs: config.portfolioRefreshIntervalMs,
    };
  }

  async claimNextPendingCommand(): Promise<RuntimeCommand | null> {
    const prismaAny = this.prisma as any;
    return this.prisma.$transaction(async (tx: unknown) => {
      const txAny = tx as any;
      const pending = await txAny.botRuntimeCommand.findFirst({
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' },
      });

      if (!pending) {
        return null;
      }

      const claimed = await txAny.botRuntimeCommand.updateMany({
        where: {
          id: pending.id,
          status: 'pending',
        },
        data: {
          status: 'processing',
        },
      });

      if (claimed.count === 0) {
        return null;
      }

      return pending as RuntimeCommand;
    });
  }

  async completeCommand(
    commandId: string,
    status: 'applied' | 'failed',
    failureMessage?: string,
  ): Promise<void> {
    const prismaAny = this.prisma as any;
    await prismaAny.botRuntimeCommand.update({
      where: { id: commandId },
      data: {
        status,
        failureMessage: failureMessage ?? null,
        processedAt: new Date(),
      },
    });
  }

  async recoverInterruptedProcessingCommands(input: {
    runtimeState: BotRuntimeState;
    runtimeReason: string | null;
  }): Promise<RecoveredRuntimeCommand[]> {
    const prismaAny = this.prisma as any;
    return this.prisma.$transaction(async (tx: unknown) => {
      const txAny = tx as any;
      const processingCommands = await txAny.botRuntimeCommand.findMany({
        where: { status: 'processing' },
        orderBy: { createdAt: 'asc' },
      });

      if (!Array.isArray(processingCommands) || processingCommands.length === 0) {
        return [];
      }

      const recoveredAt = new Date();
      const recovered: RecoveredRuntimeCommand[] = [];

      for (const command of processingCommands as RuntimeCommand[]) {
        const resolution = this.resolveInterruptedCommand(command.command, input);
        const updated = await txAny.botRuntimeCommand.updateMany({
          where: {
            id: command.id,
            status: 'processing',
          },
          data: {
            status: resolution.status,
            failureMessage: resolution.failureMessage,
            processedAt: recoveredAt,
          },
        });

        if (updated.count === 0) {
          continue;
        }

        recovered.push({
          id: command.id,
          command: command.command,
          previousStatus: 'processing',
          recoveredStatus: resolution.status,
          failureMessage: resolution.failureMessage,
          createdAt: command.createdAt,
        });
      }

      return recovered;
    });
  }

  async recordReconciliationCheckpoint(input: {
    cycleKey: string;
    source: string;
    status: string;
    details?: Record<string, unknown>;
  }): Promise<void> {
    const prismaAny = this.prisma as any;
    await prismaAny.reconciliationCheckpoint.create({
      data: {
        cycleKey: input.cycleKey,
        source: input.source,
        status: input.status,
        details: input.details ?? {},
        processedAt: new Date(),
      },
    });
  }

  async getLatestCheckpoint(source: string): Promise<{
    status: string;
    processedAt: Date;
    details: Record<string, unknown> | null;
  } | null> {
    const prismaAny = this.prisma as any;
    if (!prismaAny.reconciliationCheckpoint?.findFirst) {
      return null;
    }

    const latest = await prismaAny.reconciliationCheckpoint.findFirst({
      where: { source },
      orderBy: { processedAt: 'desc' },
    });

    if (!latest?.processedAt) {
      return null;
    }

    return {
      status: typeof latest.status === 'string' ? latest.status : 'unknown',
      processedAt: latest.processedAt,
      details:
        latest.details && typeof latest.details === 'object'
          ? (latest.details as Record<string, unknown>)
          : null,
    };
  }

  async getLatestSafetyState(): Promise<PersistedSafetyState> {
    const prismaAny = this.prisma as any;
    const latest = prismaAny.reconciliationCheckpoint?.findFirst
      ? await prismaAny.reconciliationCheckpoint.findFirst({
          where: { source: 'safety_state_machine' },
          orderBy: { processedAt: 'desc' },
        })
      : null;

    const details =
      latest?.details && typeof latest.details === 'object'
        ? (latest.details as Record<string, unknown>)
        : {};
    const snapshot =
      details.stateSnapshot && typeof details.stateSnapshot === 'object'
        ? (details.stateSnapshot as Record<string, unknown>)
        : {};

    return {
      state: this.readSafetyState(snapshot.state) ?? 'normal',
      enteredAt:
        this.readString(snapshot.enteredAt) ??
        latest?.processedAt?.toISOString() ??
        new Date(0).toISOString(),
      reasonCodes: Array.isArray(snapshot.reasonCodes)
        ? snapshot.reasonCodes.filter((value): value is string => typeof value === 'string')
        : [],
      sizeMultiplier: this.readNumber(snapshot.sizeMultiplier, 1),
      evaluationCadenceMultiplier: this.readNumber(
        snapshot.evaluationCadenceMultiplier,
        1,
      ),
      allowAggressiveEntries: this.readBoolean(snapshot.allowAggressiveEntries) ?? true,
      allowNewEntries: this.readBoolean(snapshot.allowNewEntries) ?? true,
      haltRequested: this.readBoolean(snapshot.haltRequested) ?? false,
      maxNewSignalsPerTick: this.readNumber(snapshot.maxNewSignalsPerTick, 4),
      evidence:
        snapshot.evidence && typeof snapshot.evidence === 'object'
          ? (snapshot.evidence as Record<string, unknown>)
          : {},
    };
  }

  async recordSafetyStateTransition(input: {
    state: PersistedSafetyState;
    previousState: SafetyState;
    changed: boolean;
  }): Promise<void> {
    const prismaAny = this.prisma as any;
    await prismaAny.reconciliationCheckpoint.create({
      data: {
        cycleKey: `safety-state:${Date.now()}`,
        source: 'safety_state_machine',
        status: input.changed ? 'transitioned' : 'steady',
        details: {
          stateSnapshot: input.state,
          previousState: input.previousState,
        },
        processedAt: new Date(),
      },
    });

    if (prismaAny.auditEvent?.create) {
      await prismaAny.auditEvent.create({
        data: {
          eventType: input.changed ? 'safety.state_transition' : 'safety.state_steady',
          message: input.changed
            ? 'Safety state transitioned.'
            : 'Safety state remained unchanged after evaluation.',
          metadata: {
            previousState: input.previousState,
            nextState: input.state.state,
            reasonCodes: input.state.reasonCodes,
            evidence: input.state.evidence,
          } as object,
        },
      });
    }
  }

  async assessOperationalFreshness(): Promise<RuntimeOperationalFreshness> {
    const prismaAny = this.prisma as any;
    const config = await this.getLiveConfig();
    const [
      latestPortfolioSnapshot,
      latestOpenOrdersCheckpoint,
      latestFillCheckpoint,
      latestExternalPortfolioCheckpoint,
      latestVenueHeartbeat,
      workingOpenOrders,
    ] =
      await Promise.all([
        prismaAny.portfolioSnapshot.findFirst({
          orderBy: { capturedAt: 'desc' },
        }),
        prismaAny.reconciliationCheckpoint.findFirst({
          where: { source: 'open_orders_reconcile' },
          orderBy: { processedAt: 'desc' },
        }),
        prismaAny.reconciliationCheckpoint.findFirst({
          where: { source: 'fills_reconcile_cycle' },
          orderBy: { processedAt: 'desc' },
        }),
        prismaAny.reconciliationCheckpoint.findFirst({
          where: { source: 'external_portfolio_reconcile' },
          orderBy: { processedAt: 'desc' },
        }),
        prismaAny.reconciliationCheckpoint.findFirst({
          where: { source: 'venue_open_orders_heartbeat' },
          orderBy: { processedAt: 'desc' },
        }),
        prismaAny.order?.count
          ? prismaAny.order.count({
              where: {
                status: {
                  in: ['submitted', 'acknowledged', 'partially_filled'],
                },
              },
            })
          : Promise.resolve(0),
      ]);

    const details = {
      lastPortfolioSnapshotAt: latestPortfolioSnapshot?.capturedAt ?? null,
      lastOpenOrdersCheckpointAt: latestOpenOrdersCheckpoint?.processedAt ?? null,
      lastFillCheckpointAt: latestFillCheckpoint?.processedAt ?? null,
      lastExternalPortfolioCheckpointAt:
        latestExternalPortfolioCheckpoint?.processedAt ?? null,
      externalPortfolioEntriesAllowed:
        latestExternalPortfolioCheckpoint?.details?.snapshot?.tradingPermissions
          ?.allowNewEntries ?? null,
      externalPortfolioFreshnessVerdict:
        latestExternalPortfolioCheckpoint?.details?.snapshot?.freshness?.overallVerdict ??
        null,
      externalPortfolioDivergenceStatus:
        latestExternalPortfolioCheckpoint?.details?.snapshot?.divergence?.status ?? null,
      lastVenueHeartbeatAt: latestVenueHeartbeat?.processedAt ?? null,
      workingOpenOrders,
    };

    if (!latestPortfolioSnapshot?.capturedAt) {
      return {
        healthy: false,
        reasonCode: 'portfolio_snapshot_missing',
        details,
      };
    }

    if (
      this.isOlderThan(
        latestPortfolioSnapshot.capturedAt,
        this.maxPortfolioSnapshotAgeMs(config),
      )
    ) {
      return {
        healthy: false,
        reasonCode: 'portfolio_snapshot_stale',
        details,
      };
    }

    const openOrderStatus = this.evaluateCheckpointFreshness({
      checkpoint: latestOpenOrdersCheckpoint,
      maxAgeMs: this.maxReconciliationAgeMs(config),
      missingReasonCode: 'open_orders_reconcile_missing',
      staleReasonCode: 'open_orders_reconcile_stale',
      failedReasonCode: 'open_orders_reconcile_failed',
    });
    if (!openOrderStatus.healthy) {
      return {
        healthy: false,
        reasonCode: openOrderStatus.reasonCode,
        details,
      };
    }

    const fillStatus = this.evaluateCheckpointFreshness({
      checkpoint: latestFillCheckpoint,
      maxAgeMs: this.maxReconciliationAgeMs(config),
      missingReasonCode: 'fills_reconcile_missing',
      staleReasonCode: 'fills_reconcile_stale',
      failedReasonCode: 'fills_reconcile_failed',
    });
    if (!fillStatus.healthy) {
      return {
        healthy: false,
        reasonCode: fillStatus.reasonCode,
        details,
      };
    }

    const externalPortfolioStatus = this.evaluateCheckpointFreshness({
      checkpoint: latestExternalPortfolioCheckpoint,
      maxAgeMs: this.maxPortfolioSnapshotAgeMs(config),
      missingReasonCode: 'external_portfolio_truth_missing',
      staleReasonCode: 'external_portfolio_truth_stale',
      failedReasonCode: 'external_portfolio_truth_failed',
    });
    if (!externalPortfolioStatus.healthy) {
      return {
        healthy: false,
        reasonCode: externalPortfolioStatus.reasonCode,
        details,
      };
    }

    if (
      latestExternalPortfolioCheckpoint?.details?.snapshot?.tradingPermissions
        ?.allowNewEntries === false
    ) {
      return {
        healthy: false,
        reasonCode: 'external_portfolio_truth_unhealthy',
        details,
      };
    }

    if (workingOpenOrders > 0) {
      const venueHeartbeatStatus = this.evaluateCheckpointFreshness({
        checkpoint: latestVenueHeartbeat,
        maxAgeMs: this.maxReconciliationAgeMs(config),
        missingReasonCode: 'venue_open_orders_heartbeat_missing',
        staleReasonCode: 'venue_open_orders_heartbeat_stale',
        failedReasonCode: 'venue_open_orders_heartbeat_failed',
      });
      if (!venueHeartbeatStatus.healthy) {
        return {
          healthy: false,
          reasonCode: venueHeartbeatStatus.reasonCode,
          details,
        };
      }
    }

    return {
      healthy: true,
      reasonCode: null,
      details,
    };
  }

  private evaluateCheckpointFreshness(input: {
    checkpoint:
      | {
          status?: string | null;
          processedAt?: Date | null;
        }
      | null;
    maxAgeMs: number;
    missingReasonCode: string;
    staleReasonCode: string;
    failedReasonCode: string;
  }): {
    healthy: boolean;
    reasonCode: string | null;
  } {
    if (!input.checkpoint?.processedAt) {
      return {
        healthy: false,
        reasonCode: input.missingReasonCode,
      };
    }

    if (
      typeof input.checkpoint.status === 'string' &&
      input.checkpoint.status.toLowerCase().includes('failed')
    ) {
      return {
        healthy: false,
        reasonCode: input.failedReasonCode,
      };
    }

    if (this.isOlderThan(input.checkpoint.processedAt, input.maxAgeMs)) {
      return {
        healthy: false,
        reasonCode: input.staleReasonCode,
      };
    }

    return {
      healthy: true,
      reasonCode: null,
    };
  }

  private maxPortfolioSnapshotAgeMs(config: RuntimeLiveConfig): number {
    return Math.max(config.portfolioRefreshIntervalMs * 2, 15_000);
  }

  private maxReconciliationAgeMs(config: RuntimeLiveConfig): number {
    return Math.max(config.orderReconcileIntervalMs * 2, 15_000);
  }

  private isOlderThan(value: Date, maxAgeMs: number): boolean {
    return Date.now() - value.getTime() > maxAgeMs;
  }

  private readSafetyState(value: unknown): SafetyState | null {
    return value === 'normal' ||
      value === 'reduced_size' ||
      value === 'reduced_frequency' ||
      value === 'passive_only' ||
      value === 'no_new_entries' ||
      value === 'halt'
      ? value
      : null;
  }

  private readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  private readNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  private readBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
  }

  private resolveInterruptedCommand(
    command: RuntimeCommand['command'],
    input: {
      runtimeState: BotRuntimeState;
      runtimeReason: string | null;
    },
  ): {
    status: 'applied' | 'failed';
    failureMessage: string | null;
  } {
    const failureMessage = input.runtimeReason
      ? `worker_restart_interrupted_before_terminal_acknowledgement:${input.runtimeState}:${input.runtimeReason}`
      : `worker_restart_interrupted_before_terminal_acknowledgement:${input.runtimeState}`;

    switch (command) {
      case 'start': {
        if (
          input.runtimeState === 'running' ||
          input.runtimeState === 'degraded' ||
          input.runtimeState === 'reconciliation_only' ||
          input.runtimeState === 'cancel_only'
        ) {
          return {
            status: 'applied',
            failureMessage: null,
          };
        }

        return {
          status: 'failed',
          failureMessage,
        };
      }
      case 'stop': {
        if (
          input.runtimeState === 'stopped' ||
          input.runtimeState === 'halted_hard'
        ) {
          return {
            status: 'applied',
            failureMessage: null,
          };
        }

        return {
          status: 'failed',
          failureMessage,
        };
      }
      case 'halt': {
        if (input.runtimeState === 'halted_hard') {
          return {
            status: 'applied',
            failureMessage: null,
          };
        }

        return {
          status: 'failed',
          failureMessage,
        };
      }
    }
  }
}
