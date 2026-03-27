import { PrismaClient } from '@prisma/client';
import { AppLogger } from '@worker/common/logger';
import { appEnv } from '@worker/config/env';
import { BotRuntimeState } from '@worker/runtime/bot-state';
import { RuntimeControlRepository } from '@worker/runtime/runtime-control.repository';
import { permissionsForRuntimeState } from '@worker/runtime/runtime-state-machine';
import { CancelReplacePolicy } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { FillProbabilityEstimator } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { FillStateService } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { OfficialPolymarketTradingClient } from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';
import { MarketEligibilityService } from '@polymarket-btc-5m-agentic-bot/signal-engine';

interface VenueOpenOrder {
  venueOrderId: string;
  status: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  matchedSize: number;
  tokenId: string;
}

interface ExecutionWatchdogDirective {
  runtimeState: BotRuntimeState | null;
  degradeOrderPersistence: boolean;
  avoidBlindReposts: boolean;
  forceCancelOnlyBehavior: boolean;
  reasonCodes: string[];
}

export class ManageOpenOrdersJob {
  private readonly logger = new AppLogger('ManageOpenOrdersJob');
  private readonly cancelReplacePolicy = new CancelReplacePolicy();
  private readonly fillProbabilityEstimator = new FillProbabilityEstimator();
  private readonly fillStateService = new FillStateService();
  private readonly marketEligibility = new MarketEligibilityService();
  private readonly tradingClient = new OfficialPolymarketTradingClient({
    host: appEnv.POLY_CLOB_HOST,
    chainId: appEnv.POLY_CHAIN_ID,
    privateKey: appEnv.POLY_PRIVATE_KEY ?? '',
    apiKey: appEnv.POLY_API_KEY ?? '',
    apiSecret: appEnv.POLY_API_SECRET ?? '',
    apiPassphrase: appEnv.POLY_API_PASSPHRASE ?? '',
    signatureType: appEnv.POLY_SIGNATURE_TYPE,
    funder: appEnv.POLY_FUNDER ?? null,
    geoBlockToken: appEnv.POLY_GEO_BLOCK_TOKEN ?? null,
    useServerTime: appEnv.POLY_USE_SERVER_TIME,
    maxClockSkewMs: appEnv.POLY_MAX_CLOCK_SKEW_MS,
  });

  constructor(
    private readonly prisma: PrismaClient,
    private readonly runtimeControl?: RuntimeControlRepository,
  ) {}

