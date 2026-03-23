import { AppLogger } from '@worker/common/logger';
import { GammaClient } from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';
import {
  VenueOpenOrder,
  VenueTradeRecord,
} from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';
import { PolymarketWebSocketClient } from '@polymarket-btc-5m-agentic-bot/market-data';

export interface UserStreamOrderProjection {
  orderId: string;
  marketId?: string | null;
  conditionId?: string | null;
  tokenId: string;
  side: 'BUY' | 'SELL';
  status: string;
  price: number;
  size: number;
  remainingSize: number;
  updatedAt: string;
}

export interface UserStreamTradeProjection {
  tradeId: string;
  marketId?: string | null;
  conditionId?: string | null;
  orderId: string | null;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  fee: number | null;
  status?: string | null;
  filledAt: string;
}

export interface UserWebSocketHealth {
  healthy: boolean;
  reasonCode: string | null;
  connectionStatus: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'failed';
  lastEventAt: string | null;
  lastTrafficAt: string | null;
  openOrders: number;
  recentTrades: number;
  divergenceDetected: boolean;
  lastReconciliationAt: string | null;
  trusted: boolean;
  subscribedMarkets: number;
  reconnectAttempt: number;
}

export interface UserStreamMarketSubscription {
  marketId: string;
  conditionId?: string | null;
  tokenIds?: string[];
}

interface UserStreamResolvedSubscription {
  marketId: string;
  conditionId: string;
  tokenIds: string[];
}

interface UserRestTruth {
  openOrders: UserStreamOrderProjection[];
  trades: UserStreamTradeProjection[];
  capturedAt: string;
}

interface BufferedUserEvent {
  receivedAt: string;
  eventAt: string;
  eventKey: string;
  kind: 'order' | 'trade';
  order?: UserStreamOrderProjection;
  trade?: UserStreamTradeProjection;
}

interface BootstrapState {
  generation: number;
  buffer: BufferedUserEvent[];
  trafficObserved: boolean;
  finalizing: boolean;
  deferred: {
    resolve: () => void;
    reject: (error: Error) => void;
    promise: Promise<void>;
  };
  timeoutHandle: NodeJS.Timeout;
}

interface OrderCursor {
  timestampMs: number;
  phaseRank: number;
  recentKeys: string[];
}

interface TradeCursor {
  timestampMs: number;
  statusRank: number;
  recentKeys: string[];
}

export interface UserWebSocketStateServiceOptions {
  url?: string | null;
  gammaBaseUrl?: string | null;
  auth?:
    | {
        apiKey: string;
        secret: string;
        passphrase: string;
      }
    | null;
  restClient?:
    | {
        getOpenOrders: () => Promise<VenueOpenOrder[]>;
        getTrades: () => Promise<VenueTradeRecord[]>;
      }
    | undefined;
  fetchImpl?: typeof fetch;
  webSocketFactory?: ConstructorParameters<typeof PolymarketWebSocketClient>[0]['webSocketFactory'];
  heartbeatIntervalMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectMaxAttempts?: number;
  reconnectJitterRatio?: number;
  bootstrapTimeoutMs?: number;
  bootstrapCatchupDelayMs?: number;
}

function createDeferred(): BootstrapState['deferred'] {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { resolve, reject, promise };
}

export class UserWebSocketStateService {
  private static readonly DEFAULT_URL =
    'wss://ws-subscriptions-clob.polymarket.com/ws/user';

  private readonly logger = new AppLogger('UserWebSocketStateService');
  private readonly openOrders = new Map<string, UserStreamOrderProjection>();
  private readonly recentTrades = new Map<string, UserStreamTradeProjection>();
  private readonly desiredMarkets = new Map<string, UserStreamResolvedSubscription>();
  private readonly orderCursorById = new Map<string, OrderCursor>();
  private readonly tradeCursorById = new Map<string, TradeCursor>();
  private readonly fetchImpl: typeof fetch;
  private readonly gammaClient: GammaClient;
  private readonly bootstrapTimeoutMs: number;
  private readonly bootstrapCatchupDelayMs: number;

