import { randomUUID } from 'crypto';
import { Position, PrismaClient } from '@prisma/client';
import { AppLogger } from '@worker/common/logger';
import { BotRuntimeState } from '@worker/runtime/bot-state';
import { permissionsForRuntimeState } from '@worker/runtime/runtime-state-machine';
import {
  ExternalPortfolioService,
  ExternalPortfolioSnapshot,
} from '@worker/portfolio/external-portfolio.service';
import { FeeAccountingService } from '@polymarket-btc-5m-agentic-bot/execution-engine';

interface LedgerState {
  marketId: string;
  tokenId: string;
  outcome: 'YES' | 'NO' | 'UNKNOWN';
  signedQty: number;
  avgEntryPrice: number;
  realizedPnl: number;
  markPrice: number;
}

interface RealizedEvent {
  occurredAt: Date;
  pnl: number;
}

interface LedgerKeyParts {
  marketId: string;
  tokenId: string;
}

export class RefreshPortfolioJob {
  private readonly logger = new AppLogger('RefreshPortfolioJob');
  private readonly externalPortfolioService: ExternalPortfolioService;
  private readonly feeAccounting = new FeeAccountingService();

  constructor(private readonly prisma: PrismaClient) {
    this.externalPortfolioService = new ExternalPortfolioService(this.prisma);
  }