  async run(options?: {
    forceCancelAll?: boolean;
    runtimeState?: BotRuntimeState;
  }): Promise<{ canceled: number; observed: number; syncFailed: boolean }> {
    const forceCancelAll = options?.forceCancelAll ?? false;
    const permissions = options?.runtimeState
      ? permissionsForRuntimeState(options.runtimeState)
      : null;
    if (
      permissions &&
      !permissions.allowReconciliation &&
      !(forceCancelAll && permissions.allowEmergencyCancel)
    ) {
      return {
        canceled: 0,
        observed: 0,
        syncFailed: false,
      };
    }

    const cycleKey = `open-orders:${Date.now()}`;
    await this.recordCheckpoint(cycleKey, 'processing', {
      forceCancelAll,
    });
    const watchdogDirective = await this.loadExecutionWatchdogDirective();

    const localOpenOrders = await this.prisma.order.findMany({
      where: {
        status: {
          in: ['submitted', 'acknowledged', 'partially_filled'],
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
      take: 100,
    });

    const venueSync = appEnv.BOT_LIVE_EXECUTION_ENABLED
      ? await this.fetchVenueOpenOrders()
      : { ok: true, orders: [] as VenueOpenOrder[] };
    const scoringStatusByOrderId =
      appEnv.BOT_LIVE_EXECUTION_ENABLED && venueSync.ok
        ? await this.fetchOrderScoringStatuses(venueSync.orders.map((entry) => entry.venueOrderId))
        : new Map<string, boolean>();
    const venueOpenOrderMap = new Map(
      venueSync.orders.map((entry) => [entry.venueOrderId, entry]),
    );

    let canceled = 0;
    const now = Date.now();

    if (appEnv.BOT_LIVE_EXECUTION_ENABLED && !venueSync.ok) {
      this.logger.warn('Venue open-order sync failed. Skipping local state mutation.');
      await this.recordCheckpoint(cycleKey, 'sync_failed', {
        observed: localOpenOrders.length,
      });
      return {
        canceled,
        observed: localOpenOrders.length,
        syncFailed: true,
      };
    }

    for (const order of localOpenOrders) {
      const ageMs = now - order.createdAt.getTime();
      const stale = forceCancelAll || ageMs >= appEnv.BOT_ORDER_STALE_AFTER_MS;
      const venueOrderId = order.venueOrderId ?? order.id;
      const venueOrder = venueOpenOrderMap.get(venueOrderId);

      if (appEnv.BOT_LIVE_EXECUTION_ENABLED && !venueOrder) {
        if (ageMs < appEnv.BOT_ORDER_MISSING_OPEN_GRACE_MS) {
          await this.prisma.order.update({
            where: { id: order.id },
            data: {
              lastError: 'missing_from_open_orders_within_grace',
              lastVenueSyncAt: new Date(),
            },
          });
          continue;
        }

        const resolvedStatus = this.resolveMissingOrderStatus(order);
        await this.prisma.order.update({
          where: { id: order.id },
          data: {
            status: resolvedStatus,
            lastVenueStatus: 'missing_from_open_orders_reconciled',
            ...(resolvedStatus === 'canceled' ? { canceledAt: new Date() } : {}),
            lastError: 'reconciled_missing_from_open_orders',
            lastVenueSyncAt: new Date(),
          },
        });
        await this.prisma.auditEvent.create({
          data: {
            orderId: order.id,
            marketId: order.marketId,
            signalId: order.signalId,
            eventType: 'order.reconciled_missing_from_open_orders',
            message:
              'Order absent from venue open-order set. Local state reconciled to terminal status.',
            metadata: {
              resolvedStatus,
              orderId: order.id,
              venueOrderId,
            } as object,
          },
        });
        if (resolvedStatus === 'canceled') {
          canceled += 1;
        }
        continue;
      }

      if (venueOrder) {
        if (order.lastVenueStatus === 'cancel_requested') {
          await this.prisma.order.update({
            where: { id: order.id },
            data: {
              lastError: 'awaiting_cancel_confirmation',
              lastVenueSyncAt: new Date(),
            },
          });
          continue;
        }

        const normalizedVenueStatus = this.normalizeVenueStatus(venueOrder.status);
        if (
          normalizedVenueStatus !== 'submitted' &&
          normalizedVenueStatus !== 'acknowledged' &&
          normalizedVenueStatus !== 'partially_filled'
        ) {
          await this.prisma.order.update({
            where: { id: order.id },
            data: {
              status: normalizedVenueStatus,
              lastVenueStatus: venueOrder.status,
              lastVenueSyncAt: new Date(),
              ...(normalizedVenueStatus === 'canceled' ? { canceledAt: new Date() } : {}),
            },
          });
          continue;
        }
      }

      if (!stale && venueOrder) {
        const orderSide = this.readOrderSide(order);
        const orderIntent = this.readOrderIntent(order);
        if (!orderSide) {
          continue;
        }
        const signal =
          order.signalId && (this.prisma.signal as any)?.findUnique
            ? await (this.prisma.signal as any).findUnique({
                where: { id: order.signalId },
              })
            : null;
        const market = (this.prisma.market as any)?.findUnique
          ? await (this.prisma.market as any).findUnique({
              where: { id: order.marketId },
            })
          : null;
        const latestSnapshot = (this.prisma.marketSnapshot as any)?.findFirst
          ? await (this.prisma.marketSnapshot as any).findFirst({
              where: { marketId: order.marketId },
              orderBy: { observedAt: 'desc' },
            })
          : null;
        const latestOrderbook = await this.prisma.orderbook.findFirst({
          where: {
            marketId: order.marketId,
            tokenId: order.tokenId,
          },
          orderBy: {
            observedAt: 'desc',
          },
        });
        const signalAgeMs =
          signal?.observedAt instanceof Date
            ? now - signal.observedAt.getTime()
            : ageMs;
        const currentPassivePrice =
          orderSide === 'BUY'
            ? this.normalizePositive(latestOrderbook?.bestBid ?? null)
            : this.normalizePositive(latestOrderbook?.bestAsk ?? null);
        const marketableReference =
          orderSide === 'BUY'
            ? this.normalizePositive(latestOrderbook?.bestAsk ?? null)
            : this.normalizePositive(latestOrderbook?.bestBid ?? null);
        const topLevelDepth = latestOrderbook
          ? this.topLevelDepth(latestOrderbook, orderSide)
          : 0;
        const fillProbability = this.fillProbabilityEstimator.estimate({
          orderSize: Math.max(order.remainingSize, 0.00000001),
          topLevelDepth,
          recentMatchedVolume: Math.max(venueOrder.matchedSize, 0),
          queuePressureScore: currentPassivePrice !== null ? 1 : 3,
        });
        const repricesUsed = await this.countPriorReprices(order.signalId);
        const eligibility =
          market && latestSnapshot && latestOrderbook
            ? this.marketEligibility.evaluate({
                market: {
                  id: market.id,
                  slug: this.readStringField(market, 'slug'),
                  title: this.readStringField(market, 'title'),
                  question: this.readStringField(market, 'title'),
                  active: this.readStringField(market, 'status') !== 'closed',
                  closed: this.readStringField(market, 'status') === 'closed',
                  tradable: true,
                  tokenIdYes: this.readStringField(market, 'tokenIdYes'),
                  tokenIdNo: this.readStringField(market, 'tokenIdNo'),
                  expiresAt: this.readStringField(market, 'expiresAt'),
                  negativeRisk:
                    typeof (latestOrderbook as Record<string, unknown>).negRisk === 'boolean'
                      ? ((latestOrderbook as Record<string, unknown>).negRisk as boolean)
                      : null,
                  enableOrderBook: true,
                },
                spread: latestOrderbook.spread ?? null,
                bidDepth: this.topLevelDepth(latestOrderbook, 'SELL'),
                askDepth: this.topLevelDepth(latestOrderbook, 'BUY'),
                topLevelDepth,
                tickSize:
                  typeof (latestOrderbook as Record<string, unknown>).tickSize === 'number'
                    ? ((latestOrderbook as Record<string, unknown>).tickSize as number)
                    : null,
                orderbookObservedAt: latestOrderbook.observedAt,
                marketObservedAt: latestSnapshot.observedAt,
                recentTradeCount: 1,
                maxOrderbookAgeMs: appEnv.BOT_MAX_ORDERBOOK_AGE_MS,
                maxMarketAgeMs: appEnv.BOT_MAX_MARKET_SNAPSHOT_AGE_MS,
                noTradeWindowSeconds: 30,
              })
            : { eligible: true, reasonCode: 'passed', reasonMessage: null };
        const policy = this.cancelReplacePolicy.evaluate({
          action: orderIntent === 'EXIT' || orderIntent === 'REDUCE' ? orderIntent : 'ENTER',
          route: 'maker',
          signalAgeMs,
          maxSignalAgeMs: Math.max(appEnv.BOT_ORDER_STALE_AFTER_MS * 2, 45_000),
          ageMs,
          waitingBeforeReplaceMs: watchdogDirective.degradeOrderPersistence
            ? Math.max(1_000, Math.floor(appEnv.BOT_ORDER_STALE_AFTER_MS / 4))
            : Math.max(2_000, Math.floor(appEnv.BOT_ORDER_STALE_AFTER_MS / 2)),
          maxRestingAgeMs: watchdogDirective.degradeOrderPersistence
            ? Math.max(2_000, Math.floor(appEnv.BOT_ORDER_STALE_AFTER_MS / 2))
            : appEnv.BOT_ORDER_STALE_AFTER_MS,
          repricesUsed,
          maxRepricesPerSignal: watchdogDirective.avoidBlindReposts ? 0 : 2,
          fillProbability: fillProbability.fillProbability,
          minimumFillProbability:
            (orderIntent === 'ENTER' ? 0.35 : 0.2) +
            (watchdogDirective.degradeOrderPersistence ? 0.1 : 0),
          priceDriftBps: this.computePriceDriftBps(order.price, currentPassivePrice),
          adverseMoveBps: this.computeAdverseMoveBps(orderSide, order.price, marketableReference),
          maxAllowedPriceDriftBps: orderIntent === 'ENTER' ? 10 : 20,
          maxAllowedAdverseMoveBps: 20,
          scoringActive: scoringStatusByOrderId.get(venueOrder.venueOrderId) ?? false,
        });
        const residualDecision = this.fillStateService.decideResidual({
          remainingSize: Math.max(order.remainingSize, 0),
          minMeaningfulSize:
            typeof (latestOrderbook as Record<string, unknown>)?.minOrderSize === 'number'
              ? ((latestOrderbook as Record<string, unknown>).minOrderSize as number)
              : 1,
          signalAgeMs,
          maxSignalAgeMs: Math.max(appEnv.BOT_ORDER_STALE_AFTER_MS * 2, 45_000),
          priceDriftBps: this.computePriceDriftBps(order.price, currentPassivePrice),
          fillProbability: fillProbability.fillProbability,
        });
        const forcedCancelReason = !eligibility.eligible
          ? eligibility.reasonMessage ?? eligibility.reasonCode
          : watchdogDirective.forceCancelOnlyBehavior
            ? watchdogDirective.reasonCodes[0] ?? 'execution_state_watchdog_cancel_only'
            : null;
        const normalizedPolicyAction =
          watchdogDirective.avoidBlindReposts && policy.action === 'replace'
            ? 'cancel'
            : policy.action;

        if (
          !forcedCancelReason &&
          (normalizedPolicyAction === 'keep' || residualDecision === 'keep')
        ) {
          await this.prisma.order.update({
            where: { id: order.id },
            data: {
              lastError:
                residualDecision === 'keep'
                  ? 'residual_keep'
                  : normalizedPolicyAction === 'cancel' && policy.action === 'replace'
                    ? 'execution_state_watchdog_avoids_blind_repost'
                    : policy.reasonCode,
              lastVenueSyncAt: new Date(),
            },
          });
          continue;
        }

        if (appEnv.BOT_LIVE_EXECUTION_ENABLED) {
          try {
            await this.cancelVenueOrder(venueOrderId);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            await this.prisma.order.update({
              where: { id: order.id },
              data: {
                lastError: errorMessage,
              },
            });
            await this.prisma.auditEvent.create({
              data: {
                orderId: order.id,
                marketId: order.marketId,
                signalId: order.signalId,
                eventType: 'order.cancel_failed',
                message: 'Venue order cancel failed during lifecycle management.',
                metadata: {
                  venueOrderId,
                  error: errorMessage,
                  workingOrdersRemaining: localOpenOrders.length,
                } as object,
              },
            });
            continue;
          }
        }

        await this.prisma.order.update({
          where: { id: order.id },
          data: {
            status:
              order.status === 'partially_filled' ? 'partially_filled' : 'acknowledged',
            lastVenueStatus:
              policy.action === 'replace' ? 'cancel_requested_for_replace' : 'cancel_requested',
            lastVenueSyncAt: new Date(),
            lastError: 'cancel_request_pending_confirmation',
          },
        });
        await this.prisma.auditEvent.create({
          data: {
            orderId: order.id,
            marketId: order.marketId,
            signalId: order.signalId,
            eventType:
              forcedCancelReason
                ? 'order.market_ineligible'
                : normalizedPolicyAction === 'replace'
                  ? 'order.replace_requested'
                  : 'order.cancel_requested',
            message:
              forcedCancelReason
                ? 'Working order cancel was requested because the market became ineligible.'
                : normalizedPolicyAction === 'replace'
                  ? 'Passive order cancel was requested to allow deterministic repost.'
                  : watchdogDirective.forceCancelOnlyBehavior
                    ? 'Passive order cancel was requested because execution truth degraded into cancel-only behavior.'
                    : 'Passive order cancel was requested by deterministic execution policy.',
            metadata: {
              lifecycleState: policy.lifecycleState,
              reasonCode: forcedCancelReason ?? policy.reasonCode,
              repricesUsed,
              residualDecision,
              eligibility,
              scoringActive: scoringStatusByOrderId.get(venueOrder.venueOrderId) ?? false,
              watchdogDirective,
            } as object,
          },
        });
        if (
          (forcedCancelReason || normalizedPolicyAction === 'cancel') &&
          orderIntent === 'ENTER' &&
          order.signalId
        ) {
          await this.rejectSignal(order.signalId, forcedCancelReason ?? policy.reasonCode);
        }
        continue;
      }

      if (appEnv.BOT_LIVE_EXECUTION_ENABLED) {
        try {
          await this.cancelVenueOrder(venueOrderId);
        } catch (error) {
          await this.prisma.order.update({
            where: { id: order.id },
            data: {
              lastError:
                error instanceof Error ? error.message : String(error),
            },
          });
          continue;
        }
      }

      if (venueOrder) {
        await this.prisma.order.update({
          where: { id: order.id },
          data: {
            status:
              order.status === 'partially_filled' ? 'partially_filled' : 'acknowledged',
            lastVenueStatus: 'cancel_requested',
            lastVenueSyncAt: new Date(),
            lastError: 'cancel_request_pending_confirmation',
          },
        });
        await this.prisma.auditEvent.create({
          data: {
            orderId: order.id,
            marketId: order.marketId,
            signalId: order.signalId,
            eventType: 'order.cancel_requested',
            message:
              'Venue-visible order cancel was requested and is awaiting confirmation.',
            metadata: {
              venueOrderId,
              forceCancelAll,
              stale,
            } as object,
          },
        });
        continue;
      }

      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          status: 'canceled',
          lastVenueStatus: 'canceled_locally',
          lastVenueSyncAt: new Date(),
          canceledAt: new Date(),
        },
      });
      canceled += 1;
    }