  private connectionStatus: UserWebSocketHealth['connectionStatus'] = 'idle';
  private lastEventAt: string | null = null;
  private lastTrafficAt: string | null = null;
  private lastReconciliationAt: string | null = null;
  private divergenceDetected = false;
  private trusted = false;
  private bootstrapFailureReason: string | null = null;
  private bootstrapState: BootstrapState | null = null;
  private generation = 0;
  private connection: PolymarketWebSocketClient | null = null;
  private needsBootstrapOnOpen = false;

  constructor(
    private readonly staleAfterMs: number,
    private readonly options: UserWebSocketStateServiceOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.gammaClient = new GammaClient(
      (options.gammaBaseUrl ?? 'https://gamma-api.polymarket.com').replace(/\/$/, ''),
      this.fetchImpl,
    );
    this.bootstrapTimeoutMs = options.bootstrapTimeoutMs ?? 8_000;
    this.bootstrapCatchupDelayMs = options.bootstrapCatchupDelayMs ?? 300;
  }

  async start(subscriptions: UserStreamMarketSubscription[] = []): Promise<UserWebSocketHealth> {
    const resolved = await this.resolveSubscriptions(subscriptions);
    this.replaceDesiredMarkets(resolved);
    this.bootstrapFailureReason = null;
    this.trusted = false;
    this.divergenceDetected = false;
    this.needsBootstrapOnOpen = resolved.length > 0;

    if (resolved.length === 0) {
      this.connectionStatus = 'idle';
      return this.evaluateHealth();
    }

    await this.ensureConnection();
    if (this.bootstrapState) {
      await this.bootstrapState.deferred.promise;
    } else if (!this.trusted) {
      await this.beginBootstrap();
    }
    return this.evaluateHealth();
  }

  async syncSubscriptions(
    subscriptions: UserStreamMarketSubscription[],
  ): Promise<UserWebSocketHealth> {
    const resolved = await this.resolveSubscriptions(subscriptions);
    const previous = new Map(this.desiredMarkets);
    this.replaceDesiredMarkets(resolved);

    if (resolved.length === 0) {
      this.stop();
      return this.evaluateHealth();
    }

    await this.ensureConnection();

    const nextConditionIds = new Set(resolved.map((entry) => entry.conditionId));
    const added = resolved.filter((entry) => !previous.has(entry.marketId));
    const removed = [...previous.values()].filter(
      (entry) => !nextConditionIds.has(entry.conditionId),
    );

    if (removed.length > 0) {
      await this.connection?.send({
        markets: removed.map((entry) => entry.conditionId),
        operation: 'unsubscribe',
      });
    }

    if (added.length > 0) {
      await this.connection?.send({
        markets: added.map((entry) => entry.conditionId),
        operation: 'subscribe',
      });
      await this.beginBootstrap();
    }

    return this.evaluateHealth();
  }

  markConnected(): void {
    this.connectionStatus = 'connected';
  }

  markDisconnected(reason: 'disconnected' | 'failed' = 'disconnected'): void {
    this.connectionStatus = reason;
    this.trusted = false;
  }

  stop(): void {
    this.connectionStatus = 'idle';
    this.trusted = false;
    this.bootstrapFailureReason = null;
    this.needsBootstrapOnOpen = false;
    this.cancelBootstrap('user_stream_stopped');
    void this.connection?.stop();
    this.connection = null;
  }

  applyOrderEvent(order: UserStreamOrderProjection): void {
    if (!this.shouldApplyOrder(order, `manual:${order.orderId}:${order.updatedAt}`)) {
      return;
    }

    this.openOrders.set(order.orderId, order);
    this.lastEventAt = order.updatedAt;
    if (this.isTerminal(order.status)) {
      this.openOrders.delete(order.orderId);
    }
  }

  applyTradeEvent(trade: UserStreamTradeProjection): void {
    if (!this.shouldApplyTrade(trade, `manual:${trade.tradeId}:${trade.filledAt}`)) {
      return;
    }

    this.recentTrades.set(trade.tradeId, trade);
    this.lastEventAt = trade.filledAt;
  }

