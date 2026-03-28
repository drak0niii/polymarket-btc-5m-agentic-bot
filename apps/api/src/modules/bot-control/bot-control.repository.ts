import { Injectable } from '@nestjs/common';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
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

@Injectable()
export class BotControlRepository {
  private readonly runtimeStatePath: string;
  private readonly sentinelReadinessPath: string;

  constructor(
    private readonly prisma: PrismaService,
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
  }) {
    return this.prisma.botRuntimeCommand.create({
      data: {
        command: input.command,
        reason: input.reason,
        requestedBy: input.requestedBy ?? null,
        cancelOpenOrders: input.cancelOpenOrders ?? false,
        status: 'pending',
      },
    });
  }

  async findPendingCommands(limit = 5) {
    return this.prisma.botRuntimeCommand.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
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
          parsed.operatingMode === 'sentinel_simulation' ? 'sentinel_simulation' : 'live_trading',
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
          operatingMode: 'live_trading',
          reason: 'runtime_artifact_unreadable',
          updatedAt: new Date().toISOString(),
        };
      }

      return {
        state: 'stopped',
        operatingMode: 'live_trading',
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
