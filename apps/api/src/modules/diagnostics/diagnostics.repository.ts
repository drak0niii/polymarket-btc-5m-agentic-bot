import { Injectable } from '@nestjs/common';
import { PrismaService } from '@api/modules/prisma/prisma.service';

interface CreateStressTestRunParams {
  family: string;
  status: string;
  startedAt: Date;
}

@Injectable()
export class DiagnosticsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findExecutionDiagnostics() {
    return this.prisma.executionDiagnostic.findMany({
      orderBy: {
        capturedAt: 'desc',
      },
    });
  }

  async findEvDriftDiagnostics() {
    return this.prisma.evDriftDiagnostic.findMany({
      orderBy: {
        capturedAt: 'desc',
      },
    });
  }

  async findRegimeDiagnostics() {
    return this.prisma.regimeDiagnostic.findMany({
      orderBy: {
        capturedAt: 'desc',
      },
    });
  }

  async findStressTestRuns() {
    return this.prisma.stressTestRun.findMany({
      include: {
        scenarioResults: true,
      },
      orderBy: {
        startedAt: 'desc',
      },
    });
  }

  async findReconciliationCheckpoints() {
    return (this.prisma as any).reconciliationCheckpoint.findMany({
      orderBy: {
        processedAt: 'desc',
      },
      take: 200,
    });
  }

  async getExposureDiagnostics() {
    const [latestPortfolio, openOrders, openPositions] = await Promise.all([
      this.prisma.portfolioSnapshot.findFirst({
        orderBy: {
          capturedAt: 'desc',
        },
      }),
      this.prisma.order.findMany({
        where: {
          status: {
            in: ['submitted', 'acknowledged', 'partially_filled'],
          },
        },
      }),
      this.prisma.position.findMany({
        where: {
          status: 'open',
        },
      }),
    ]);

    return {
      capturedAt: new Date().toISOString(),
      latestPortfolio,
      openOrdersCount: openOrders.length,
      openPositionsCount: openPositions.length,
      openOrderExposure: openOrders.reduce(
        (sum, order) =>
          sum +
          order.price *
            Math.max(
              0,
              order.remainingSize != null
                ? order.remainingSize
                : order.size - (order.filledSize ?? 0),
            ),
        0,
      ),
      openPositionExposure: openPositions.reduce(
        (sum, position) => sum + position.entryPrice * position.quantity,
        0,
      ),
    };
  }

  async getRiskAlerts() {
    const [latestPortfolio, liveConfig, recentRiskEvents] = await Promise.all([
      this.prisma.portfolioSnapshot.findFirst({
        orderBy: {
          capturedAt: 'desc',
        },
      }),
      (this.prisma as any).liveConfig.findUnique({
        where: { id: 'live' },
      }),
      this.prisma.auditEvent.findMany({
        where: {
          OR: [
            { eventType: { startsWith: 'risk.' } },
            { eventType: { startsWith: 'runtime.' } },
            { eventType: { startsWith: 'bot.halt' } },
          ],
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: 100,
      }),
    ]);

    const dailyLossLimit =
      latestPortfolio && liveConfig
        ? latestPortfolio.bankroll * (liveConfig.maxDailyLossPct / 100)
        : null;

    return {
      capturedAt: new Date().toISOString(),
      thresholds: {
        maxDailyLossPct: liveConfig?.maxDailyLossPct ?? null,
        maxConsecutiveLosses: liveConfig?.maxConsecutiveLosses ?? null,
        dailyLossLimit,
      },
      portfolio: latestPortfolio,
      alerts: recentRiskEvents,
    };
  }

  async createStressTestRun(params: CreateStressTestRunParams) {
    return this.prisma.stressTestRun.create({
      data: {
        family: params.family,
        status: params.status,
        startedAt: params.startedAt,
      },
    });
  }
}
