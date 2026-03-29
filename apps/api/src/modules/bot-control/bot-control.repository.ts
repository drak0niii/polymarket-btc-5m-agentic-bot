import { Inject, Injectable, Optional } from '@nestjs/common';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@api/modules/prisma/prisma.service';

export interface LiveConfigState {
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

export type TradingOperatingMode = 'sentinel_simulation' | 'live_trading';

export interface SentinelStatusState {
  updatedAt: string;
  recommendationState: 'not_ready' | 'ready_to_consider_live';
  recommendationMessage: string;
  simulatedTradesCompleted: number;
  simulatedTradesLearned: number;
  targetSimulatedTrades: number;
  targetLearnedTrades: number;
  readinessScore: number;
  readinessThreshold: number;
  expectedVsRealizedEdgeGapBps: number;
  fillQualityPassRate: number;
  noTradeDisciplinePassRate: number;
  learningCoverage: number;
  unresolvedAnomalyCount: number;
  recommendedLiveEnable: boolean;
}

export interface RuntimeCommandState {
  id: string;
  command: 'start' | 'stop' | 'halt';
  reason: string;
  requestedBy: string | null;
  cancelOpenOrders: boolean;
  status: 'pending' | 'processing' | 'applied' | 'failed' | 'blocked';
  failureMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  processedAt: Date | null;
}

export interface ReconciliationCheckpointState {
  status: string;
  processedAt: Date;
  details: Record<string, unknown> | null;
}

export interface EnqueueCommandResult {
  admitted: boolean;
  command: RuntimeCommandState;
  conflictingCommand: RuntimeCommandState | null;
}

@Injectable()
export class BotControlRepository {
  private readonly runtimeStatePath: string;
  private readonly sentinelReadinessPath: string;

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject('BOT_CONTROL_REPOSITORY_PATHS')
    paths?: {
      runtimeStatePath?: string;
      sentinelReadinessPath?: string;
    },
  ) {
    this.runtimeStatePath =
      paths?.runtimeStatePath ??
      path.join(resolveRepositoryRoot(), 'artifacts/runtime/bot-state.latest.json');
    this.sentinelReadinessPath =
      paths?.sentinelReadinessPath ??
      path.join(resolveRepositoryRoot(), 'artifacts/learning/sentinel/readiness.latest.json');
  }

  async getOrCreateRuntimeStatus(defaultState: string) {
    return this.prisma.botRuntimeStatus.upsert({
      where: { id: 'live' },
      update: {},
      create: {
        id: 'live',
        state: defaultState,
        reason: 'initialized',
      },
    });
  }

  async getOrCreateLiveConfig(defaults: LiveConfigState) {
    return this.prisma.liveConfig.upsert({
      where: { id: 'live' },
      update: {},
      create: {
        id: 'live',
        maxOpenPositions: defaults.maxOpenPositions,
        maxDailyLossPct: defaults.maxDailyLossPct,
        maxPerTradeRiskPct: defaults.maxPerTradeRiskPct,
        maxKellyFraction: defaults.maxKellyFraction,
        maxConsecutiveLosses: defaults.maxConsecutiveLosses,
        noTradeWindowSeconds: defaults.noTradeWindowSeconds,
        evaluationIntervalMs: defaults.evaluationIntervalMs,
        orderReconcileIntervalMs: defaults.orderReconcileIntervalMs,
        portfolioRefreshIntervalMs: defaults.portfolioRefreshIntervalMs,
      },
    });
  }

