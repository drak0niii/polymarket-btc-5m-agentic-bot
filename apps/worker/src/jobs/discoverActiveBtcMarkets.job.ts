import { PrismaClient } from '@prisma/client';
import { AppLogger } from '@worker/common/logger';
import { appEnv } from '@worker/config/env';
import { BtcFiveMinuteTradeableUniverse } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { MarketEligibilityService } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import {
  GammaClient,
  MarketDiscovery,
} from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';

export class DiscoverActiveBtcMarketsJob {
  private readonly logger = new AppLogger('DiscoverActiveBtcMarketsJob');
  private readonly universe = new BtcFiveMinuteTradeableUniverse();
  private readonly marketEligibility = new MarketEligibilityService();
  private readonly marketDiscovery = new MarketDiscovery(
    new GammaClient(appEnv.POLY_GAMMA_HOST),
  );

  constructor(private readonly prisma: PrismaClient) {}

  async run(): Promise<{ discovered: number }> {
    const { markets, failures } = await this.marketDiscovery.discoverActiveBtcMarketsDetailed();
    if (failures.length > 0) {
      await this.prisma.auditEvent.create({
        data: {
          eventType: 'venue.parser_failure.gamma_discovery',
          message: 'Gamma discovery returned malformed market payloads; invalid markets were excluded.',
          metadata: {
            failures,
          } as object,
        },
      });
    }
    const activeIds: string[] = [];
    const duplicateKeys = new Set<string>();
    let discovered = 0;

    for (const market of markets) {
      const mapped = this.admitDiscoveredMarket(market, duplicateKeys);
      if (!mapped) {
        continue;
      }

      await this.prisma.market.upsert({
        where: { id: mapped.id },
        update: {
          slug: mapped.slug,
          title: mapped.title,
          status: mapped.status,
          tokenIdYes: mapped.tokenIdYes,
          tokenIdNo: mapped.tokenIdNo,
          resolutionSource: mapped.resolutionSource,
          expiresAt: mapped.expiresAt,
        },
        create: {
          id: mapped.id,
          slug: mapped.slug,
          title: mapped.title,
          status: mapped.status,
          tokenIdYes: mapped.tokenIdYes,
          tokenIdNo: mapped.tokenIdNo,
          resolutionSource: mapped.resolutionSource,
          expiresAt: mapped.expiresAt,
        },
      });

      activeIds.push(mapped.id);
      discovered += 1;
    }

    if (activeIds.length > 0) {
      await this.prisma.market.updateMany({
        where: {
          status: 'active',
          id: {
            notIn: activeIds,
          },
        },
        data: {
          status: 'inactive',
        },
      });
    }

    this.logger.log('Discovered active BTC 5m markets.', {
      discovered,
    });

    return { discovered };
  }

  private admitDiscoveredMarket(
    market: {
      id: string;
      slug: string;
      title: string;
      active: boolean;
      closed: boolean;
      tradable: boolean;
      enableOrderBook: boolean;
      negativeRisk: boolean | null;
      tokenIdYes: string | null;
      tokenIdNo: string | null;
      expiresAt: string | null;
      resolutionSource: string | null;
    },
    duplicateKeys: Set<string>,
  ): {
    id: string;
    slug: string;
    title: string;
    status: string;
    tokenIdYes: string | null;
    tokenIdNo: string | null;
    resolutionSource: string | null;
    expiresAt: Date | null;
  } | null {
    const expiresAt =
      typeof market.expiresAt === 'string' ? new Date(market.expiresAt) : null;
    const validExpiry = expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null;

    const universeDecision = this.universe.assessDiscovery(
      {
        id: market.id,
        slug: market.slug,
        title: market.title,
        question: market.title,
        description: '',
        category: '',
        active: market.active,
        closed: market.closed,
        tradable: market.tradable,
        tokenIdYes: market.tokenIdYes,
        tokenIdNo: market.tokenIdNo,
        durationSeconds: null,
        expiresAt: validExpiry,
        negativeRisk: market.negativeRisk ?? false,
      },
      {
        noTradeWindowSeconds: appEnv.NO_TRADE_WINDOW_SECONDS,
        duplicateKeys,
      },
    );

    if (!universeDecision.admitted || !market.tokenIdYes || !market.tokenIdNo) {
      return null;
    }

    const eligibility = this.marketEligibility.evaluate({
      market: {
        id: market.id,
        slug: market.slug,
        title: market.title,
        question: market.title,
        active: market.active,
        closed: market.closed,
        tradable: market.tradable,
        tokenIdYes: market.tokenIdYes,
        tokenIdNo: market.tokenIdNo,
        durationSeconds: null,
        expiresAt: validExpiry,
        negativeRisk: market.negativeRisk,
        enableOrderBook: market.enableOrderBook,
        abnormalTransition: false,
      },
      spread: 0.01,
      bidDepth: 100,
      askDepth: 100,
      topLevelDepth: 50,
      tickSize: 0.01,
      orderbookObservedAt: new Date().toISOString(),
      marketObservedAt: new Date().toISOString(),
      recentTradeCount: 1,
      maxOrderbookAgeMs: appEnv.BOT_MAX_ORDERBOOK_AGE_MS,
      maxMarketAgeMs: appEnv.BOT_MAX_MARKET_SNAPSHOT_AGE_MS,
      noTradeWindowSeconds: appEnv.NO_TRADE_WINDOW_SECONDS,
    });
    if (!eligibility.eligible) {
      return null;
    }

    if (universeDecision.candidateKey) {
      duplicateKeys.add(universeDecision.candidateKey);
    }

    return {
      id: market.id,
      slug: market.slug,
      title: market.title,
      status: 'active',
      tokenIdYes: market.tokenIdYes,
      tokenIdNo: market.tokenIdNo,
      resolutionSource: market.resolutionSource,
      expiresAt: validExpiry,
    };
  }