  getOpenOrderIds(): string[] {
    return [...this.openOrders.keys()];
  }

  getTradeIds(): string[] {
    return [...this.recentTrades.keys()];
  }

  markReconciled(): void {
    this.divergenceDetected = false;
    this.lastReconciliationAt = new Date().toISOString();
  }

  detectDivergence(input: {
    openOrderIds: string[];
    tradeIds: string[];
  }): boolean {
    const liveOpenOrders = new Set(this.getOpenOrderIds());
    const liveTrades = new Set(this.getTradeIds());
    const restOpenOrders = new Set(input.openOrderIds);
    const restTrades = new Set(input.tradeIds);

    const openOrderMismatch =
      [...liveOpenOrders].some((id) => !restOpenOrders.has(id)) ||
      [...restOpenOrders].some((id) => !liveOpenOrders.has(id));
    const tradeMismatch =
      [...liveTrades].some((id) => !restTrades.has(id)) ||
      [...restTrades].some((id) => !liveTrades.has(id));

    this.divergenceDetected = openOrderMismatch || tradeMismatch;
    return this.divergenceDetected;
  }

  evaluateHealth(now = Date.now()): UserWebSocketHealth {
    const trafficStale =
      !this.lastTrafficAt ||
      now - new Date(this.lastTrafficAt).getTime() > this.staleAfterMs;

    return {
      healthy:
        this.connectionStatus === 'connected' &&
        this.trusted &&
        !trafficStale &&
        !this.divergenceDetected &&
        this.bootstrapFailureReason === null,
      reasonCode:
        this.connectionStatus !== 'connected'
          ? 'user_stream_disconnected'
          : this.bootstrapFailureReason
            ? this.bootstrapFailureReason
            : this.divergenceDetected
              ? 'user_stream_divergence_detected'
              : !this.trusted
                ? 'user_stream_bootstrap_pending'
                : trafficStale
                  ? 'user_stream_stale'
                  : null,
      connectionStatus: this.connectionStatus,
      lastEventAt: this.lastEventAt,
      lastTrafficAt: this.lastTrafficAt,
      openOrders: this.openOrders.size,
      recentTrades: this.recentTrades.size,
      divergenceDetected: this.divergenceDetected,
      lastReconciliationAt: this.lastReconciliationAt,
      trusted: this.trusted,
      subscribedMarkets: this.desiredMarkets.size,
      reconnectAttempt: this.connection?.getReconnectAttempt() ?? 0,
    };
  }

  private async ensureConnection(): Promise<void> {
    if (!this.options.auth) {
      throw new Error('user_stream_auth_missing');
    }

    if (!this.connection) {
      const url = (this.options.url ?? UserWebSocketStateService.DEFAULT_URL).trim();
      this.connection = new PolymarketWebSocketClient({
        name: 'user_stream',
        url,
        staleAfterMs: this.staleAfterMs,
        heartbeatIntervalMs: this.options.heartbeatIntervalMs,
        reconnectBaseDelayMs: this.options.reconnectBaseDelayMs,
        reconnectMaxDelayMs: this.options.reconnectMaxDelayMs,
        reconnectMaxAttempts: this.options.reconnectMaxAttempts,
        reconnectJitterRatio: this.options.reconnectJitterRatio,
        webSocketFactory: this.options.webSocketFactory,
        logger: {
          debug: (message, metadata) => this.logger.debug(message, metadata),
          log: (message, metadata) => this.logger.log(message, metadata),
          warn: (message, metadata) => this.logger.warn(message, metadata),
          error: (message, metadata) => this.logger.error(message, undefined, metadata),
        },
        getInitialSubscriptionMessage: async () => ({
          auth: this.options.auth,
          markets: [...this.desiredMarkets.values()].map((entry) => entry.conditionId),
          type: 'user',
        }),
        handlers: {
          onConnecting: () => {
            this.connectionStatus = 'connecting';
            this.trusted = false;
          },
          onOpen: async () => {
            this.connectionStatus = 'connected';
            this.trusted = false;
            if (this.needsBootstrapOnOpen && this.desiredMarkets.size > 0) {
              this.needsBootstrapOnOpen = false;
              void this.beginBootstrap().catch((error) => {
                this.bootstrapFailureReason =
                  error instanceof Error ? error.message : 'user_stream_bootstrap_failed';
              });
            }
          },
          onTraffic: async ({ receivedAt }) => {
            this.lastTrafficAt = receivedAt;
            if (this.bootstrapState) {
              this.bootstrapState.trafficObserved = true;
              void this.finalizeBootstrapIfReady(this.bootstrapState.generation);
            }
          },
          onMessage: async (payload, event) => {
            await this.handleMessagePayload(payload, event.receivedAt);
          },
          onClose: async () => {
            this.connectionStatus = 'disconnected';
            this.trusted = false;
            this.needsBootstrapOnOpen = this.desiredMarkets.size > 0;
            this.cancelBootstrap('user_stream_disconnected');
          },
          onStale: async () => {
            this.connectionStatus = 'disconnected';
            this.trusted = false;
          },
          onPermanentFailure: async (reasonCode) => {
            this.connectionStatus = 'failed';
            this.trusted = false;
            this.bootstrapFailureReason = reasonCode;
            this.cancelBootstrap(reasonCode);
          },
        },
      });
    }

    await this.connection.start();
  }

