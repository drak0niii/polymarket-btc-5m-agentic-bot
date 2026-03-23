import { PrismaClient } from '@prisma/client';
import { appEnv } from '@worker/config/env';
import {
  BalanceAllowanceSnapshot,
  DataApiPositionRecord,
  DataApiUserTradeRecord,
  OfficialPolymarketTradingClient,
  VenueOpenOrder,
  VenueTradeRecord,
} from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';
import { ExternalPortfolioFundingSnapshot } from '@polymarket-btc-5m-agentic-bot/risk-engine';

type Outcome = 'YES' | 'NO' | 'UNKNOWN';
type FreshnessVerdict = 'healthy' | 'warning' | 'degraded' | 'stale';
type ConfidenceLevel = 'high' | 'medium' | 'low' | 'none';
type DivergenceStatus = 'none' | 'recoverable' | 'blocking';
type RecoveryMode = 'none' | 'rebuild_local_positions' | 'recovery_only' | 'manual_review';

interface TokenDescriptor {
  tokenId: string;
  marketId: string | null;
  outcome: Outcome;
}

export interface ExternalPortfolioInventorySnapshot {
  tokenId: string;
  marketId: string | null;
  outcome: Outcome;
  balance: number;
  allowance: number;
  reservedQuantity: number;
  freeQuantityBeforeAllowance: number;
  freeQuantityAfterAllowance: number;
  tradableSellHeadroom: number;
  availableQuantity: number;
  positionQuantity: number;
  markPrice: number | null;
  markedValue: number;
}

export interface ExternalPortfolioPositionSnapshot extends DataApiPositionRecord {
  marketId: string | null;
  outcome: string | null;
}

export interface ExternalPortfolioFreshnessComponent {
  component:
    | 'balances'
    | 'allowances'
    | 'openOrders'
    | 'clobTrades'
    | 'dataApiTrades'
    | 'currentPositions'
    | 'closedPositions';
  fetchedAt: string;
  sourceTimestamp: string | null;
  ageMs: number;
  verdict: FreshnessVerdict;
  confidence: ConfidenceLevel;
  maxHealthyAgeMs: number;
  maxWarningAgeMs: number;
  maxDegradedAgeMs: number;
}

export interface ExternalPortfolioCashState {
  grossBalance: number;
  grossAllowance: number;
  reservedForBuys: number;
  freeCashBeforeAllowance: number;
  freeCashAfterAllowance: number;
  tradableBuyHeadroom: number;
}

export interface ExternalPortfolioFreshnessState {
  overallVerdict: FreshnessVerdict;
  confidence: ConfidenceLevel;
  allowNewEntries: boolean;
  allowPositionManagement: boolean;
  components: {
    balances: ExternalPortfolioFreshnessComponent;
    allowances: ExternalPortfolioFreshnessComponent;
    openOrders: ExternalPortfolioFreshnessComponent;
    clobTrades: ExternalPortfolioFreshnessComponent;
    dataApiTrades: ExternalPortfolioFreshnessComponent;
    currentPositions: ExternalPortfolioFreshnessComponent;
    closedPositions: ExternalPortfolioFreshnessComponent;
  };
}

export interface ExternalPortfolioDivergenceDetail {
  code: string;
  tokenId: string | null;
  marketId: string | null;
  localValue: number | string | null;
  externalValue: number | string | null;
  message: string;
}

export interface ExternalPortfolioDivergenceState {
  status: DivergenceStatus;
  classes: string[];
  details: ExternalPortfolioDivergenceDetail[];
}

export interface ExternalPortfolioRecoveryState {
  mode: RecoveryMode;
  entriesBlocked: boolean;
  positionManagementBlocked: boolean;
  reasonCodes: string[];
}

export interface ExternalPortfolioSnapshot extends ExternalPortfolioFundingSnapshot {
  source: 'polymarket_authenticated_external_truth';
  snapshotId: string | null;
  bankroll: number;
  openExposure: number;
  openOrderExposure: number;
  realizedFees: number | null;
  workingOpenOrders: number;
  cash: ExternalPortfolioCashState;
  positions: {
    current: ExternalPortfolioPositionSnapshot[];
    closed: ExternalPortfolioPositionSnapshot[];
    totalCurrentValue: number;
    realizedPnlFromClosedPositions: number | null;
  };
  trades: {
    authenticated: VenueTradeRecord[];
    dataApi: DataApiUserTradeRecord[];
  };
  openOrders: VenueOpenOrder[];
  freshness: ExternalPortfolioFreshnessState;
  divergence: ExternalPortfolioDivergenceState;
  recovery: ExternalPortfolioRecoveryState;
  inventories: ExternalPortfolioInventorySnapshot[];
}

export class ExternalPortfolioService {
  private readonly tradingClient: OfficialPolymarketTradingClient;