    this.logger.debug('Open-order management cycle completed.', {
      observed: localOpenOrders.length,
      canceled,
      venueOpenOrders: venueSync.orders.length,
      forceCancelAll,
      watchdogDirective,
    });

    await this.recordCheckpoint(cycleKey, 'completed', {
      observed: localOpenOrders.length,
      canceled,
      venueOpenOrders: venueSync.orders.length,
      forceCancelAll,
      watchdogDirective,
    });

    return {
      canceled,
      observed: localOpenOrders.length,
      syncFailed: false,
    };
  }

  private async fetchVenueOpenOrders(): Promise<{
    ok: boolean;
    orders: VenueOpenOrder[];
  }> {
    try {
      const payload = await this.tradingClient.getOpenOrders();

      return {
        ok: true,
        orders: payload
          .map((entry) => ({
            venueOrderId: entry.id,
            status: entry.status,
            side: entry.side === 'SELL' ? 'SELL' : 'BUY',
            price: entry.price,
            size: entry.size,
            matchedSize: entry.matchedSize,
            tokenId: entry.tokenId,
          }))
          .filter(
            (entry): entry is VenueOpenOrder =>
              entry.venueOrderId.length > 0 && entry.tokenId.length > 0,
          ),
      };
    } catch {
      return {
        ok: false,
        orders: [],
      };
    }
  }

  private async cancelVenueOrder(orderId: string): Promise<void> {
    await this.tradingClient.cancelOrder(orderId);
  }

  private normalizeVenueStatus(status: string): string {
    const normalized = status.toLowerCase();
    if (normalized.includes('part')) {
      return 'partially_filled';
    }
    if (normalized.includes('fill')) {
      return 'filled';
    }
    if (normalized.includes('cancel')) {
      return 'canceled';
    }
    if (normalized.includes('ack')) {
      return 'acknowledged';
    }
    if (normalized.includes('reject')) {
      return 'rejected';
    }
    return 'submitted';
  }

  private resolveMissingOrderStatus(order: {
    size: number;
    filledSize: number;
    remainingSize: number;
  }): 'filled' | 'canceled' {
    const remaining = Math.max(
      0,
      order.remainingSize > 0 ? order.remainingSize : order.size - order.filledSize,
    );
    if (remaining <= 1e-8) {
      return 'filled';
    }
    return 'canceled';
  }

  private async fetchOrderScoringStatuses(orderIds: string[]): Promise<Map<string, boolean>> {
    try {
      const statuses = await this.tradingClient.getOrderScoring(orderIds);
      return new Map(statuses.map((status) => [status.orderId, status.scoring]));
    } catch {
      return new Map();
    }
  }

  private async countPriorReprices(signalId: string | null): Promise<number> {
    if (!signalId || !(this.prisma.order as any)?.count) {
      return 0;
    }

    return (this.prisma.order as any).count({
      where: {
        signalId,
        lastError: 'fill_probability_too_low',
      },
    });
  }

  private async loadExecutionWatchdogDirective(): Promise<ExecutionWatchdogDirective> {
    if (!this.runtimeControl) {
      return {
        runtimeState: null,
        degradeOrderPersistence: false,
        avoidBlindReposts: false,
        forceCancelOnlyBehavior: false,
        reasonCodes: [],
      };
    }

    const checkpoint = await this.runtimeControl.getLatestCheckpoint('execution_state_watchdog');
    const details =
      checkpoint?.details && typeof checkpoint.details === 'object'
        ? (checkpoint.details as Record<string, unknown>)
        : {};
    const transitionRequest =
      details.transitionRequest && typeof details.transitionRequest === 'object'
        ? (details.transitionRequest as Record<string, unknown>)
        : null;
    const degradeOrderPersistence = Boolean(details.degradeOrderPersistence);
    const avoidBlindReposts = Boolean(details.avoidBlindReposts);
    const forceCancelOnlyBehavior = Boolean(details.forceCancelOnlyBehavior);
    const reasonCodes = Array.isArray(details.reasonCodes)
      ? details.reasonCodes.filter((value): value is string => typeof value === 'string')
      : [];
    const runtimeState =
      transitionRequest && typeof transitionRequest.nextState === 'string'
        ? (transitionRequest.nextState as BotRuntimeState)
        : null;

    return {
      runtimeState,
      degradeOrderPersistence,
      avoidBlindReposts,
      forceCancelOnlyBehavior,
      reasonCodes,
    };
  }

  private computePriceDriftBps(orderPrice: number, currentPassivePrice: number | null): number {
    if (!Number.isFinite(currentPassivePrice) || !Number.isFinite(orderPrice) || orderPrice <= 0) {
      return 0;
    }

    return (((currentPassivePrice as number) - orderPrice) / orderPrice) * 10_000;
  }

  private computeAdverseMoveBps(
    side: 'BUY' | 'SELL',
    orderPrice: number,
    marketableReference: number | null,
  ): number {
    if (!Number.isFinite(marketableReference) || !Number.isFinite(orderPrice) || orderPrice <= 0) {
      return 0;
    }

    const delta =
      side === 'BUY'
        ? (marketableReference as number) - orderPrice
        : orderPrice - (marketableReference as number);
    return (delta / orderPrice) * 10_000;
  }

  private normalizePositive(value: number | null | undefined): number | null {
    return Number.isFinite(value) && (value as number) > 0 ? (value as number) : null;
  }

  private readOrderSide(order: unknown): 'BUY' | 'SELL' | null {
    if (!order || typeof order !== 'object') {
      return null;
    }

    const value = (order as Record<string, unknown>).side;
    return value === 'BUY' || value === 'SELL' ? value : null;
  }

  private readOrderIntent(order: unknown): 'ENTER' | 'REDUCE' | 'EXIT' | null {
    if (!order || typeof order !== 'object') {
      return null;
    }

    const value = (order as Record<string, unknown>).intent;
    return value === 'ENTER' || value === 'REDUCE' || value === 'EXIT' ? value : null;
  }

  private readStringField(source: unknown, key: string): string | null {
    if (!source || typeof source !== 'object') {
      return null;
    }

    const value = (source as Record<string, unknown>)[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  private topLevelDepth(
    orderbook: {
      bidLevels: unknown;
      askLevels: unknown;
    },
    side: 'BUY' | 'SELL',
  ): number {
    const levels = side === 'BUY' ? orderbook.bidLevels : orderbook.askLevels;
    if (!Array.isArray(levels) || levels.length === 0) {
      return 0;
    }

    const top = levels[0];
    if (Array.isArray(top) && top.length >= 2) {
      const size = Number(top[1]);
      return Number.isFinite(size) && size > 0 ? size : 0;
    }
    if (typeof top === 'object' && top !== null) {
      const record = top as Record<string, unknown>;
      const size = Number(record.size ?? record.s ?? Number.NaN);
      return Number.isFinite(size) && size > 0 ? size : 0;
    }
    return 0;
  }

  private async rejectSignal(signalId: string, reasonCode: string): Promise<void> {
    if (!(this.prisma.signal as any)?.update || !(this.prisma.signalDecision as any)?.create) {
      return;
    }

    await (this.prisma.signal as any).update({
      where: { id: signalId },
      data: { status: 'rejected' },
    });
    await (this.prisma.signalDecision as any).create({
      data: {
        id: `reprice-${signalId}-${Date.now()}`,
        signalId,
        verdict: 'rejected',
        reasonCode,
        reasonMessage: reasonCode,
        expectedEv: null,
        positionSize: null,
        decisionAt: new Date(),
      },
    });
  }

  private async recordCheckpoint(
    cycleKey: string,
    status: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.runtimeControl) {
      return;
    }

    await this.runtimeControl.recordReconciliationCheckpoint({
      cycleKey,
      source: 'open_orders_reconcile',
      status,
      details,
    });
  }
}