  async run(options?: {
    runtimeState?: BotRuntimeState;
  }): Promise<{ snapshotId: string | null }> {
    if (
      options?.runtimeState &&
      !permissionsForRuntimeState(options.runtimeState).allowPortfolioRefresh
    ) {
      return { snapshotId: null };
    }

    const [allFills, markets, latestSnapshots, latestOrderbooks, openPositions, externalSnapshot] =
      await Promise.all([
        this.prisma.fill.findMany({
          orderBy: { filledAt: 'asc' },
          include: { order: true },
        }),
        this.prisma.market.findMany(),
        this.prisma.marketSnapshot.findMany({
          orderBy: { observedAt: 'desc' },
        }),
        this.prisma.orderbook.findMany({
          orderBy: { observedAt: 'desc' },
        }),
        this.prisma.position.findMany({
          where: { status: 'open' },
          orderBy: { openedAt: 'asc' },
        }),
        this.externalPortfolioService.capture({
          cycleKey: `portfolio-refresh:${Date.now()}`,
          source: 'external_portfolio_reconcile',
        }),
      ]);

    const marketById = new Map(markets.map((market) => [market.id, market]));

    const latestSnapshotByMarket = new Map<string, (typeof latestSnapshots)[number]>();
    for (const snapshot of latestSnapshots) {
      if (!latestSnapshotByMarket.has(snapshot.marketId)) {
        latestSnapshotByMarket.set(snapshot.marketId, snapshot);
      }
    }

    const latestOrderbookByLedgerKey = new Map<string, (typeof latestOrderbooks)[number]>();
    for (const orderbook of latestOrderbooks) {
      if (!orderbook.tokenId) {
        continue;
      }
      const key = this.ledgerKey(orderbook.marketId, orderbook.tokenId);
      if (!latestOrderbookByLedgerKey.has(key)) {
        latestOrderbookByLedgerKey.set(key, orderbook);
      }
    }

    const ledgers = new Map<string, LedgerState>();
    const realizedEvents: RealizedEvent[] = [];

    for (const fill of allFills) {
      if (!fill.order) {
        continue;
      }

      const marketId = fill.marketId;
      const tokenId = fill.order.tokenId;
      if (!tokenId) {
        continue;
      }

      const market = marketById.get(marketId) ?? null;
      const outcome = this.resolveOutcomeForToken(market, tokenId);
      const key = this.ledgerKey(marketId, tokenId);
      const side = fill.order.side.toUpperCase();
      const signedDelta = side === 'BUY' ? fill.size : -fill.size;
      const fee = fill.fee ?? 0;
      const markPrice = this.resolveMarkPrice({
        market,
        marketId,
        tokenId,
        fallbackPrice: fill.price,
        latestSnapshotByMarket,
        latestOrderbookByLedgerKey,
      });

      const previous = ledgers.get(key) ?? {
        marketId,
        tokenId,
        outcome,
        signedQty: 0,
        avgEntryPrice: 0,
        realizedPnl: 0,
        markPrice,
      };

      let nextSignedQty = previous.signedQty;
      let nextAvgEntry = previous.avgEntryPrice;
      let realizedDelta = -fee;

      if (
        Math.abs(previous.signedQty) <= 1e-12 ||
        Math.sign(previous.signedQty) === Math.sign(signedDelta)
      ) {
        const nextAbsQty = Math.abs(previous.signedQty) + Math.abs(signedDelta);
        if (nextAbsQty > 0) {
          nextAvgEntry =
            (Math.abs(previous.signedQty) * previous.avgEntryPrice +
              Math.abs(signedDelta) * fill.price) /
            nextAbsQty;
        }
        nextSignedQty = previous.signedQty + signedDelta;
      } else {
        const closingQty = Math.min(
          Math.abs(previous.signedQty),
          Math.abs(signedDelta),
        );

        realizedDelta +=
          (fill.price - previous.avgEntryPrice) *
          closingQty *
          Math.sign(previous.signedQty);

        nextSignedQty = previous.signedQty + signedDelta;

        if (Math.abs(nextSignedQty) <= 1e-12) {
          nextSignedQty = 0;
          nextAvgEntry = 0;
        } else if (Math.sign(nextSignedQty) !== Math.sign(previous.signedQty)) {
          nextAvgEntry = fill.price;
        }
      }

      if (Math.abs(realizedDelta) > 1e-12) {
        realizedEvents.push({
          occurredAt: fill.filledAt,
          pnl: realizedDelta,
        });
      }

      ledgers.set(key, {
        marketId,
        tokenId,
        outcome,
        signedQty: nextSignedQty,
        avgEntryPrice: nextAvgEntry,
        realizedPnl: previous.realizedPnl + realizedDelta,
        markPrice,
      });

      if ((fill.realizedPnl ?? 0) !== realizedDelta) {
        await this.prisma.fill.update({
          where: { id: fill.id },
          data: { realizedPnl: realizedDelta },
        });
      }
    }

    const openLedgers = this.reconcileExternalInventoryLedgers(ledgers, externalSnapshot);
    await this.reconcileOpenPositions(openLedgers, openPositions);

    const openLedgerValues = [...openLedgers.values()];
    const openExposure = openLedgerValues.reduce(
      (sum, value) => sum + Math.abs(value.signedQty) * value.markPrice,
      0,
    );

    const unrealizedPnl = openLedgerValues.reduce(
      (sum, value) => sum + this.computeUnrealizedPnl(value),
      0,
    );

    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    const realizedPnlDay = realizedEvents
      .filter((event) => event.occurredAt >= startOfDay)
      .reduce((sum, event) => sum + event.pnl, 0);

    const consecutiveLosses = this.computeConsecutiveLosses(realizedEvents);

    if (!externalSnapshot.snapshotId) {
      throw new Error('external_portfolio_snapshot_not_persisted');
    }

    const snapshot = await this.prisma.portfolioSnapshot.update({
      where: { id: externalSnapshot.snapshotId },
      data: {
        bankroll: externalSnapshot.bankroll,
        availableCapital: externalSnapshot.availableCapital,
        openExposure,
        realizedPnlDay,
        unrealizedPnl,
        consecutiveLosses,
        capturedAt: new Date(externalSnapshot.capturedAt),
      },
    });

    this.logger.debug('Portfolio snapshot refreshed.', {
      snapshotId: snapshot.id,
      bankroll: externalSnapshot.bankroll,
      availableCapital: externalSnapshot.availableCapital,
      openExposure,
      openOrderExposure: externalSnapshot.openOrderExposure,
      realizedPnlDay,
      consecutiveLosses,
      openTokenLedgers: openLedgerValues.length,
      yesOpenLedgers: openLedgerValues.filter((ledger) => ledger.outcome === 'YES').length,
      noOpenLedgers: openLedgerValues.filter((ledger) => ledger.outcome === 'NO').length,
      reservedCash: externalSnapshot.reservedCash,
      workingOpenOrders: externalSnapshot.workingOpenOrders,
      externalFreshnessVerdict: externalSnapshot.freshness.overallVerdict,
      externalDivergenceStatus: externalSnapshot.divergence.status,
      externalRecoveryMode: externalSnapshot.recovery.mode,
      externalEntriesAllowed:
        externalSnapshot.tradingPermissions?.allowNewEntries ?? false,
    });

    return { snapshotId: snapshot.id };
  }