  private async beginBootstrap(): Promise<void> {
    if (!this.options.restClient) {
      throw new Error('user_stream_rest_client_missing');
    }

    this.cancelBootstrap('user_stream_bootstrap_replaced');
    this.generation += 1;
    this.bootstrapFailureReason = null;
    this.trusted = false;

    const restBefore = await this.fetchRestTruth();
    this.replaceFromRestTruth(restBefore);

    const generation = this.generation;
    const deferred = createDeferred();
    const timeoutHandle = setTimeout(() => {
      if (this.bootstrapState?.generation !== generation) {
        return;
      }
      const reasonCode = 'user_stream_bootstrap_timeout';
      this.bootstrapFailureReason = reasonCode;
      this.connectionStatus = 'failed';
      this.cancelBootstrap(reasonCode);
      void this.connection?.triggerReconnect(reasonCode);
    }, this.bootstrapTimeoutMs);

    this.bootstrapState = {
      generation,
      buffer: [],
      trafficObserved: false,
      finalizing: false,
      deferred,
      timeoutHandle,
    };

    if (this.connection?.getConnectionStatus() !== 'connected') {
      await this.connection?.start();
    }

    await deferred.promise;
  }

  private async finalizeBootstrapIfReady(generation: number): Promise<void> {
    if (
      !this.bootstrapState ||
      this.bootstrapState.generation !== generation ||
      !this.bootstrapState.trafficObserved ||
      this.bootstrapState.finalizing
    ) {
      return;
    }

    this.bootstrapState.finalizing = true;

    try {
      await this.sleep(this.bootstrapCatchupDelayMs);
      const restAfter = await this.fetchRestTruth();
      const cutoffAt = restAfter.capturedAt;
      const replayNow = this.bootstrapState.buffer.filter((event) => event.receivedAt <= cutoffAt);
      const replayLater = this.bootstrapState.buffer.filter((event) => event.receivedAt > cutoffAt);

      this.replaceFromRestTruth(restAfter);
      replayNow.sort((left, right) => left.eventAt.localeCompare(right.eventAt));
      for (const event of replayNow) {
        this.applyBufferedEvent(event);
      }

      const divergence = this.detectDivergence({
        openOrderIds: restAfter.openOrders
          .filter((order) => !this.isTerminal(order.status))
          .map((order) => order.orderId),
        tradeIds: restAfter.trades.map((trade) => trade.tradeId),
      });

      if (divergence) {
        const reasonCode = 'user_stream_divergence_detected';
        this.bootstrapFailureReason = reasonCode;
        this.connectionStatus = 'failed';
        this.cancelBootstrap(reasonCode);
        void this.connection?.triggerReconnect(reasonCode);
        return;
      }

      this.markReconciled();
      this.trusted = true;
      this.bootstrapFailureReason = null;
      this.connectionStatus = 'connected';

      clearTimeout(this.bootstrapState.timeoutHandle);
      this.bootstrapState.deferred.resolve();
      this.bootstrapState = null;

      for (const event of replayLater) {
        this.applyBufferedEvent(event);
      }
    } catch (error) {
      const reasonCode =
        error instanceof Error ? error.message : 'user_stream_bootstrap_failed';
      this.bootstrapFailureReason = reasonCode;
      this.connectionStatus = 'failed';
      this.cancelBootstrap(reasonCode);
      void this.connection?.triggerReconnect(reasonCode);
    }
  }

