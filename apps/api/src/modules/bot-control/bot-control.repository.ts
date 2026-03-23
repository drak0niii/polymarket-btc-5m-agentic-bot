import { Injectable } from '@nestjs/common';
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

@Injectable()
export class BotControlRepository {
  constructor(private readonly prisma: PrismaService) {}

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
}
