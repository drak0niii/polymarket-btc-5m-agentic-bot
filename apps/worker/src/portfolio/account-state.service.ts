import { PrismaClient } from '@prisma/client';
import {
  CanonicalAccountState,
  AccountStateInventory,
  AccountStateReservation,
} from '@polymarket-btc-5m-agentic-bot/domain';
import {
  ExternalPortfolioService,
  ExternalPortfolioSnapshot,
} from './external-portfolio.service';

export class AccountStateService {
  private readonly externalPortfolioService: ExternalPortfolioService;

  constructor(
    private readonly prisma: PrismaClient,
    externalPortfolioService?: ExternalPortfolioService,
  ) {
    this.externalPortfolioService =
      externalPortfolioService ?? new ExternalPortfolioService(prisma);
  }

  async capture(options?: {
    persist?: boolean;
    externalSnapshot?: ExternalPortfolioSnapshot | null;
    portfolioSnapshot?: {
      id?: string;
      bankroll: number;
      availableCapital: number;
      openExposure: number;
      realizedPnlDay: number;
      unrealizedPnl: number;
      consecutiveLosses: number;
      capturedAt: Date;
    } | null;
    marketStreamHealthy?: boolean | null;
    userStreamHealthy?: boolean | null;
  }): Promise<CanonicalAccountState> {
    const prismaAny = this.prisma as any;
    const [
      latestPortfolio,
      workingOrders,
      fills,
      externalSnapshot,
    ] = await Promise.all([
      options?.portfolioSnapshot
        ? Promise.resolve(options.portfolioSnapshot)
        : this.prisma.portfolioSnapshot.findFirst({
            orderBy: { capturedAt: 'desc' },
          }),
      prismaAny.order?.findMany
        ? prismaAny.order.findMany({
            where: {
              status: {
                in: ['submitted', 'acknowledged', 'partially_filled'],
              },
            },
            orderBy: { createdAt: 'desc' },
            take: 100,
          })
        : Promise.resolve([]),
      prismaAny.fill?.findMany
        ? prismaAny.fill.findMany({
            where: {
              filledAt: {
                gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
              },
            },
            orderBy: { filledAt: 'desc' },
            take: 500,
          })
        : Promise.resolve([]),
      options?.externalSnapshot !== undefined
        ? Promise.resolve(options.externalSnapshot)
        : prismaAny.reconciliationCheckpoint?.findFirst
          ? this.externalPortfolioService.loadLatestSnapshot().catch(() => null)
          : Promise.resolve(null),
    ]);

    if (!latestPortfolio) {
      throw new Error('canonical_account_state_inputs_missing');
    }
    const normalizedExternalSnapshot =
      externalSnapshot ??
      ({
        snapshotId: null,
        bankroll: latestPortfolio.bankroll,
        availableCapital: latestPortfolio.availableCapital,
        reservedCash: 0,
        openOrderExposure: 0,
        cash: {
          grossBalance: latestPortfolio.availableCapital,
          tradableBuyHeadroom: latestPortfolio.availableCapital,
        },
        inventories: [],
        reconciliationHealth: 'healthy',
        tradingPermissions: {
          allowNewEntries: true,
          allowPositionManagement: true,
          reasonCodes: [],
        },
      } as unknown as ExternalPortfolioSnapshot);

    const reservations: AccountStateReservation[] = (workingOrders as Array<Record<string, any>>)
      .filter((order): order is Record<string, any> & { tokenId: string } => typeof order.tokenId === 'string')
      .map((order) => {
        const remainingSize = Math.max(
          0,
          order.remainingSize != null ? order.remainingSize : order.size - (order.filledSize ?? 0),
        );
        return {
          orderId: order.id,
          marketId: order.marketId,
          tokenId: order.tokenId,
          side: order.side as 'BUY' | 'SELL',
          remainingSize,
          reservedNotional: order.side === 'BUY' ? order.price * remainingSize : 0,
        };
      });

    const startOfHour = Date.now() - 60 * 60 * 1000;
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    const realizedPnlHour = (fills as Array<Record<string, any>>)
      .filter((fill) => fill.filledAt.getTime() >= startOfHour)
      .reduce((sum, fill) => sum + (fill.realizedPnl ?? 0), 0);
    const feesPaidDay = (fills as Array<Record<string, any>>)
      .filter((fill) => fill.filledAt >= startOfDay)
      .reduce((sum, fill) => sum + Math.max(0, fill.fee ?? 0), 0);

    const inventories: AccountStateInventory[] = normalizedExternalSnapshot.inventories.map((inventory) => ({
      marketId: inventory.marketId,
      tokenId: inventory.tokenId,
      outcome: inventory.outcome,
      quantity: inventory.positionQuantity,
      availableQuantity: inventory.availableQuantity,
      reservedQuantity: inventory.reservedQuantity,
      allowance: inventory.allowance,
      markPrice: inventory.markPrice,
      markedValue: inventory.markedValue,
    }));

    const marketExposure = new Map<string, number>();
    for (const inventory of inventories) {
      if (inventory.marketId) {
        marketExposure.set(
          inventory.marketId,
          (marketExposure.get(inventory.marketId) ?? 0) + Math.max(0, inventory.markedValue),
        );
      }
    }
    const largestMarket = [...marketExposure.entries()].sort((left, right) => right[1] - left[1])[0];
    const largestToken = [...inventories]
      .sort((left, right) => right.markedValue - left.markedValue)[0];
    const exposureBase = Math.max(normalizedExternalSnapshot.bankroll, 1);
    const workingBuyNotional = reservations
      .filter((reservation) => reservation.side === 'BUY')
      .reduce((sum, reservation) => sum + reservation.reservedNotional, 0);
    const workingSellQuantity = reservations
      .filter((reservation) => reservation.side === 'SELL')
      .reduce((sum, reservation) => sum + reservation.remainingSize, 0);
    const unresolvedBuyReservation = 0;
    const availableCash = Math.max(
      0,
      normalizedExternalSnapshot.cash.tradableBuyHeadroom - unresolvedBuyReservation,
    );
    const freshnessReasons = [...(normalizedExternalSnapshot.tradingPermissions?.reasonCodes ?? [])];
    if (options?.marketStreamHealthy === false) {
      freshnessReasons.push('market_stream_unhealthy');
    }
    if (options?.userStreamHealthy === false) {
      freshnessReasons.push('user_stream_unhealthy');
    }
    const freshnessState =
      !normalizedExternalSnapshot.tradingPermissions?.allowPositionManagement ||
      options?.userStreamHealthy === false
        ? 'stale'
        : !normalizedExternalSnapshot.tradingPermissions?.allowNewEntries ||
            options?.marketStreamHealthy === false
          ? 'degraded'
          : 'healthy';

    const snapshot: CanonicalAccountState = {
      source: 'canonical_account_state_v1',
      capturedAt: new Date().toISOString(),
      portfolioSnapshotId: typeof latestPortfolio.id === 'string' ? latestPortfolio.id : null,
      externalSnapshotId: normalizedExternalSnapshot.snapshotId,
      bankroll: latestPortfolio.bankroll,
      grossCash: normalizedExternalSnapshot.cash.grossBalance,
      availableCash,
      reservedCash: normalizedExternalSnapshot.reservedCash,
      unresolvedBuyReservation,
      workingBuyNotional,
      workingSellQuantity,
      deployableRiskNow: Math.max(0, availableCash - workingBuyNotional),
      openExposure: latestPortfolio.openExposure,
      openOrderExposure: normalizedExternalSnapshot.openOrderExposure,
      realizedPnlDay: latestPortfolio.realizedPnlDay,
      realizedPnlHour,
      unrealizedPnl: latestPortfolio.unrealizedPnl,
      feesPaidDay,
      rewardsPaidDay: 0,
      consecutiveLosses: latestPortfolio.consecutiveLosses,
      inventories,
      reservations,
      concentration: {
        largestMarketId: largestMarket?.[0] ?? null,
        largestMarketExposure: largestMarket?.[1] ?? 0,
        largestMarketRatio: (largestMarket?.[1] ?? 0) / exposureBase,
        largestTokenId: largestToken?.tokenId ?? null,
        largestTokenExposure: largestToken?.markedValue ?? 0,
        largestTokenRatio: (largestToken?.markedValue ?? 0) / exposureBase,
      },
      freshness: {
        state: freshnessState,
        allowNewEntries:
          normalizedExternalSnapshot.tradingPermissions?.allowNewEntries !== false &&
          options?.marketStreamHealthy !== false &&
          options?.userStreamHealthy !== false,
        allowPositionManagement:
          normalizedExternalSnapshot.tradingPermissions?.allowPositionManagement !== false &&
          options?.userStreamHealthy !== false,
        reasonCodes: [...new Set(freshnessReasons)],
        externalSnapshotHealthy: normalizedExternalSnapshot.reconciliationHealth === 'healthy',
        marketStreamHealthy: options?.marketStreamHealthy ?? null,
        userStreamHealthy: options?.userStreamHealthy ?? null,
      },
    };

    if (options?.persist === false) {
      return snapshot;
    }
    await prismaAny.reconciliationCheckpoint?.create?.({
      data: {
        cycleKey: `canonical-account-state:${Date.now()}`,
        source: 'canonical_account_state',
        status: 'completed',
        details: {
          snapshot,
        },
        processedAt: new Date(snapshot.capturedAt),
      },
    });

    return snapshot;
  }
}