  constructor(
    private readonly prisma: PrismaClient,
    tradingClient?: OfficialPolymarketTradingClient,
  ) {
    this.tradingClient =
      tradingClient ??
      new OfficialPolymarketTradingClient({
        host: appEnv.POLY_CLOB_HOST,
        dataApiHost: appEnv.POLY_DATA_API_HOST,
        chainId: appEnv.POLY_CHAIN_ID,
        privateKey: appEnv.POLY_PRIVATE_KEY ?? '',
        apiKey: appEnv.POLY_API_KEY ?? '',
        apiSecret: appEnv.POLY_API_SECRET ?? '',
        apiPassphrase: appEnv.POLY_API_PASSPHRASE ?? '',
        signatureType: appEnv.POLY_SIGNATURE_TYPE,
        funder: appEnv.POLY_FUNDER ?? null,
        profileAddress: appEnv.POLY_PROFILE_ADDRESS ?? null,
        geoBlockToken: appEnv.POLY_GEO_BLOCK_TOKEN ?? null,
        useServerTime: appEnv.POLY_USE_SERVER_TIME,
        maxClockSkewMs: appEnv.POLY_MAX_CLOCK_SKEW_MS,
      });
  }

  async capture(options?: {
    persist?: boolean;
    source?: string;
    cycleKey?: string;
  }): Promise<ExternalPortfolioSnapshot> {
    const cycleKey = options?.cycleKey ?? `external-portfolio:${Date.now()}`;
    const source = options?.source ?? 'external_portfolio_reconcile';

    try {
      const [
        markets,
        latestSnapshots,
        latestOrderbooks,
        localOpenPositions,
        localOpenOrders,
        localRecentFills,
      ] = await Promise.all([
        this.prisma.market.findMany(),
        this.prisma.marketSnapshot.findMany({
          orderBy: { observedAt: 'desc' },
        }),
        this.prisma.orderbook.findMany({
          orderBy: { observedAt: 'desc' },
        }),
        this.prisma.position.findMany({
          where: { status: 'open' },
          orderBy: { updatedAt: 'desc' },
        }),
        this.prisma.order.findMany({
          where: {
            status: {
              in: ['submitted', 'acknowledged', 'partially_filled'],
            },
          },
          orderBy: { updatedAt: 'desc' },
        }),
        this.prisma.fill.findMany({
          orderBy: { filledAt: 'desc' },
          take: 200,
        }),
      ]);

      const marketById = new Map(markets.map((market) => [market.id, market]));
      const latestSnapshotByMarket = new Map<string, (typeof latestSnapshots)[number]>();
      for (const snapshot of latestSnapshots) {
        if (!latestSnapshotByMarket.has(snapshot.marketId)) {
          latestSnapshotByMarket.set(snapshot.marketId, snapshot);
        }
      }

      const latestOrderbookByToken = new Map<string, (typeof latestOrderbooks)[number]>();
      for (const orderbook of latestOrderbooks) {
        if (!orderbook.tokenId || latestOrderbookByToken.has(orderbook.tokenId)) {
          continue;
        }
        latestOrderbookByToken.set(orderbook.tokenId, orderbook);
      }

      const capturedAt = new Date().toISOString();
      const [
        collateral,
        openOrders,
        authenticatedTrades,
        dataApiTrades,
        currentPositionsRaw,
        closedPositionsRaw,
      ] = await Promise.all([
        this.tradingClient.getBalanceAllowance({
          assetType: 'COLLATERAL',
        }),
        this.tradingClient.getOpenOrders(),
        this.tradingClient.getTrades(),
        this.tradingClient.getUserTrades(),
        this.tradingClient.getCurrentPositions(),
        this.tradingClient.getClosedPositions(),
      ]);

      const descriptors = this.collectTrackedTokens({
        markets,
        tokenIds: [
          ...openOrders.map((order) => order.tokenId),
          ...authenticatedTrades.map((trade) => trade.tokenId),
          ...dataApiTrades.map((trade) => trade.tokenId),
          ...currentPositionsRaw.map((position) => position.tokenId),
          ...closedPositionsRaw.map((position) => position.tokenId),
        ],
        currentPositions: currentPositionsRaw,
        closedPositions: closedPositionsRaw,
      });

      const conditionalBalances = await Promise.all(
        descriptors.map(async (descriptor) => ({
          descriptor,
          snapshot: await this.tradingClient.getBalanceAllowance({
            assetType: 'CONDITIONAL',
            tokenId: descriptor.tokenId,
          }),
        })),
      );

      const descriptorByToken = new Map(
        descriptors.map((descriptor) => [descriptor.tokenId, descriptor]),
      );
      const currentPositions = currentPositionsRaw.map((position) =>
        this.decoratePosition(position, descriptorByToken),
      );
      const closedPositions = closedPositionsRaw.map((position) =>
        this.decoratePosition(position, descriptorByToken),
      );

      const reservedByToken = new Map<string, number>();
      let reservedCash = 0;
      let openOrderExposure = 0;
      for (const order of openOrders) {
        const remaining = this.remainingQuantity(order);
        if (remaining <= 0) {
          continue;
        }

        openOrderExposure += order.price * remaining;
        if (order.side.toUpperCase() === 'BUY') {
          reservedCash += order.price * remaining;
          continue;
        }

        reservedByToken.set(
          order.tokenId,
          (reservedByToken.get(order.tokenId) ?? 0) + remaining,
        );
      }

      const currentPositionByToken = this.aggregatePositionsByToken(currentPositions);
      const inventories: ExternalPortfolioInventorySnapshot[] = conditionalBalances.map(
        ({ descriptor, snapshot }) => {
          const reservedQuantity = reservedByToken.get(descriptor.tokenId) ?? 0;
          const position = currentPositionByToken.get(descriptor.tokenId) ?? null;
          const positionScopedQuantity = position?.size ?? snapshot.balance;
          const freeQuantityBeforeAllowance = Math.max(
            0,
            snapshot.balance - reservedQuantity,
          );
          const freeQuantityAfterAllowance = Math.max(
            0,
            Math.min(snapshot.balance, snapshot.allowance) - reservedQuantity,
          );
          const tradableSellHeadroom = Math.max(
            0,
            Math.min(snapshot.balance, snapshot.allowance, positionScopedQuantity) -
              reservedQuantity,
          );
          const markPrice =
            position?.currentPrice ??
            this.resolveMarkPrice({
              tokenId: descriptor.tokenId,
              marketId: descriptor.marketId,
              outcome: descriptor.outcome,
              marketById,
              latestOrderbookByToken,
              latestSnapshotByMarket,
            });
          const markedValue =
            position?.currentValue ??
            (markPrice != null && positionScopedQuantity > 0
              ? positionScopedQuantity * markPrice
              : 0);

          return {
            tokenId: descriptor.tokenId,
            marketId: descriptor.marketId,
            outcome: descriptor.outcome,
            balance: snapshot.balance,
            allowance: snapshot.allowance,
            reservedQuantity,
            freeQuantityBeforeAllowance,
            freeQuantityAfterAllowance,
            tradableSellHeadroom,
            availableQuantity: tradableSellHeadroom,
            positionQuantity: position?.size ?? 0,
            markPrice,
            markedValue,
          };
        },
      );

      const cash: ExternalPortfolioCashState = {
        grossBalance: collateral.balance,
        grossAllowance: collateral.allowance,
        reservedForBuys: reservedCash,
        freeCashBeforeAllowance: Math.max(0, collateral.balance - reservedCash),
        freeCashAfterAllowance: Math.max(
          0,
          Math.min(collateral.balance, collateral.allowance) - reservedCash,
        ),
        tradableBuyHeadroom: Math.max(
          0,
          Math.min(collateral.balance, collateral.allowance) - reservedCash,
        ),
      };

      const freshness = this.buildFreshnessState({
        capturedAt,
        collateral,
        openOrders,
        authenticatedTrades,
        dataApiTrades,
        currentPositions,
        closedPositions,
      });

      const normalizedLocalOpenPositions = localOpenPositions
        .map((position) => ({
          marketId: position.marketId,
          tokenId: this.readLocalStringField(position, 'tokenId'),
          quantity: position.quantity,
        }))
        .filter(
          (position): position is { marketId: string; tokenId: string; quantity: number } =>
            typeof position.tokenId === 'string' && position.tokenId.length > 0,
        );
      const normalizedLocalOpenOrders = localOpenOrders
        .map((order) => ({
          marketId: order.marketId,
          tokenId: order.tokenId,
          venueOrderId: order.venueOrderId,
          status: order.status,
        }))
        .filter(
          (order): order is {
            marketId: string;
            tokenId: string;
            venueOrderId: string | null;
            status: string;
          } => typeof order.tokenId === 'string' && order.tokenId.length > 0,
        );

      const divergence = this.detectDivergence({
        descriptorByToken,
        inventories,
        openOrders,
        currentPositions,
        dataApiTrades,
        localOpenPositions: normalizedLocalOpenPositions,
        localOpenOrders: normalizedLocalOpenOrders,
        localRecentFills,
      });

      const recovery = this.planRecovery(divergence);
      const openExposure =
        currentPositions.reduce(
          (sum, position) => sum + (position.currentValue ?? 0),
          0,
        ) || inventories.reduce((sum, inventory) => sum + inventory.markedValue, 0);

      const allowNewEntries = freshness.allowNewEntries && !recovery.entriesBlocked;
      const allowPositionManagement =
        freshness.allowPositionManagement && !recovery.positionManagementBlocked;
      const confidence = this.resolveConfidence({
        freshness,
        divergence,
        recovery,
      });
      const realizedFees = this.sumRealizedFees(authenticatedTrades);
      const realizedPnlFromClosedPositions = this.sumRealizedPnl(closedPositions);

      const snapshot: ExternalPortfolioSnapshot = {
        source: 'polymarket_authenticated_external_truth',
        snapshotId: null,
        capturedAt,
        freshnessState: allowNewEntries ? 'fresh' : 'stale',
        freshnessVerdict: freshness.overallVerdict,
        reconciliationHealth:
          allowNewEntries && divergence.status === 'none' ? 'healthy' : 'failed',
        tradingPermissions: {
          allowNewEntries,
          allowPositionManagement,
          reasonCodes: [
            ...recovery.reasonCodes,
            ...(allowNewEntries ? [] : ['external_portfolio_truth_entries_blocked']),
          ],
        },
        cashBalance: cash.grossBalance,
        cashAllowance: cash.grossAllowance,
        reservedCash: cash.reservedForBuys,
        freeCashBeforeAllowance: cash.freeCashBeforeAllowance,
        freeCashAfterAllowance: cash.freeCashAfterAllowance,
        tradableBuyHeadroom: cash.tradableBuyHeadroom,
        availableCapital: cash.tradableBuyHeadroom,
        inventories,
        bankroll: cash.grossBalance + openExposure,
        openExposure,
        openOrderExposure,
        realizedFees,
        workingOpenOrders: openOrders.filter((order) => this.remainingQuantity(order) > 0).length,
        cash,
        positions: {
          current: currentPositions,
          closed: closedPositions,
          totalCurrentValue: openExposure,
          realizedPnlFromClosedPositions,
        },
        trades: {
          authenticated: authenticatedTrades,
          dataApi: dataApiTrades,
        },
        openOrders,
        freshness: {
          ...freshness,
          confidence,
        },
        divergence,
        recovery,
      };

      if (options?.persist === false) {
        return snapshot;
      }

      return this.persistSnapshot(snapshot, {
        cycleKey,
        source,
      });
    } catch (error) {
      await this.recordCheckpoint({
        cycleKey,
        source,
        status: 'sync_failed',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  async loadLatestSnapshot(
    source = 'external_portfolio_reconcile',
  ): Promise<ExternalPortfolioSnapshot | null> {
    const prismaAny = this.prisma as any;
    const checkpoint = await prismaAny.reconciliationCheckpoint.findFirst({
      where: { source, status: 'completed' },
      orderBy: { processedAt: 'desc' },
    });

    const snapshot = checkpoint?.details?.snapshot;
    if (!snapshot || typeof snapshot !== 'object') {
      return null;
    }

    return this.refreshLoadedSnapshot(snapshot as ExternalPortfolioSnapshot);
  }

  isFresh(
    snapshot: ExternalPortfolioSnapshot | null,
    maxAgeMs = this.maxSnapshotAgeMs(),
  ): boolean {
    if (!snapshot) {
      return false;
    }

    const capturedAt = new Date(snapshot.capturedAt).getTime();
    if (!Number.isFinite(capturedAt)) {
      return false;
    }

    return Date.now() - capturedAt <= maxAgeMs;
  }

  private async persistSnapshot(
    snapshot: ExternalPortfolioSnapshot,
    input: {
      cycleKey: string;
      source: string;
    },
  ): Promise<ExternalPortfolioSnapshot> {
    const capturedAt = new Date(snapshot.capturedAt);
    const prismaAny = this.prisma as PrismaClient & {
      $transaction?: <T>(input: T[]) => Promise<T>;
    };

    let createdSnapshot:
      | {
          id: string;
        }
      | null = null;

    if (typeof prismaAny.$transaction === 'function') {
      const results = await prismaAny.$transaction([
        this.prisma.portfolioSnapshot.create({
          data: {
            bankroll: snapshot.bankroll,
            availableCapital: snapshot.availableCapital,
            openExposure: snapshot.openExposure,
            realizedPnlDay: 0,
            unrealizedPnl: 0,
            consecutiveLosses: 0,
            capturedAt,
          },
        }),
        this.prisma.reconciliationCheckpoint.create({
          data: {
            cycleKey: input.cycleKey,
            source: input.source,
            status: 'completed',
            details: {
              snapshot,
            } as object,
            processedAt: capturedAt,
          },
        }),
      ]);
      createdSnapshot = results[0] as { id: string };
    } else {
      createdSnapshot = await this.prisma.portfolioSnapshot.create({
        data: {
          bankroll: snapshot.bankroll,
          availableCapital: snapshot.availableCapital,
          openExposure: snapshot.openExposure,
          realizedPnlDay: 0,
          unrealizedPnl: 0,
          consecutiveLosses: 0,
          capturedAt,
        },
      });
      await this.prisma.reconciliationCheckpoint.create({
        data: {
          cycleKey: input.cycleKey,
          source: input.source,
          status: 'completed',
          details: {
            snapshot,
          } as object,
          processedAt: capturedAt,
        },
      });
    }

    return {
      ...snapshot,
      snapshotId: createdSnapshot.id,
    };
  }

  private async recordCheckpoint(input: {
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

  private collectTrackedTokens(input: {
    markets: Array<{
      id: string;
      tokenIdYes: string | null;
      tokenIdNo: string | null;
    }>;
    tokenIds: string[];
    currentPositions: DataApiPositionRecord[];
    closedPositions: DataApiPositionRecord[];
  }): TokenDescriptor[] {
    const descriptors = new Map<string, TokenDescriptor>();

    for (const market of input.markets) {
      if (market.tokenIdYes) {
        descriptors.set(market.tokenIdYes, {
          tokenId: market.tokenIdYes,
          marketId: market.id,
          outcome: 'YES',
        });
      }

      if (market.tokenIdNo) {
        descriptors.set(market.tokenIdNo, {
          tokenId: market.tokenIdNo,
          marketId: market.id,
          outcome: 'NO',
        });
      }
    }

    for (const tokenId of input.tokenIds) {
      if (!tokenId || descriptors.has(tokenId)) {
        continue;
      }

      const seededPosition =
        input.currentPositions.find((position) => position.tokenId === tokenId) ??
        input.closedPositions.find((position) => position.tokenId === tokenId) ??
        null;

      descriptors.set(tokenId, {
        tokenId,
        marketId: null,
        outcome: this.normalizeOutcome(seededPosition?.outcome),
      });
    }

    return [...descriptors.values()];
  }

  private decoratePosition(
    position: DataApiPositionRecord,
    descriptorByToken: Map<string, TokenDescriptor>,
  ): ExternalPortfolioPositionSnapshot {
    const descriptor = descriptorByToken.get(position.tokenId) ?? null;
    return {
      ...position,
      marketId: descriptor?.marketId ?? null,
      outcome:
        this.normalizeOutcome(position.outcome) !== 'UNKNOWN'
          ? this.normalizeOutcome(position.outcome)
          : descriptor?.outcome ?? null,
    };
  }

  private aggregatePositionsByToken(
    positions: ExternalPortfolioPositionSnapshot[],
  ): Map<string, ExternalPortfolioPositionSnapshot> {
    const aggregated = new Map<string, ExternalPortfolioPositionSnapshot>();

    for (const position of positions) {
      const existing = aggregated.get(position.tokenId);
      if (!existing) {
        aggregated.set(position.tokenId, position);
        continue;
      }

      aggregated.set(position.tokenId, {
        ...existing,
        size: existing.size + position.size,
        currentValue:
          (existing.currentValue ?? 0) + (position.currentValue ?? 0),
        realizedPnl:
          (existing.realizedPnl ?? 0) + (position.realizedPnl ?? 0),
        cashPnl: (existing.cashPnl ?? 0) + (position.cashPnl ?? 0),
      });
    }

    return aggregated;
  }

  private buildFreshnessState(input: {
    capturedAt: string;
    collateral: BalanceAllowanceSnapshot;
    openOrders: VenueOpenOrder[];
    authenticatedTrades: VenueTradeRecord[];
    dataApiTrades: DataApiUserTradeRecord[];
    currentPositions: ExternalPortfolioPositionSnapshot[];
    closedPositions: ExternalPortfolioPositionSnapshot[];
  }): ExternalPortfolioFreshnessState {
    const balances = this.assessFreshnessComponent({
      component: 'balances',
      fetchedAt: input.collateral.checkedAt,
      sourceTimestamp: null,
      healthyAgeMs: appEnv.BOT_MAX_EXTERNAL_BALANCE_AGE_MS,
    });
    const allowances = this.assessFreshnessComponent({
      component: 'allowances',
      fetchedAt: input.collateral.checkedAt,
      sourceTimestamp: null,
      healthyAgeMs: appEnv.BOT_MAX_EXTERNAL_ALLOWANCE_AGE_MS,
    });
    const openOrders = this.assessFreshnessComponent({
      component: 'openOrders',
      fetchedAt: input.capturedAt,
      sourceTimestamp: this.maxTimestamp(
        input.openOrders.map((order) => order.createdAt ?? null),
      ),
      healthyAgeMs: appEnv.BOT_MAX_EXTERNAL_OPEN_ORDERS_AGE_MS,
    });
    const clobTrades = this.assessFreshnessComponent({
      component: 'clobTrades',
      fetchedAt: input.capturedAt,
      sourceTimestamp: this.maxTimestamp(
        input.authenticatedTrades.map((trade) => trade.filledAt),
      ),
      healthyAgeMs: appEnv.BOT_MAX_EXTERNAL_CLOB_TRADES_AGE_MS,
    });
    const dataApiTrades = this.assessFreshnessComponent({
      component: 'dataApiTrades',
      fetchedAt: input.capturedAt,
      sourceTimestamp: this.maxTimestamp(
        input.dataApiTrades.map((trade) => trade.timestamp),
      ),
      healthyAgeMs: appEnv.BOT_MAX_EXTERNAL_DATA_TRADES_AGE_MS,
    });
    const currentPositions = this.assessFreshnessComponent({
      component: 'currentPositions',
      fetchedAt: input.capturedAt,
      sourceTimestamp: null,
      healthyAgeMs: appEnv.BOT_MAX_EXTERNAL_POSITIONS_AGE_MS,
    });
    const closedPositions = this.assessFreshnessComponent({
      component: 'closedPositions',
      fetchedAt: input.capturedAt,
      sourceTimestamp: null,
      healthyAgeMs: appEnv.BOT_MAX_EXTERNAL_CLOSED_POSITIONS_AGE_MS,
    });

    const requiredForEntries = [
      balances,
      allowances,
      openOrders,
      clobTrades,
      dataApiTrades,
      currentPositions,
    ];
    const requiredForManagement = [openOrders, clobTrades, currentPositions];

    return {
      overallVerdict: this.maxVerdict([
        balances.verdict,
        allowances.verdict,
        openOrders.verdict,
        clobTrades.verdict,
        dataApiTrades.verdict,
        currentPositions.verdict,
        closedPositions.verdict,
      ]),
      confidence: 'high',
      allowNewEntries: requiredForEntries.every((component) =>
        component.verdict === 'healthy' || component.verdict === 'warning',
      ),
      allowPositionManagement: requiredForManagement.every(
        (component) => component.verdict !== 'stale',
      ),
      components: {
        balances,
        allowances,
        openOrders,
        clobTrades,
        dataApiTrades,
        currentPositions,
        closedPositions,
      },
    };
  }

  private detectDivergence(input: {
    descriptorByToken: Map<string, TokenDescriptor>;
    inventories: ExternalPortfolioInventorySnapshot[];
    openOrders: VenueOpenOrder[];
    currentPositions: ExternalPortfolioPositionSnapshot[];
    dataApiTrades: DataApiUserTradeRecord[];
    localOpenPositions: Array<{
      marketId: string;
      tokenId: string;
      quantity: number;
    }>;
    localOpenOrders: Array<{
      marketId: string;
      tokenId: string;
      venueOrderId: string | null;
      status: string;
    }>;
    localRecentFills: Array<{
      tokenId: string | null;
      filledAt: Date;
    }>;
  }): ExternalPortfolioDivergenceState {
    const details: ExternalPortfolioDivergenceDetail[] = [];
    const classes = new Set<string>();

    const localPositionByToken = new Map<string, number>();
    for (const position of input.localOpenPositions) {
      localPositionByToken.set(
        position.tokenId,
        (localPositionByToken.get(position.tokenId) ?? 0) + position.quantity,
      );
    }

    const externalPositionByToken = new Map<string, number>();
    for (const position of input.currentPositions) {
      externalPositionByToken.set(
        position.tokenId,
        (externalPositionByToken.get(position.tokenId) ?? 0) + position.size,
      );
    }

    const comparedTokens = new Set<string>([
      ...localPositionByToken.keys(),
      ...externalPositionByToken.keys(),
    ]);
    for (const tokenId of comparedTokens) {
      const localQuantity = localPositionByToken.get(tokenId) ?? 0;
      const externalQuantity = externalPositionByToken.get(tokenId) ?? 0;
      if (Math.abs(localQuantity - externalQuantity) <= 1e-6) {
        continue;
      }

      const descriptor = input.descriptorByToken.get(tokenId) ?? null;
      classes.add('inventory_mismatch_vs_current_positions');
      details.push({
        code: 'inventory_mismatch_vs_current_positions',
        tokenId,
        marketId: descriptor?.marketId ?? null,
        localValue: localQuantity,
        externalValue: externalQuantity,
        message: 'Local open-position quantity does not match external current-position truth.',
      });
    }

    for (const inventory of input.inventories) {
      if (Math.abs(inventory.balance - inventory.positionQuantity) <= 1e-6) {
        continue;
      }

      classes.add('conditional_balance_mismatch_vs_positions');
      details.push({
        code: 'conditional_balance_mismatch_vs_positions',
        tokenId: inventory.tokenId,
        marketId: inventory.marketId,
        localValue: inventory.balance,
        externalValue: inventory.positionQuantity,
        message:
          'Conditional token balance does not align with Data API current position quantity.',
      });
    }

    const venueOpenOrderIds = new Set(
      input.openOrders
        .filter((order) => this.remainingQuantity(order) > 0)
        .map((order) => order.id),
    );
    const localOpenOrderIds = new Set(
      input.localOpenOrders
        .map((order) => order.venueOrderId)
        .filter((orderId): orderId is string => typeof orderId === 'string' && orderId.length > 0),
    );

    for (const localOrder of input.localOpenOrders) {
      if (!localOrder.venueOrderId || venueOpenOrderIds.has(localOrder.venueOrderId)) {
        continue;
      }

      classes.add('local_open_order_missing_on_venue');
      details.push({
        code: 'local_open_order_missing_on_venue',
        tokenId: localOrder.tokenId,
        marketId: localOrder.marketId,
        localValue: localOrder.venueOrderId,
        externalValue: null,
        message: 'Local order is considered working but is absent from venue open orders.',
      });
    }

    for (const venueOrder of input.openOrders) {
      if (this.remainingQuantity(venueOrder) <= 0 || localOpenOrderIds.has(venueOrder.id)) {
        continue;
      }

      const descriptor = input.descriptorByToken.get(venueOrder.tokenId) ?? null;
      classes.add('venue_open_order_unknown_to_local');
      details.push({
        code: 'venue_open_order_unknown_to_local',
        tokenId: venueOrder.tokenId,
        marketId: descriptor?.marketId ?? null,
        localValue: null,
        externalValue: venueOrder.id,
        message: 'Venue reports a working open order that local state does not know about.',
      });
    }

    for (const position of input.currentPositions) {
      if (position.marketId) {
        continue;
      }

      classes.add('unknown_position_market_mapping');
      details.push({
        code: 'unknown_position_market_mapping',
        tokenId: position.tokenId,
        marketId: null,
        localValue: null,
        externalValue: position.size,
        message: 'Current position token is not mapped to a known local market.',
      });
    }

    const latestVenueTradeMs = this.maxTimestampMs(
      input.dataApiTrades.map((trade) => trade.timestamp),
    );
    const latestLocalFillMs = this.maxDateMs(
      input.localRecentFills.map((fill) => fill.filledAt),
    );
    if (
      latestVenueTradeMs != null &&
      (latestLocalFillMs == null || latestVenueTradeMs - latestLocalFillMs > 30_000) &&
      classes.has('inventory_mismatch_vs_current_positions')
    ) {
      classes.add('venue_trade_unknown_to_local');
      details.push({
        code: 'venue_trade_unknown_to_local',
        tokenId: null,
        marketId: null,
        localValue: latestLocalFillMs,
        externalValue: latestVenueTradeMs,
        message:
          'Recent venue trade history is ahead of local fill continuity while inventory truth diverges.',
      });
    }

    const status: DivergenceStatus =
      classes.size === 0
        ? 'none'
        : [...classes].some((code) =>
              code === 'venue_open_order_unknown_to_local' ||
              code === 'unknown_position_market_mapping',
            )
          ? 'blocking'
          : 'recoverable';

    return {
      status,
      classes: [...classes],
      details,
    };
  }

  private planRecovery(
    divergence: ExternalPortfolioDivergenceState,
  ): ExternalPortfolioRecoveryState {
    if (divergence.status === 'none') {
      return {
        mode: 'none',
        entriesBlocked: false,
        positionManagementBlocked: false,
        reasonCodes: [],
      };
    }

    if (divergence.status === 'blocking') {
      return {
        mode: 'manual_review',
        entriesBlocked: true,
        positionManagementBlocked: true,
        reasonCodes: divergence.classes,
      };
    }

    return {
      mode: 'rebuild_local_positions',
      entriesBlocked: true,
      positionManagementBlocked: false,
      reasonCodes: divergence.classes,
    };
  }

  private refreshLoadedSnapshot(
    snapshot: ExternalPortfolioSnapshot,
  ): ExternalPortfolioSnapshot {
    const refreshedComponents = {
      balances: this.refreshFreshnessComponent(snapshot.freshness.components.balances),
      allowances: this.refreshFreshnessComponent(snapshot.freshness.components.allowances),
      openOrders: this.refreshFreshnessComponent(snapshot.freshness.components.openOrders),
      clobTrades: this.refreshFreshnessComponent(snapshot.freshness.components.clobTrades),
      dataApiTrades: this.refreshFreshnessComponent(snapshot.freshness.components.dataApiTrades),
      currentPositions: this.refreshFreshnessComponent(
        snapshot.freshness.components.currentPositions,
      ),
      closedPositions: this.refreshFreshnessComponent(
        snapshot.freshness.components.closedPositions,
      ),
    };

    const allowNewEntries = [
      refreshedComponents.balances,
      refreshedComponents.allowances,
      refreshedComponents.openOrders,
      refreshedComponents.clobTrades,
      refreshedComponents.dataApiTrades,
      refreshedComponents.currentPositions,
    ].every((component) =>
      component.verdict === 'healthy' || component.verdict === 'warning',
    );
    const allowPositionManagement = [
      refreshedComponents.openOrders,
      refreshedComponents.clobTrades,
      refreshedComponents.currentPositions,
    ].every((component) => component.verdict !== 'stale');

    const refreshed: ExternalPortfolioSnapshot = {
      ...snapshot,
      freshnessState:
        allowNewEntries && !snapshot.recovery.entriesBlocked ? 'fresh' : 'stale',
      reconciliationHealth:
        allowNewEntries &&
        !snapshot.recovery.entriesBlocked &&
        snapshot.divergence.status === 'none'
          ? 'healthy'
          : 'failed',
      tradingPermissions: {
        allowNewEntries: allowNewEntries && !snapshot.recovery.entriesBlocked,
        allowPositionManagement:
          allowPositionManagement && !snapshot.recovery.positionManagementBlocked,
        reasonCodes: snapshot.recovery.reasonCodes,
      },
      freshnessVerdict: this.maxVerdict(
        Object.values(refreshedComponents).map((component) => component.verdict),
      ),
      freshness: {
        ...snapshot.freshness,
        overallVerdict: this.maxVerdict(
          Object.values(refreshedComponents).map((component) => component.verdict),
        ),
        confidence: this.resolveConfidence({
          freshness: {
            ...snapshot.freshness,
            overallVerdict: this.maxVerdict(
              Object.values(refreshedComponents).map((component) => component.verdict),
            ),
            allowNewEntries,
            allowPositionManagement,
            components: refreshedComponents,
          },
          divergence: snapshot.divergence,
          recovery: snapshot.recovery,
        }),
        allowNewEntries,
        allowPositionManagement,
        components: refreshedComponents,
      },
    };

    return refreshed;
  }

  private assessFreshnessComponent(input: {
    component: ExternalPortfolioFreshnessComponent['component'];
    fetchedAt: string;
    sourceTimestamp: string | null;
    healthyAgeMs: number;
  }): ExternalPortfolioFreshnessComponent {
    const fetchedAtMs = new Date(input.fetchedAt).getTime();
    const ageMs = Number.isFinite(fetchedAtMs) ? Math.max(0, Date.now() - fetchedAtMs) : Number.MAX_SAFE_INTEGER;
    const verdict =
      ageMs <= input.healthyAgeMs * 0.5
        ? 'healthy'
        : ageMs <= input.healthyAgeMs
          ? 'warning'
          : ageMs <= input.healthyAgeMs * 2
            ? 'degraded'
            : 'stale';

    return {
      component: input.component,
      fetchedAt: input.fetchedAt,
      sourceTimestamp: input.sourceTimestamp,
      ageMs,
      verdict,
      confidence:
        verdict === 'healthy'
          ? 'high'
          : verdict === 'warning'
            ? 'medium'
            : verdict === 'degraded'
              ? 'low'
              : 'none',
      maxHealthyAgeMs: input.healthyAgeMs,
      maxWarningAgeMs: input.healthyAgeMs,
      maxDegradedAgeMs: input.healthyAgeMs * 2,
    };
  }

  private refreshFreshnessComponent(
    component: ExternalPortfolioFreshnessComponent,
  ): ExternalPortfolioFreshnessComponent {
    return this.assessFreshnessComponent({
      component: component.component,
      fetchedAt: component.fetchedAt,
      sourceTimestamp: component.sourceTimestamp,
      healthyAgeMs: component.maxHealthyAgeMs,
    });
  }

  private resolveConfidence(input: {
    freshness: Pick<
      ExternalPortfolioFreshnessState,
      'overallVerdict' | 'allowNewEntries' | 'allowPositionManagement' | 'components'
    >;
    divergence: ExternalPortfolioDivergenceState;
    recovery: ExternalPortfolioRecoveryState;
  }): ConfidenceLevel {
    if (
      input.divergence.status === 'blocking' ||
      input.recovery.positionManagementBlocked ||
      input.freshness.overallVerdict === 'stale'
    ) {
      return 'none';
    }

    if (
      input.divergence.status === 'recoverable' ||
      input.recovery.entriesBlocked ||
      input.freshness.overallVerdict === 'degraded'
    ) {
      return 'low';
    }

    if (input.freshness.overallVerdict === 'warning') {
      return 'medium';
    }

    return 'high';
  }

  private resolveMarkPrice(input: {
    tokenId: string;
    marketId: string | null;
    outcome: Outcome;
    marketById: Map<string, any>;
    latestOrderbookByToken: Map<string, any>;
    latestSnapshotByMarket: Map<string, any>;
  }): number | null {
    const orderbook = input.latestOrderbookByToken.get(input.tokenId);
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

    if (!input.marketId) {
      return null;
    }

    const market = input.marketById.get(input.marketId) ?? null;
    const snapshot = input.latestSnapshotByMarket.get(input.marketId) ?? null;
    if (snapshot && Number.isFinite(snapshot.marketPrice) && snapshot.marketPrice > 0) {
      if (input.outcome === 'YES') {
        return snapshot.marketPrice;
      }
      if (input.outcome === 'NO') {
        return 1 - snapshot.marketPrice;
      }
    }

    if (!market) {
      return null;
    }

    return null;
  }

  private normalizeOutcome(value: unknown): Outcome {
    if (typeof value !== 'string') {
      return 'UNKNOWN';
    }

    const normalized = value.trim().toUpperCase();
    if (normalized === 'YES') {
      return 'YES';
    }
    if (normalized === 'NO') {
      return 'NO';
    }
    return 'UNKNOWN';
  }

  private remainingQuantity(order: VenueOpenOrder): number {
    return Math.max(0, order.size - order.matchedSize);
  }

  private sumRealizedFees(trades: VenueTradeRecord[]): number | null {
    const fees = trades
      .map((trade) => trade.fee)
      .filter((fee): fee is number => Number.isFinite(fee));
    if (fees.length === 0) {
      return null;
    }

    return fees.reduce((sum, fee) => sum + fee, 0);
  }

  private sumRealizedPnl(
    positions: ExternalPortfolioPositionSnapshot[],
  ): number | null {
    const values = positions
      .map((position) => position.realizedPnl)
      .filter((value): value is number => Number.isFinite(value));
    if (values.length === 0) {
      return null;
    }

    return values.reduce((sum, value) => sum + value, 0);
  }

  private maxTimestamp(values: Array<string | null | undefined>): string | null {
    const maxMs = this.maxTimestampMs(values);
    return maxMs == null ? null : new Date(maxMs).toISOString();
  }

  private maxTimestampMs(values: Array<string | null | undefined>): number | null {
    const parsed = values
      .map((value) => (value ? new Date(value).getTime() : Number.NaN))
      .filter((value) => Number.isFinite(value));
    if (parsed.length === 0) {
      return null;
    }

    return Math.max(...parsed);
  }

  private maxDateMs(values: Date[]): number | null {
    const parsed = values
      .map((value) => value.getTime())
      .filter((value) => Number.isFinite(value));
    if (parsed.length === 0) {
      return null;
    }

    return Math.max(...parsed);
  }

  private maxVerdict(verdicts: FreshnessVerdict[]): FreshnessVerdict {
    const rank: Record<FreshnessVerdict, number> = {
      healthy: 0,
      warning: 1,
      degraded: 2,
      stale: 3,
    };

    return [...verdicts].sort((left, right) => rank[right] - rank[left])[0] ?? 'stale';
  }

  private maxSnapshotAgeMs(): number {
    return Math.max(appEnv.BOT_PORTFOLIO_REFRESH_INTERVAL_MS * 2, 15_000);
  }

  private readLocalStringField(
    value: Record<string, unknown>,
    field: string,
  ): string | null {
    const candidate = value[field];
    return typeof candidate === 'string' && candidate.trim().length > 0
      ? candidate.trim()
      : null;
  }
}