  async updateLiveConfig(input: Partial<LiveConfigState>) {
    return this.prisma.liveConfig.update({
      where: { id: 'live' },
      data: {
        ...(input.maxOpenPositions !== undefined
          ? { maxOpenPositions: input.maxOpenPositions }
          : {}),
        ...(input.maxDailyLossPct !== undefined
          ? { maxDailyLossPct: input.maxDailyLossPct }
          : {}),
        ...(input.maxPerTradeRiskPct !== undefined
          ? { maxPerTradeRiskPct: input.maxPerTradeRiskPct }
          : {}),
        ...(input.maxKellyFraction !== undefined
          ? { maxKellyFraction: input.maxKellyFraction }
          : {}),
        ...(input.maxConsecutiveLosses !== undefined
          ? { maxConsecutiveLosses: input.maxConsecutiveLosses }
          : {}),
        ...(input.noTradeWindowSeconds !== undefined
          ? { noTradeWindowSeconds: input.noTradeWindowSeconds }
          : {}),
        ...(input.evaluationIntervalMs !== undefined
          ? { evaluationIntervalMs: input.evaluationIntervalMs }
          : {}),
        ...(input.orderReconcileIntervalMs !== undefined
          ? { orderReconcileIntervalMs: input.orderReconcileIntervalMs }
          : {}),
        ...(input.portfolioRefreshIntervalMs !== undefined
          ? { portfolioRefreshIntervalMs: input.portfolioRefreshIntervalMs }
          : {}),
      },
    });
  }

  async createCommand(input: {
    command: 'start' | 'stop' | 'halt';
    reason: string;
    requestedBy?: string | null;
    cancelOpenOrders?: boolean;
    status?: 'pending' | 'blocked';
    failureMessage?: string | null;
  }) {
    return this.prisma.botRuntimeCommand.create({
      data: {
        command: input.command,
        reason: input.reason,
        requestedBy: input.requestedBy ?? null,
        cancelOpenOrders: input.cancelOpenOrders ?? false,
        status: input.status ?? 'pending',
        failureMessage: input.failureMessage ?? null,
        ...(input.status === 'blocked' ? { processedAt: new Date() } : {}),
      },
    });
  }

  async enqueueCommand(input: {
    command: 'start' | 'stop' | 'halt';
    reason: string;
    requestedBy?: string | null;
    cancelOpenOrders?: boolean;
    blockedReason: string;
  }): Promise<EnqueueCommandResult> {
    return this.runSerializedCommandTransaction(async (tx) => {
      await tx.botRuntimeStatus.upsert({
        where: { id: 'live' },
        update: {},
        create: {
          id: 'live',
          state: 'stopped',
          reason: 'initialized',
        },
      });
      await tx.$queryRaw`SELECT 1 FROM "bot_runtime_status" WHERE id = 'live' FOR UPDATE`;

      const conflictingCommand = (await tx.botRuntimeCommand.findFirst({
        where: {
          command: input.command,
          status: {
            in: ['pending', 'processing'],
          },
        },
        orderBy: { createdAt: 'asc' },
      })) as RuntimeCommandState | null;

      if (conflictingCommand) {
        const command = (await tx.botRuntimeCommand.create({
          data: {
            command: input.command,
            reason: input.reason,
            requestedBy: input.requestedBy ?? null,
            cancelOpenOrders: input.cancelOpenOrders ?? false,
            status: 'blocked',
            failureMessage: input.blockedReason,
            processedAt: new Date(),
          },
        })) as RuntimeCommandState;

        return {
          admitted: false,
          command,
          conflictingCommand,
        };
      }

      const command = (await tx.botRuntimeCommand.create({
        data: {
          command: input.command,
          reason: input.reason,
          requestedBy: input.requestedBy ?? null,
          cancelOpenOrders: input.cancelOpenOrders ?? false,
          status: 'pending',
        },
      })) as RuntimeCommandState;

      return {
        admitted: true,
        command,
        conflictingCommand: null,
      };
    });
  }