  private cancelBootstrap(reasonCode: string): void {
    if (!this.bootstrapState) {
      return;
    }

    clearTimeout(this.bootstrapState.timeoutHandle);
    this.bootstrapState.deferred.reject(new Error(reasonCode));
    this.bootstrapState = null;
  }

  private async fetchRestTruth(): Promise<UserRestTruth> {
    const capturedAt = new Date().toISOString();
    const [openOrders, trades] = await Promise.all([
      this.options.restClient?.getOpenOrders() ?? Promise.resolve([]),
      this.options.restClient?.getTrades() ?? Promise.resolve([]),
    ]);

    return {
      openOrders: openOrders.map((order) => this.mapRestOrder(order, capturedAt)),
      trades: trades.map((trade) => this.mapRestTrade(trade, capturedAt)),
      capturedAt,
    };
  }

  private replaceFromRestTruth(truth: UserRestTruth): void {
    this.openOrders.clear();
    this.recentTrades.clear();
    this.orderCursorById.clear();
    this.tradeCursorById.clear();

    for (const order of truth.openOrders) {
      if (!this.isTerminal(order.status)) {
        this.openOrders.set(order.orderId, order);
      }
      this.seedOrderCursor(order);
    }

    for (const trade of truth.trades) {
      this.recentTrades.set(trade.tradeId, trade);
      this.seedTradeCursor(trade);
    }

    this.lastReconciliationAt = truth.capturedAt;
  }

  private async handleMessagePayload(payload: unknown, receivedAt: string): Promise<void> {
    if (Array.isArray(payload)) {
      for (const item of payload) {
        await this.handleMessagePayload(item, receivedAt);
      }
      return;
    }

    const normalized = this.normalizeVenueEvent(payload, receivedAt);
    if (!normalized) {
      return;
    }

    this.lastEventAt = normalized.eventAt;
    if (this.bootstrapState) {
      this.bootstrapState.buffer.push(normalized);
      return;
    }

    this.applyBufferedEvent(normalized);
  }

  private applyBufferedEvent(event: BufferedUserEvent): void {
    if (event.kind === 'order' && event.order) {
      this.applyOrderEvent(event.order);
      return;
    }

    if (event.kind === 'trade' && event.trade) {
      this.applyTradeEvent(event.trade);
    }
  }