  private reconcileExternalInventoryLedgers(
    localLedgers: Map<string, LedgerState>,
    externalSnapshot: ExternalPortfolioSnapshot,
  ): Map<string, LedgerState> {
    const reconciled = new Map<string, LedgerState>();

    for (const inventory of externalSnapshot.inventories) {
      const canonicalQuantity =
        inventory.positionQuantity > 1e-12 ? inventory.positionQuantity : inventory.balance;
      if (canonicalQuantity <= 1e-12 || !inventory.marketId) {
        continue;
      }

      const key = this.ledgerKey(inventory.marketId, inventory.tokenId);
      const local = localLedgers.get(key) ?? null;
      const markPrice =
        inventory.markPrice ??
        local?.markPrice ??
        local?.avgEntryPrice ??
        0;

      reconciled.set(key, {
        marketId: inventory.marketId,
        tokenId: inventory.tokenId,
        outcome: inventory.outcome,
        signedQty: canonicalQuantity,
        avgEntryPrice:
          local && local.avgEntryPrice > 0 ? local.avgEntryPrice : markPrice,
        realizedPnl: local?.realizedPnl ?? 0,
        markPrice,
      });
    }

    return reconciled;
  }

  private async reconcileOpenPositions(
    ledgers: Map<string, LedgerState>,
    existingOpenPositions: Position[],
  ): Promise<void> {
    const now = new Date();
    const existingByLedgerKey = new Map<string, Position[]>();
    const handledKeys = new Set<string>();

    for (const position of existingOpenPositions) {
      const tokenId = this.readStringField(position, 'tokenId');
      if (!tokenId) {
        continue;
      }

      const key = this.ledgerKey(position.marketId, tokenId);
      const bucket = existingByLedgerKey.get(key) ?? [];
      bucket.push(position);
      existingByLedgerKey.set(key, bucket);
    }

    for (const [key, positions] of existingByLedgerKey.entries()) {
      const ordered = [...positions].sort(
        (left, right) => left.openedAt.getTime() - right.openedAt.getTime(),
      );
      const primary = ordered[0];
      if (!primary) {
        continue;
      }

      const duplicates = ordered.slice(1);
      if (duplicates.length > 0) {
        await this.prisma.position.updateMany({
          where: {
            id: {
              in: duplicates.map((position) => position.id),
            },
          },
          data: {
            status: 'closed',
            closedAt: now,
          },
        });
      }

      const ledger = ledgers.get(key);
      if (!ledger || Math.abs(ledger.signedQty) <= 1e-12) {
        await this.prisma.position.update({
          where: { id: primary.id },
          data: {
            status: 'closed',
            closedAt: now,
            unrealizedPnl: 0,
          },
        });
        handledKeys.add(key);
        continue;
      }

      const ledgerQuantity = Math.abs(ledger.signedQty);
      const ledgerUnrealized = this.computeUnrealizedPnl(ledger);
      const ledgerSide = ledger.signedQty >= 0 ? 'BUY' : 'SELL';

      await this.prisma.position.update({
        where: { id: primary.id },
        data: {
          tokenId: ledger.tokenId,
          side: ledgerSide,
          entryPrice: ledger.avgEntryPrice,
          quantity: ledgerQuantity,
          unrealizedPnl: ledgerUnrealized,
          closedAt: null,
          status: 'open',
          ...(ledger.outcome !== 'UNKNOWN' ? { outcome: ledger.outcome } : {}),
        } as any,
      });

      handledKeys.add(key);
    }

    for (const [key, ledger] of ledgers.entries()) {
      if (handledKeys.has(key) || Math.abs(ledger.signedQty) <= 1e-12) {
        continue;
      }

      const side = ledger.signedQty >= 0 ? 'BUY' : 'SELL';
      const quantity = Math.abs(ledger.signedQty);

      await this.prisma.position.create({
        data: {
          id: randomUUID(),
          marketId: ledger.marketId,
          tokenId: ledger.tokenId,
          side,
          entryPrice: ledger.avgEntryPrice,
          quantity,
          status: 'open',
          openedAt: now,
          unrealizedPnl: this.computeUnrealizedPnl(ledger),
          ...(ledger.outcome !== 'UNKNOWN' ? { outcome: ledger.outcome } : {}),
        } as any,
      });
    }

    for (const position of existingOpenPositions) {
      const tokenId = this.readStringField(position, 'tokenId');
      if (!tokenId) {
        continue;
      }

      const key = this.ledgerKey(position.marketId, tokenId);
      if (existingByLedgerKey.has(key)) {
        continue;
      }

      await this.prisma.position.update({
        where: { id: position.id },
        data: {
          status: 'closed',
          closedAt: now,
          unrealizedPnl: 0,
        },
      });
    }
  }