  private async fetchGammaMarkets(): Promise<Record<string, unknown>[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 8_000);

    try {
      const response = await fetch(`${appEnv.POLY_GAMMA_HOST}/markets`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Gamma markets request failed: ${response.status}`);
      }

      const payload = await response.json();
      if (!Array.isArray(payload)) {
        return [];
      }

      return payload.filter((entry) => typeof entry === 'object' && entry !== null) as Record<
        string,
        unknown
      >[];
    } finally {
      clearTimeout(timeout);
    }
  }

  private mapBtcFiveMinuteMarket(
    market: Record<string, unknown>,
    duplicateKeys: Set<string>,
  ): {
    id: string;
    slug: string;
    title: string;
    status: string;
    tokenIdYes: string | null;
    tokenIdNo: string | null;
    resolutionSource: string | null;
    expiresAt: Date | null;
  } | null {
    const id = String(market.id ?? '').trim();
    if (!id) {
      return null;
    }

    const slug = String(market.slug ?? '').trim();
    const title = String(
      market.question ?? market.title ?? market.name ?? (slug || id),
    ).trim();
    const durationSeconds = this.extractDurationSeconds(market);
    const expiresAt = this.extractExpiry(market);
    const { tokenIdYes, tokenIdNo } = this.extractTokenIds(market);

    const universeDecision = this.universe.assessDiscovery(
      {
        id,
        slug,
        title,
        question: title,
        description: String(market.description ?? ''),
        category: String(market.category ?? ''),
        active: market.active !== false,
        closed: market.closed === true,
        tradable: this.isTradableNow(market),
        tokenIdYes,
        tokenIdNo,
        durationSeconds,
        expiresAt,
        negativeRisk: this.parseBoolean(market.negRisk ?? market.negativeRisk) ?? false,
      },
      {
        noTradeWindowSeconds: appEnv.NO_TRADE_WINDOW_SECONDS,
        duplicateKeys,
      },
    );

    if (!universeDecision.admitted || !tokenIdYes || !tokenIdNo) {
      return null;
    }

    const eligibility = this.marketEligibility.evaluate({
      market: {
        id,
        slug,
        title,
        question: title,
        active: market.active !== false,
        closed: market.closed === true,
        tradable: this.isTradableNow(market),
        tokenIdYes,
        tokenIdNo,
        durationSeconds,
        expiresAt,
        negativeRisk: this.parseBoolean(market.negRisk ?? market.negativeRisk) ?? false,
        enableOrderBook:
          this.parseBoolean(
            market.enableOrderBook ?? market.enable_order_book ?? market.orderBookEnabled,
          ) ?? true,
        abnormalTransition:
          this.parseBoolean(
            market.suspended ?? market.abnormalTransition ?? market.transitioning,
          ) ?? false,
      },
      spread: 0.01,
      bidDepth: 100,
      askDepth: 100,
      topLevelDepth: 50,
      tickSize: 0.01,
      orderbookObservedAt: new Date().toISOString(),
      marketObservedAt: new Date().toISOString(),
      recentTradeCount: 1,
      maxOrderbookAgeMs: appEnv.BOT_MAX_ORDERBOOK_AGE_MS,
      maxMarketAgeMs: appEnv.BOT_MAX_MARKET_SNAPSHOT_AGE_MS,
      noTradeWindowSeconds: appEnv.NO_TRADE_WINDOW_SECONDS,
    });
    if (!eligibility.eligible) {
      return null;
    }

    if (universeDecision.candidateKey) {
      duplicateKeys.add(universeDecision.candidateKey);
    }

    return {
      id,
      slug,
      title: title.length > 0 ? title : id,
      status: 'active',
      tokenIdYes,
      tokenIdNo,
      resolutionSource:
        typeof market.endDate === 'string' ||
        typeof market.end_date_iso === 'string' ||
        typeof market.endDateIso === 'string' ||
        typeof market.end_date === 'string'
          ? 'configured'
          : null,
      expiresAt,
    };
  }

  private extractExpiry(market: Record<string, unknown>): Date | null {
    const raw =
      market.endDate ??
      market.end_date_iso ??
      market.endDateIso ??
      market.end_date;
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      return null;
    }

    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
      return null;
    }

    return date;
  }

  private extractTokenIds(market: Record<string, unknown>): {
    tokenIdYes: string | null;
    tokenIdNo: string | null;
  } {
    let tokenIdYes: string | null = null;
    let tokenIdNo: string | null = null;

    const tokens = Array.isArray(market.tokens) ? market.tokens : [];
    for (const token of tokens) {
      if (typeof token !== 'object' || token === null) {
        continue;
      }

      const record = token as Record<string, unknown>;
      const outcome = String(
        record.outcome ?? record.name ?? record.label ?? '',
      ).toLowerCase();
      const tokenId = String(
        record.token_id ?? record.tokenId ?? record.id ?? '',
      ).trim();
      if (!tokenId) {
        continue;
      }

      if (outcome.includes('yes') && !tokenIdYes) {
        tokenIdYes = tokenId;
      } else if (outcome.includes('no') && !tokenIdNo) {
        tokenIdNo = tokenId;
      }
    }

    if (!tokenIdYes || !tokenIdNo) {
      const clobTokenIds = Array.isArray(market.clobTokenIds)
        ? market.clobTokenIds
        : Array.isArray(market.clob_token_ids)
          ? market.clob_token_ids
          : [];

      const normalized = clobTokenIds
        .map((value) => String(value ?? '').trim())
        .filter((value) => value.length > 0);

      if (!tokenIdYes && normalized[0]) {
        tokenIdYes = normalized[0];
      }

      if (!tokenIdNo && normalized[1]) {
        tokenIdNo = normalized[1];
      }
    }

    return {
      tokenIdYes,
      tokenIdNo,
    };
  }

  private extractDurationSeconds(market: Record<string, unknown>): number | null {
    const numericCandidates: Array<{ value: unknown; multiplier: number }> = [
      { value: market.durationSeconds, multiplier: 1 },
      { value: market.duration_secs, multiplier: 1 },
      { value: market.windowSeconds, multiplier: 1 },
      { value: market.window_seconds, multiplier: 1 },
      { value: market.intervalSeconds, multiplier: 1 },
      { value: market.interval_seconds, multiplier: 1 },
      { value: market.resolutionSeconds, multiplier: 1 },
      { value: market.resolution_seconds, multiplier: 1 },
      { value: market.durationMinutes, multiplier: 60 },
      { value: market.duration_minutes, multiplier: 60 },
      { value: market.intervalMinutes, multiplier: 60 },
      { value: market.interval_minutes, multiplier: 60 },
    ];

    for (const candidate of numericCandidates) {
      const value = Number(candidate.value);
      if (!Number.isFinite(value) || value <= 0) {
        continue;
      }

      return Math.floor(value * candidate.multiplier);
    }

    const stringCandidates = [
      market.duration,
      market.window,
      market.interval,
      market.resolution,
      market.timeframe,
    ];

    for (const candidate of stringCandidates) {
      if (typeof candidate !== 'string') {
        continue;
      }

      const normalized = candidate.trim().toLowerCase();
      if (!normalized) {
        continue;
      }

      const match = normalized.match(
        /^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/,
      );
      if (!match) {
        if (normalized === '5m' || normalized === '5min' || normalized === 'five minute') {
          return 300;
        }
        continue;
      }

      const quantity = Number(match[1]);
      const unit = match[2];
      if (!Number.isFinite(quantity) || quantity <= 0) {
        continue;
      }

      if (unit.startsWith('s')) {
        return Math.floor(quantity);
      }
      if (unit.startsWith('m')) {
        return Math.floor(quantity * 60);
      }
      return Math.floor(quantity * 3600);
    }

    return null;
  }

  private parseBoolean(value: unknown): boolean | null {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      if (value === 1) {
        return true;
      }
      if (value === 0) {
        return false;
      }
      return null;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['1', 'true', 'yes', 'y'].includes(normalized)) {
        return true;
      }
      if (['0', 'false', 'no', 'n'].includes(normalized)) {
        return false;
      }
    }
    return null;
  }

  private isTradableNow(market: Record<string, unknown>): boolean {
    const blockingFlags = [
      market.acceptingOrders,
      market.accepting_orders,
      market.enableOrderBook,
      market.enable_order_book,
      market.orderbookEnabled,
      market.orderbook_enabled,
      market.tradable,
      market.isTradable,
      market.trading,
      market.canTrade,
      market.isSuspended,
      market.suspended,
      market.archived,
      market.isArchived,
    ];

    for (const flag of blockingFlags) {
      const parsed = this.parseBoolean(flag);
      if (parsed === false) {
        return false;
      }
    }

    return true;
  }

  private isValidTradingWindow(expiresAt: Date | null): boolean {
    return expiresAt !== null;
  }
}