  private normalizeVenueEvent(payload: unknown, receivedAt: string): BufferedUserEvent | null {
    if (typeof payload !== 'object' || payload === null) {
      return null;
    }

    const record = payload as Record<string, unknown>;
    const eventType = this.readString(record.event_type)?.toLowerCase();
    if (eventType === 'order') {
      const orderId = this.readString(record.id);
      const tokenId = this.readString(record.asset_id) ?? this.readString(record.assetId);
      const conditionId = this.readString(record.market);
      const timestamp = this.parseTimestamp(
        record.last_update ?? record.timestamp ?? receivedAt,
      );
      if (!orderId || !tokenId) {
        return null;
      }
      const originalSize = this.parseNullableNumber(record.original_size ?? record.size);
      const sizeMatched = this.parseNullableNumber(record.size_matched) ?? 0;
      const remainingSize =
        originalSize != null ? Math.max(0, originalSize - sizeMatched) : Math.max(0, 0);
      const status =
        this.readString(record.status) ??
        this.mapOrderLifecycle(this.readString(record.type), remainingSize, sizeMatched);

      return {
        kind: 'order',
        receivedAt,
        eventAt: timestamp,
        eventKey: `order:${orderId}:${this.readString(record.type) ?? status}:${timestamp}`,
        order: {
          orderId,
          marketId: this.resolveMarketId(conditionId, tokenId),
          conditionId,
          tokenId,
          side: this.normalizeSide(record.side),
          status,
          price: this.parseNullableNumber(record.price) ?? 0,
          size: originalSize ?? remainingSize,
          remainingSize,
          updatedAt: timestamp,
        },
      };
    }

    if (eventType === 'trade') {
      const tradeId = this.readString(record.id);
      const tokenId = this.readString(record.asset_id) ?? this.readString(record.assetId);
      const conditionId = this.readString(record.market);
      const timestamp = this.parseTimestamp(
        record.last_update ?? record.matchtime ?? record.timestamp ?? receivedAt,
      );
      if (!tradeId || !tokenId) {
        return null;
      }

      return {
        kind: 'trade',
        receivedAt,
        eventAt: timestamp,
        eventKey: `trade:${tradeId}:${this.readString(record.status) ?? ''}:${timestamp}`,
        trade: {
          tradeId,
          marketId: this.resolveMarketId(conditionId, tokenId),
          conditionId,
          orderId:
            this.readString(record.taker_order_id) ??
            this.readString(record.order_id) ??
            null,
          tokenId,
          side: this.normalizeSide(record.side),
          price: this.parseNullableNumber(record.price) ?? 0,
          size: this.parseNullableNumber(record.size) ?? 0,
          fee: this.parseNullableNumber(record.fee) ?? this.parseNullableNumber(record.fees),
          status: this.readString(record.status),
          filledAt: timestamp,
        },
      };
    }

    return null;
  }

  private async resolveSubscriptions(
    subscriptions: UserStreamMarketSubscription[],
  ): Promise<UserStreamResolvedSubscription[]> {
    const normalized = new Map<string, UserStreamMarketSubscription>();
    for (const entry of subscriptions) {
      const marketId = entry.marketId.trim();
      if (marketId.length === 0) {
        continue;
      }
      normalized.set(marketId, {
        marketId,
        conditionId: entry.conditionId?.trim() ?? null,
        tokenIds: [...new Set((entry.tokenIds ?? []).map((tokenId) => tokenId.trim()).filter(Boolean))],
      });
    }

    const unresolved = [...normalized.values()].filter((entry) => !entry.conditionId);
    if (unresolved.length === 0) {
      return [...normalized.values()].map((entry) => ({
        marketId: entry.marketId,
        conditionId: entry.conditionId!,
        tokenIds: entry.tokenIds ?? [],
      }));
    }

    const catalog = await this.fetchGammaCatalog(new Set(normalized.keys()));
    const resolved: UserStreamResolvedSubscription[] = [];
    for (const entry of normalized.values()) {
      const matched =
        (entry.conditionId
          ? {
              marketId: entry.marketId,
              conditionId: entry.conditionId,
              tokenIds: entry.tokenIds ?? [],
            }
          : catalog.get(entry.marketId)) ?? null;
      if (!matched) {
        throw new Error(`user_stream_condition_id_missing:${entry.marketId}`);
      }
      resolved.push({
        marketId: matched.marketId,
        conditionId: matched.conditionId,
        tokenIds: matched.tokenIds.length > 0 ? matched.tokenIds : entry.tokenIds ?? [],
      });
    }

    return resolved;
  }

  private async fetchGammaCatalog(
    targetMarketIds: Set<string>,
  ): Promise<Map<string, UserStreamResolvedSubscription>> {
    const catalog = new Map<string, UserStreamResolvedSubscription>();
    let offset = 0;
    const limit = 200;

    while (catalog.size < targetMarketIds.size) {
      const result = await this.gammaClient.listMarketsDetailed({
        active: true,
        closed: false,
        limit,
        offset,
      });
      if (result.failures.length > 0 && result.markets.length === 0) {
        throw new Error('user_stream_gamma_lookup_parser_failed');
      }
      if (result.markets.length === 0) {
        break;
      }

      for (const market of result.markets) {
        if (!market.conditionId || !targetMarketIds.has(market.id)) {
          continue;
        }

        catalog.set(market.id, {
          marketId: market.id,
          conditionId: market.conditionId,
          tokenIds: [market.tokenIdYes, market.tokenIdNo],
        });
      }

      offset += limit;
    }

    return catalog;
  }

