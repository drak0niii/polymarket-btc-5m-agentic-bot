import { PrismaClient } from '@prisma/client';
import { AppLogger } from '@worker/common/logger';
import { appEnv } from '@worker/config/env';
import { BotRuntimeState } from '@worker/runtime/bot-state';
import { permissionsForRuntimeState } from '@worker/runtime/runtime-state-machine';
import {
  isVenueParseError,
  parseOrderbookPayload,
} from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';

interface OrderbookLevel {
  price: number;
  size: number;
}

interface FetchedOrderbook {
  bidLevels: OrderbookLevel[];
  askLevels: OrderbookLevel[];
  tickSize: number | null;
  minOrderSize: number | null;
  negRisk: boolean | null;
}

export class SyncOrderbooksJob {
  private readonly logger = new AppLogger('SyncOrderbooksJob');

  constructor(private readonly prisma: PrismaClient) {}

  async run(options?: { runtimeState?: BotRuntimeState }): Promise<{
    synced: number;
    degradedMarkets: number;
    degradedTokens: number;
  }> {
    if (
      options?.runtimeState &&
      !permissionsForRuntimeState(options.runtimeState).allowMarketDataReads
    ) {
      return {
        synced: 0,
        degradedMarkets: 0,
        degradedTokens: 0,
      };
    }

    const now = new Date();
    const markets = await this.prisma.market.findMany({
      where: {
        status: 'active',
        expiresAt: {
          gt: now,
        },
      },
      orderBy: {
        updatedAt: 'desc',
      },
      take: 100,
    });

    let synced = 0;
    let degradedMarkets = 0;
    let degradedTokens = 0;

    for (const market of markets) {
      const tokenIds = [market.tokenIdYes, market.tokenIdNo].filter(
        (tokenId): tokenId is string => Boolean(tokenId),
      );
      if (tokenIds.length === 0) {
        continue;
      }

      let representative: {
        bestBid: number | null;
        bestAsk: number | null;
        spread: number | null;
        observedAt: Date;
      } | null = null;

      let marketDegraded = false;

      for (const tokenId of tokenIds) {
        let book: FetchedOrderbook | null = null;
        try {
          book = await this.fetchOrderbook(tokenId);
        } catch (error) {
          if (isVenueParseError(error)) {
            degradedTokens += 1;
            marketDegraded = true;
            await this.prisma.auditEvent.create({
              data: {
                marketId: market.id,
                eventType: 'venue.parser_failure.orderbook',
                message: 'Orderbook payload was malformed and the token was marked degraded.',
                metadata: {
                  tokenId,
                  operation: error.operation,
                  issues: error.issues,
                } as object,
              },
            });
            continue;
          }
          throw error;
        }
        if (!book) {
          continue;
        }

        const bestBid = book.bidLevels[0]?.price ?? null;
        const bestAsk = book.askLevels[0]?.price ?? null;
        const spread =
          bestBid !== null && bestAsk !== null ? Math.max(0, bestAsk - bestBid) : null;

        const depthScore =
          book.bidLevels.slice(0, 5).reduce((sum, level) => sum + level.size, 0) +
          book.askLevels.slice(0, 5).reduce((sum, level) => sum + level.size, 0);

        const observedAt = new Date();

        const metadataMissing =
          book.tickSize === null || book.minOrderSize === null || book.negRisk === null;

        if (metadataMissing) {
          degradedTokens += 1;
          marketDegraded = true;

          this.logger.warn('Orderbook metadata missing for token; token marked degraded.', {
            marketId: market.id,
            tokenId,
            tickSize: book.tickSize,
            minOrderSize: book.minOrderSize,
            negRisk: book.negRisk,
          });
        }

        await this.prisma.orderbook.create({
          data: {
            marketId: market.id,
            tokenId,
            bidLevels: book.bidLevels as unknown as object,
            askLevels: book.askLevels as unknown as object,
            bestBid,
            bestAsk,
            spread,
            depthScore,
            tickSize: book.tickSize,
            minOrderSize: book.minOrderSize,
            negRisk: book.negRisk,
            observedAt,
          } as never,
        });

        if (!representative || tokenId === market.tokenIdYes) {
          representative = {
            bestBid,
            bestAsk,
            spread,
            observedAt,
          };
        }
      }

      if (!representative) {
        continue;
      }

      const marketPrice =
        representative.bestBid !== null && representative.bestAsk !== null
          ? (representative.bestBid + representative.bestAsk) / 2
          : null;

      await this.prisma.marketSnapshot.create({
        data: {
          marketId: market.id,
          marketPrice,
          bestBid: representative.bestBid,
          bestAsk: representative.bestAsk,
          spread: representative.spread,
          volume: null,
          expiresAt: market.expiresAt,
          observedAt: representative.observedAt,
        },
      });

      if (marketDegraded) {
        degradedMarkets += 1;
      }

      synced += 1;
    }

    this.logger.debug('Orderbooks synchronized.', {
      synced,
      degradedMarkets,
      degradedTokens,
    });

    return {
      synced,
      degradedMarkets,
      degradedTokens,
    };
  }

  private async fetchOrderbook(tokenId: string): Promise<FetchedOrderbook | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 6_000);

    try {
      const response = await fetch(
        `${appEnv.POLY_CLOB_HOST}/book?token_id=${encodeURIComponent(tokenId)}`,
        {
          headers: {
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        return null;
      }

      const parsed = parseOrderbookPayload(
        tokenId,
        await response.json(),
        'sync_orderbooks_orderbook',
      );
      return {
        bidLevels: parsed.bidLevels,
        askLevels: parsed.askLevels,
        tickSize: parsed.tickSize,
        minOrderSize: parsed.minOrderSize,
        negRisk: parsed.negRisk,
      };
    } catch (error) {
      if (isVenueParseError(error)) {
        throw error;
      }
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseLevels(raw: unknown, side: 'bid' | 'ask'): OrderbookLevel[] {
    if (!Array.isArray(raw)) {
      return [];
    }

    return raw
      .map((entry) => {
        if (Array.isArray(entry) && entry.length >= 2) {
          const price = Number(entry[0]);
          const size = Number(entry[1]);
          if (
            Number.isFinite(price) &&
            Number.isFinite(size) &&
            size > 0 &&
            price >= 0 &&
            price <= 1
          ) {
            return { price, size };
          }
        }

        if (typeof entry === 'object' && entry !== null) {
          const record = entry as Record<string, unknown>;
          const price = Number(record.price ?? record.p ?? Number.NaN);
          const size = Number(record.size ?? record.s ?? Number.NaN);
          if (
            Number.isFinite(price) &&
            Number.isFinite(size) &&
            size > 0 &&
            price >= 0 &&
            price <= 1
          ) {
            return { price, size };
          }
        }

        return null;
      })
      .filter((level): level is OrderbookLevel => level !== null)
      .sort((a, b) => (side === 'bid' ? b.price - a.price : a.price - b.price));
  }

  private parseNullablePositiveNumber(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  private parseNullableBoolean(value: unknown): boolean | null {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') {
        return true;
      }
      if (normalized === 'false') {
        return false;
      }
    }

    return null;
  }
}