  private computeUnrealizedPnl(ledger: LedgerState): number {
    const quantity = Math.abs(ledger.signedQty);
    if (quantity <= 1e-12) {
      return 0;
    }

    const side = ledger.signedQty >= 0 ? 'BUY' : 'SELL';
    const estimatedExitFee = Math.max(0, ledger.markPrice * quantity * 0.002);
    return this.feeAccounting.computeMarkToMarket({
      side,
      entryPrice: ledger.avgEntryPrice,
      markPrice: ledger.markPrice,
      quantity,
      estimatedExitFee,
      rewards: 0,
      includeRewardsInAlpha: false,
    }).netAlphaPnl;
  }

  private computeConsecutiveLosses(events: RealizedEvent[]): number {
    let losses = 0;
    const ordered = [...events].sort(
      (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime(),
    );

    for (const event of ordered) {
      if (event.pnl < 0) {
        losses += 1;
      } else if (event.pnl > 0) {
        break;
      }
    }

    return losses;
  }

  private ledgerKey(marketId: string, tokenId: string): string {
    return `${marketId}::${tokenId}`;
  }

  private resolveOutcomeForToken(
    market: unknown,
    tokenId: string,
  ): 'YES' | 'NO' | 'UNKNOWN' {
    const tokenIdYes = this.readStringField(market, 'tokenIdYes');
    const tokenIdNo = this.readStringField(market, 'tokenIdNo');

    if (tokenIdYes && tokenId === tokenIdYes) {
      return 'YES';
    }
    if (tokenIdNo && tokenId === tokenIdNo) {
      return 'NO';
    }
    return 'UNKNOWN';
  }

  private resolveMarkPrice(input: {
    market: unknown;
    marketId: string;
    tokenId: string;
    fallbackPrice: number;
    latestSnapshotByMarket: Map<string, any>;
    latestOrderbookByLedgerKey: Map<string, any>;
  }): number {
    const ledgerKey = this.ledgerKey(input.marketId, input.tokenId);
    const orderbook = input.latestOrderbookByLedgerKey.get(ledgerKey);
    if (orderbook) {
      const bestBid =
        Number.isFinite(orderbook.bestBid) && orderbook.bestBid > 0
          ? orderbook.bestBid
          : null;
      const bestAsk =
        Number.isFinite(orderbook.bestAsk) && orderbook.bestAsk > 0
          ? orderbook.bestAsk
          : null;

      if (bestBid != null && bestAsk != null) {
        return (bestBid + bestAsk) / 2;
      }
      if (bestAsk != null) {
        return bestAsk;
      }
      if (bestBid != null) {
        return bestBid;
      }
    }

    const snapshot = input.latestSnapshotByMarket.get(input.marketId);
    if (snapshot && Number.isFinite(snapshot.marketPrice) && snapshot.marketPrice > 0) {
      const outcome = this.resolveOutcomeForToken(input.market, input.tokenId);
      if (outcome === 'YES') {
        return snapshot.marketPrice;
      }
      if (outcome === 'NO') {
        return 1 - snapshot.marketPrice;
      }
    }

    return input.fallbackPrice;
  }

  private readStringField(source: unknown, key: string): string | null {
    if (!source || typeof source !== 'object') {
      return null;
    }

    const value = (source as Record<string, unknown>)[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }
}