  private replaceDesiredMarkets(subscriptions: UserStreamResolvedSubscription[]): void {
    this.desiredMarkets.clear();
    for (const entry of subscriptions) {
      this.desiredMarkets.set(entry.marketId, entry);
    }
  }

  private resolveMarketId(conditionId: string | null, tokenId: string): string | null {
    if (conditionId) {
      for (const entry of this.desiredMarkets.values()) {
        if (entry.conditionId === conditionId) {
          return entry.marketId;
        }
      }
    }

    for (const entry of this.desiredMarkets.values()) {
      if (entry.tokenIds.includes(tokenId)) {
        return entry.marketId;
      }
    }

    return null;
  }

  private mapRestOrder(order: VenueOpenOrder, capturedAt: string): UserStreamOrderProjection {
    const updatedAt = this.parseTimestamp(order.createdAt ?? capturedAt);
    return {
      orderId: order.id,
      marketId: this.resolveMarketId(null, order.tokenId),
      conditionId: null,
      tokenId: order.tokenId,
      side: this.normalizeSide(order.side),
      status: order.status,
      price: order.price,
      size: order.size,
      remainingSize: Math.max(0, order.size - order.matchedSize),
      updatedAt,
    };
  }

  private mapRestTrade(trade: VenueTradeRecord, capturedAt: string): UserStreamTradeProjection {
    return {
      tradeId: trade.id,
      marketId: this.resolveMarketId(null, trade.tokenId),
      conditionId: null,
      orderId: trade.orderId,
      tokenId: trade.tokenId,
      side: this.normalizeSide(trade.side),
      price: trade.price,
      size: trade.size,
      fee: trade.fee,
      status: trade.status,
      filledAt: this.parseTimestamp(trade.filledAt ?? capturedAt),
    };
  }

  private shouldApplyOrder(order: UserStreamOrderProjection, eventKey: string): boolean {
    const observedAtMs = new Date(order.updatedAt).getTime();
    const phaseRank = this.orderPhaseRank(order.status);
    const cursor = this.orderCursorById.get(order.orderId) ?? {
      timestampMs: 0,
      phaseRank: 0,
      recentKeys: [],
    };

    if (cursor.recentKeys.includes(eventKey)) {
      return false;
    }

    if (observedAtMs < cursor.timestampMs) {
      return false;
    }

    if (observedAtMs === cursor.timestampMs && phaseRank < cursor.phaseRank) {
      return false;
    }

    cursor.timestampMs = Math.max(cursor.timestampMs, observedAtMs);
    cursor.phaseRank = Math.max(cursor.phaseRank, phaseRank);
    cursor.recentKeys.push(eventKey);
    if (cursor.recentKeys.length > 64) {
      cursor.recentKeys.shift();
    }
    this.orderCursorById.set(order.orderId, cursor);
    return true;
  }

  private shouldApplyTrade(trade: UserStreamTradeProjection, eventKey: string): boolean {
    const observedAtMs = new Date(trade.filledAt).getTime();
    const statusRank = this.tradeStatusRank(trade.status);
    const cursor = this.tradeCursorById.get(trade.tradeId) ?? {
      timestampMs: 0,
      statusRank: 0,
      recentKeys: [],
    };

    if (cursor.recentKeys.includes(eventKey)) {
      return false;
    }

    if (observedAtMs < cursor.timestampMs) {
      return false;
    }

    if (observedAtMs === cursor.timestampMs && statusRank < cursor.statusRank) {
      return false;
    }

    cursor.timestampMs = Math.max(cursor.timestampMs, observedAtMs);
    cursor.statusRank = Math.max(cursor.statusRank, statusRank);
    cursor.recentKeys.push(eventKey);
    if (cursor.recentKeys.length > 64) {
      cursor.recentKeys.shift();
    }
    this.tradeCursorById.set(trade.tradeId, cursor);
    return true;
  }