  async findPendingCommands(limit = 5) {
    return this.prisma.botRuntimeCommand.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  async findActiveCommands(limit = 20): Promise<RuntimeCommandState[]> {
    return this.prisma.botRuntimeCommand.findMany({
      where: {
        status: {
          in: ['pending', 'processing'],
        },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    }) as Promise<RuntimeCommandState[]>;
  }

  async findActiveCommand(command: 'start' | 'stop' | 'halt') {
    return this.prisma.botRuntimeCommand.findFirst({
      where: {
        command,
        status: { in: ['pending', 'processing'] },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findRecentCommands(limit = 50): Promise<RuntimeCommandState[]> {
    return this.prisma.botRuntimeCommand.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    }) as Promise<RuntimeCommandState[]>;
  }

  async findLatestCommand(
    command: 'start' | 'stop' | 'halt',
  ): Promise<RuntimeCommandState | null> {
    return this.prisma.botRuntimeCommand.findFirst({
      where: { command },
      orderBy: { createdAt: 'desc' },
    }) as Promise<RuntimeCommandState | null>;
  }

  async findLatestCheckpoint(source: string): Promise<ReconciliationCheckpointState | null> {
    const latest = await this.prisma.reconciliationCheckpoint.findFirst({
      where: { source },
      orderBy: { processedAt: 'desc' },
    });

    if (!latest?.processedAt) {
      return null;
    }

    return {
      status: latest.status,
      processedAt: latest.processedAt,
      details:
        latest.details && typeof latest.details === 'object'
          ? (latest.details as Record<string, unknown>)
          : null,
    };
  }

  async getOperatingMode(): Promise<TradingOperatingMode> {
    const state = await this.readRuntimeArtifact();
    return state.operatingMode;
  }

  async setOperatingMode(
    operatingMode: TradingOperatingMode,
    reason: string,
  ): Promise<void> {
    const current = await this.readRuntimeArtifact();
    await this.writeRuntimeArtifact({
      ...current,
      operatingMode,
      reason,
      updatedAt: new Date().toISOString(),
    });
  }

  async readSentinelStatus(): Promise<SentinelStatusState | null> {
    try {
      const content = await fs.readFile(this.sentinelReadinessPath, 'utf8');
      return JSON.parse(content) as SentinelStatusState;
    } catch (error) {
      if (isMissingFile(error)) {
        return null;
      }

      return null;
    }
  }

  private async runSerializedCommandTransaction<T>(
    run: (tx: Prisma.TransactionClient) => Promise<T>,
    retries = 3,
  ): Promise<T> {
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        return await this.prisma.$transaction(run, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (attempt === retries || !isSerializationFailure(error)) {
          throw error;
        }
      }
    }

    throw new Error('Failed to serialize command transaction.');
  }

  private async readRuntimeArtifact(): Promise<{
    state: string;
    operatingMode: TradingOperatingMode;
    reason: string | null;
    updatedAt: string;
  }> {
    try {
      const content = await fs.readFile(this.runtimeStatePath, 'utf8');
      const parsed = JSON.parse(content) as Partial<{
        state: string;
        operatingMode: TradingOperatingMode;
        reason: string | null;
        updatedAt: string;
      }>;
      return {
        state: typeof parsed.state === 'string' ? parsed.state : 'stopped',
        operatingMode:
          parsed.operatingMode === 'live_trading' ? 'live_trading' : 'sentinel_simulation',
        reason: typeof parsed.reason === 'string' ? parsed.reason : null,
        updatedAt:
          typeof parsed.updatedAt === 'string'
            ? parsed.updatedAt
            : new Date().toISOString(),
      };
    } catch (error) {
      if (!isMissingFile(error)) {
        return {
          state: 'stopped',
          operatingMode: 'sentinel_simulation',
          reason: 'runtime_artifact_unreadable',
          updatedAt: new Date().toISOString(),
        };
      }

      return {
        state: 'stopped',
        operatingMode: 'sentinel_simulation',
        reason: null,
        updatedAt: new Date().toISOString(),
      };
    }
  }

  private async writeRuntimeArtifact(value: {
    state: string;
    operatingMode: TradingOperatingMode;
    reason: string | null;
    updatedAt: string;
  }): Promise<void> {
    fsSync.mkdirSync(path.dirname(this.runtimeStatePath), { recursive: true });
    const tmpPath = `${this.runtimeStatePath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(tmpPath, this.runtimeStatePath);
  }
}

function resolveRepositoryRoot(start = process.cwd()): string {
  let current = path.resolve(start);
  while (true) {
    if (
      fsSync.existsSync(path.join(current, 'pnpm-workspace.yaml')) ||
      fsSync.existsSync(path.join(current, 'AGENTS.md'))
    ) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return start;
    }
    current = parent;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

function isSerializationFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2034'
  );
}