  private seedOrderCursor(order: UserStreamOrderProjection): void {
    this.orderCursorById.set(order.orderId, {
      timestampMs: new Date(order.updatedAt).getTime(),
      phaseRank: this.orderPhaseRank(order.status),
      recentKeys: [],
    });
  }

  private seedTradeCursor(trade: UserStreamTradeProjection): void {
    this.tradeCursorById.set(trade.tradeId, {
      timestampMs: new Date(trade.filledAt).getTime(),
      statusRank: this.tradeStatusRank(trade.status),
      recentKeys: [],
    });
  }

  private normalizeSide(value: unknown): 'BUY' | 'SELL' {
    return this.readString(value)?.toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
  }

  private mapOrderLifecycle(
    value: string | null,
    remainingSize: number,
    sizeMatched: number,
  ): string {
    const normalized = value?.trim().toUpperCase() ?? 'UNKNOWN';
    if (normalized === 'CANCELLATION') {
      return 'canceled';
    }
    if (remainingSize <= 0 && sizeMatched > 0) {
      return 'filled';
    }
    if (sizeMatched > 0) {
      return 'partially_filled';
    }
    if (normalized === 'PLACEMENT') {
      return 'open';
    }
    return normalized.toLowerCase();
  }

  private orderPhaseRank(status: string): number {
    const normalized = status.trim().toLowerCase();
    if (normalized === 'open') {
      return 1;
    }
    if (normalized === 'partially_filled') {
      return 2;
    }
    if (normalized === 'filled') {
      return 3;
    }
    if (normalized === 'canceled' || normalized === 'cancelled') {
      return 4;
    }
    if (normalized === 'expired') {
      return 5;
    }
    if (normalized === 'rejected') {
      return 6;
    }
    return 1;
  }

  private tradeStatusRank(status: string | null | undefined): number {
    const normalized = status?.trim().toUpperCase() ?? 'MATCHED';
    if (normalized === 'MATCHED') {
      return 1;
    }
    if (normalized === 'MINED') {
      return 2;
    }
    if (normalized === 'CONFIRMED') {
      return 3;
    }
    if (normalized === 'RETRYING') {
      return 4;
    }
    if (normalized === 'FAILED') {
      return 5;
    }
    return 1;
  }

  private isTerminal(status: string): boolean {
    const normalized = status.trim().toLowerCase();
    return (
      normalized === 'filled' ||
      normalized === 'canceled' ||
      normalized === 'cancelled' ||
      normalized === 'expired' ||
      normalized === 'rejected'
    );
  }

  private readString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private parseNullableNumber(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private parseTimestamp(value: unknown): string {
    if (typeof value === 'string' || typeof value === 'number') {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        return new Date(numeric > 1_000_000_000_000 ? numeric : numeric * 1_000).toISOString();
      }
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString();
      }
    }

    return new Date().toISOString();
  }

  private readTokenIds(record: Record<string, unknown>): string[] {
    const tokenIds = new Set<string>();
    const clobTokenIds = Array.isArray(record.clobTokenIds) ? record.clobTokenIds : [];
    for (const value of clobTokenIds) {
      const tokenId = this.readString(value);
      if (tokenId) {
        tokenIds.add(tokenId);
      }
    }

    const tokens = Array.isArray(record.tokens) ? record.tokens : [];
    for (const value of tokens) {
      if (typeof value !== 'object' || value === null) {
        continue;
      }
      const tokenRecord = value as Record<string, unknown>;
      const tokenId =
        this.readString(tokenRecord.token_id) ??
        this.readString(tokenRecord.tokenId) ??
        this.readString(tokenRecord.id);
      if (tokenId) {
        tokenIds.add(tokenId);
      }
    }

    return [...tokenIds];
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
