import {
  PolymarketSocketLogger,
  PolymarketWebSocketClient,
} from './polymarket-websocket-client';

export interface MarketLevel {
  price: number;
  size: number;
}

export interface MarketWebSocketAssetState {
  assetId: string;
  bidLevels: MarketLevel[];
  askLevels: MarketLevel[];
  bestBid: number | null;
  bestAsk: number | null;
  midpoint: number | null;
  spread: number | null;
  lastTrade: number | null;
  tickSize: number | null;
  lastUpdateAt: string | null;
  connectionStatus: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'failed';
  stale: boolean;
  metadataInvalidatedAt: string | null;
}

export interface MarketWebSocketHealth {
  healthy: boolean;
  reasonCode: string | null;
  connectionStatus: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'failed';
  trackedAssets: number;
  staleAssets: string[];
  metadataInvalidations: string[];
  lastEventAt: string | null;
  lastTrafficAt: string | null;
  bootstrapCompletedAt: string | null;
  trusted: boolean;
  reconnectAttempt: number;
}

interface MarketRestSnapshot {
  assetId: string;
  bidLevels: MarketLevel[];
  askLevels: MarketLevel[];
  tickSize: number | null;
  minOrderSize: number | null;
  negRisk: boolean | null;
  lastTrade: number | null;
  hash: string | null;
  observedAt: string;
}

interface MarketBootstrapState {
  generation: number;
  restSnapshots: Map<string, MarketRestSnapshot>;
  awaitingAssets: Set<string>;
  deferred: {
    resolve: () => void;
    reject: (error: Error) => void;
    promise: Promise<void>;
  };
  timeoutHandle: NodeJS.Timeout;
}

interface MarketMessageCursor {
  lastTimestampMs: number;
  recentEventKeys: string[];
}

export interface MarketWebSocketStateServiceOptions {
  url?: string | null;
  restBaseUrl?: string | null;
  fetchImpl?: typeof fetch;
  webSocketFactory?: ConstructorParameters<typeof PolymarketWebSocketClient>[0]['webSocketFactory'];
  heartbeatIntervalMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectMaxAttempts?: number;
  reconnectJitterRatio?: number;
  bootstrapTimeoutMs?: number;
  restTimeoutMs?: number;
  customFeatureEnabled?: boolean;
  logger?: PolymarketSocketLogger;
}

function createDeferred(): MarketBootstrapState['deferred'] {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { resolve, reject, promise };
}

export class MarketWebSocketStateService {
  private static readonly DEFAULT_URL =
    'wss://ws-subscriptions-clob.polymarket.com/ws/market';

  private readonly assets = new Map<string, MarketWebSocketAssetState>();
  private readonly fetchImpl: typeof fetch;
  private readonly bootstrapTimeoutMs: number;
  private readonly restTimeoutMs: number;
  private readonly customFeatureEnabled: boolean;
  private readonly logger: PolymarketSocketLogger;
  private readonly trackedAssetIds = new Set<string>();
  private readonly messageCursorByAsset = new Map<string, MarketMessageCursor>();

  private connectionStatus: MarketWebSocketHealth['connectionStatus'] = 'idle';
  private lastEventAt: string | null = null;
  private lastTrafficAt: string | null = null;
  private bootstrapCompletedAt: string | null = null;
  private trusted = false;
  private bootstrapFailureReason: string | null = null;
  private connection: PolymarketWebSocketClient | null = null;
  private bootstrapState: MarketBootstrapState | null = null;
  private generation = 0;
  private needsBootstrapOnOpen = false;

  constructor(
    private readonly staleAfterMs: number,
    private readonly options: MarketWebSocketStateServiceOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.bootstrapTimeoutMs = options.bootstrapTimeoutMs ?? 8_000;
    this.restTimeoutMs = options.restTimeoutMs ?? 6_000;
    this.customFeatureEnabled = options.customFeatureEnabled ?? true;
    this.logger = options.logger ?? {};
  }

  async start(assetIds: string[]): Promise<MarketWebSocketHealth> {
    const normalizedAssetIds = this.normalizeAssetIds(assetIds);
    this.updateTrackedAssets(normalizedAssetIds);
    this.bootstrapFailureReason = null;
    this.trusted = false;
    this.bootstrapCompletedAt = null;
    this.needsBootstrapOnOpen = normalizedAssetIds.length > 0;

    if (normalizedAssetIds.length === 0) {
      this.connectionStatus = 'idle';
      return this.evaluateHealth();
    }

    await this.ensureConnection();
    if (this.bootstrapState) {
      await this.bootstrapState.deferred.promise;
    } else if (!this.trusted) {
      await this.beginBootstrap(normalizedAssetIds);
    }
    return this.evaluateHealth();
  }

  async syncSubscriptions(assetIds: string[]): Promise<MarketWebSocketHealth> {
    const normalizedAssetIds = this.normalizeAssetIds(assetIds);
    const previous = new Set(this.trackedAssetIds);
    const next = new Set(normalizedAssetIds);
    const added = normalizedAssetIds.filter((assetId) => !previous.has(assetId));
    const removed = [...previous].filter((assetId) => !next.has(assetId));

    this.updateTrackedAssets(normalizedAssetIds);

    if (normalizedAssetIds.length === 0) {
      this.stop();
      return this.evaluateHealth();
    }

    await this.ensureConnection();

    if (removed.length > 0) {
      await this.connection?.send({
        assets_ids: removed,
        operation: 'unsubscribe',
      });
    }

    if (added.length > 0) {
      await this.connection?.send({
        assets_ids: added,
        operation: 'subscribe',
        custom_feature_enabled: this.customFeatureEnabled,
        initial_dump: true,
      });
      await this.beginBootstrap(added);
    }

    return this.evaluateHealth();
  }

  markConnected(): void {
    this.connectionStatus = 'connected';
    for (const asset of this.assets.values()) {
      asset.connectionStatus = 'connected';
    }
  }

  markDisconnected(reason: 'disconnected' | 'failed' = 'disconnected'): void {
    this.connectionStatus = reason;
    this.trusted = false;
    for (const asset of this.assets.values()) {
      asset.connectionStatus = reason;
    }
  }

  stop(): void {
    this.connectionStatus = 'idle';
    this.trusted = false;
    this.bootstrapFailureReason = null;
    this.bootstrapCompletedAt = null;
    this.needsBootstrapOnOpen = false;
    this.cancelBootstrap('market_stream_stopped');
    void this.connection?.stop();
    this.connection = null;
    for (const asset of this.assets.values()) {
      asset.connectionStatus = 'idle';
    }
  }

  updateTrackedAssets(assetIds: string[]): void {
    const normalized = new Set(this.normalizeAssetIds(assetIds));
    this.trackedAssetIds.clear();
    for (const assetId of normalized) {
      this.trackedAssetIds.add(assetId);
      if (!this.assets.has(assetId)) {
        this.assets.set(assetId, this.createEmptyAssetState(assetId));
      }
    }

    for (const assetId of [...this.assets.keys()]) {
      if (!normalized.has(assetId)) {
        this.assets.delete(assetId);
        this.messageCursorByAsset.delete(assetId);
      }
    }
  }

  applySnapshot(input: {
    assetId: string;
    bidLevels: MarketLevel[];
    askLevels: MarketLevel[];
    lastTrade?: number | null;
    tickSize?: number | null;
    observedAt?: string;
  }): void {
    const asset = this.getAsset(input.assetId);
    asset.bidLevels = [...input.bidLevels];
    asset.askLevels = [...input.askLevels];
    asset.bestBid = input.bidLevels[0]?.price ?? null;
    asset.bestAsk = input.askLevels[0]?.price ?? null;
    asset.midpoint =
      asset.bestBid !== null && asset.bestAsk !== null
        ? (asset.bestBid + asset.bestAsk) / 2
        : null;
    asset.spread =
      asset.bestBid !== null && asset.bestAsk !== null
        ? Math.max(0, asset.bestAsk - asset.bestBid)
        : null;
    asset.lastTrade = input.lastTrade ?? asset.lastTrade;

    if (input.tickSize !== undefined && asset.tickSize !== null && asset.tickSize !== input.tickSize) {
      asset.metadataInvalidatedAt = new Date().toISOString();
    }

    asset.tickSize = input.tickSize ?? asset.tickSize;
    asset.lastUpdateAt = input.observedAt ?? new Date().toISOString();
    asset.connectionStatus = 'connected';
    asset.stale = false;
    this.lastEventAt = asset.lastUpdateAt;
    this.connectionStatus = 'connected';
  }

  applyLastTrade(assetId: string, price: number, observedAt = new Date().toISOString()): void {
    const asset = this.getAsset(assetId);
    asset.lastTrade = price;
    asset.lastUpdateAt = observedAt;
    asset.stale = false;
    this.lastEventAt = observedAt;
  }

  applyTickSizeChange(
    assetId: string,
    tickSize: number | null,
    observedAt = new Date().toISOString(),
  ): void {
    const asset = this.getAsset(assetId);
    if (asset.tickSize !== tickSize) {
      asset.metadataInvalidatedAt = observedAt;
    }
    asset.tickSize = tickSize;
    asset.lastUpdateAt = observedAt;
    asset.stale = false;
    this.lastEventAt = observedAt;
  }

  getAssetState(assetId: string): MarketWebSocketAssetState | null {
    return this.assets.get(assetId) ?? null;
  }

  evaluateHealth(now = Date.now()): MarketWebSocketHealth {
    const staleAssets: string[] = [];
    const metadataInvalidations: string[] = [];
    const trafficStale =
      !this.lastTrafficAt ||
      now - new Date(this.lastTrafficAt).getTime() > this.staleAfterMs;

    for (const asset of this.assets.values()) {
      const stale =
        !asset.lastUpdateAt ||
        now - new Date(asset.lastUpdateAt).getTime() > this.staleAfterMs;
      asset.stale = stale;
      if (stale) {
        staleAssets.push(asset.assetId);
      }
      if (asset.metadataInvalidatedAt) {
        metadataInvalidations.push(asset.assetId);
      }
    }

    return {
      healthy:
        this.connectionStatus === 'connected' &&
        this.trusted &&
        !trafficStale &&
        staleAssets.length === 0 &&
        metadataInvalidations.length === 0 &&
        this.bootstrapFailureReason === null,
      reasonCode:
        this.connectionStatus !== 'connected'
          ? 'market_stream_disconnected'
          : this.bootstrapFailureReason
            ? this.bootstrapFailureReason
            : !this.trusted
              ? 'market_stream_bootstrap_pending'
              : trafficStale
                ? 'market_stream_stale'
                : staleAssets.length > 0
                  ? 'market_stream_stale'
                  : metadataInvalidations.length > 0
                    ? 'market_metadata_invalidated'
                    : null,
      connectionStatus: this.connectionStatus,
      trackedAssets: this.assets.size,
      staleAssets,
      metadataInvalidations,
      lastEventAt: this.lastEventAt,
      lastTrafficAt: this.lastTrafficAt,
      bootstrapCompletedAt: this.bootstrapCompletedAt,
      trusted: this.trusted,
      reconnectAttempt: this.connection?.getReconnectAttempt() ?? 0,
    };
  }

  private async ensureConnection(): Promise<void> {
    if (this.connection) {
      this.connectionStatus = this.connection.getConnectionStatus();
      await this.connection.start();
      return;
    }

    const url = (this.options.url ?? MarketWebSocketStateService.DEFAULT_URL).trim();
    this.connection = new PolymarketWebSocketClient({
      name: 'market_stream',
      url,
      staleAfterMs: this.staleAfterMs,
      heartbeatIntervalMs: this.options.heartbeatIntervalMs,
      reconnectBaseDelayMs: this.options.reconnectBaseDelayMs,
      reconnectMaxDelayMs: this.options.reconnectMaxDelayMs,
      reconnectMaxAttempts: this.options.reconnectMaxAttempts,
      reconnectJitterRatio: this.options.reconnectJitterRatio,
      webSocketFactory: this.options.webSocketFactory,
      logger: this.logger,
      getInitialSubscriptionMessage: async () => ({
        assets_ids: [...this.trackedAssetIds],
        type: 'market',
        custom_feature_enabled: this.customFeatureEnabled,
        initial_dump: true,
      }),
      handlers: {
        onConnecting: () => {
          this.connectionStatus = 'connecting';
          this.trusted = false;
          for (const asset of this.assets.values()) {
            asset.connectionStatus = 'connecting';
          }
        },
        onOpen: async () => {
          this.connectionStatus = 'connected';
          this.trusted = false;
          for (const asset of this.assets.values()) {
            asset.connectionStatus = 'connected';
          }
          if (this.needsBootstrapOnOpen && this.trackedAssetIds.size > 0) {
            this.needsBootstrapOnOpen = false;
            void this.beginBootstrap([...this.trackedAssetIds]).catch((error) => {
              this.bootstrapFailureReason =
                error instanceof Error ? error.message : 'market_stream_bootstrap_failed';
            });
          }
        },
        onTraffic: ({ receivedAt }) => {
          this.lastTrafficAt = receivedAt;
        },
        onMessage: async (payload, trafficEvent) => {
          await this.handleMessagePayload(payload, trafficEvent.receivedAt);
        },
        onClose: async () => {
          this.connectionStatus = 'disconnected';
          this.trusted = false;
          this.needsBootstrapOnOpen = this.trackedAssetIds.size > 0;
          this.cancelBootstrap('market_stream_disconnected');
          for (const asset of this.assets.values()) {
            asset.connectionStatus = 'disconnected';
          }
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
          for (const asset of this.assets.values()) {
            asset.connectionStatus = 'failed';
          }
        },
      },
    });

    await this.connection.start();
  }

  private async beginBootstrap(assetIds: string[]): Promise<void> {
    const normalizedAssetIds = this.normalizeAssetIds(assetIds);
    if (normalizedAssetIds.length === 0) {
      this.trusted = false;
      this.bootstrapCompletedAt = null;
      return;
    }

    this.cancelBootstrap('market_stream_bootstrap_replaced');

    this.generation += 1;
    this.trusted = false;
    this.bootstrapCompletedAt = null;
    this.bootstrapFailureReason = null;

    const restSnapshots = await this.fetchRestTruth(normalizedAssetIds);
    const deferred = createDeferred();
    const generation = this.generation;
    const timeoutHandle = setTimeout(() => {
      if (this.bootstrapState?.generation !== generation) {
        return;
      }
      const reasonCode = 'market_stream_bootstrap_timeout';
      this.bootstrapFailureReason = reasonCode;
      this.connectionStatus = 'failed';
      this.cancelBootstrap(reasonCode);
      void this.connection?.triggerReconnect(reasonCode);
    }, this.bootstrapTimeoutMs);

    this.bootstrapState = {
      generation,
      restSnapshots,
      awaitingAssets: new Set(normalizedAssetIds),
      deferred,
      timeoutHandle,
    };

    if (this.connection?.getConnectionStatus() !== 'connected') {
      await this.connection?.start();
    }

    await deferred.promise;
  }

  private cancelBootstrap(reasonCode: string): void {
    if (!this.bootstrapState) {
      return;
    }

    clearTimeout(this.bootstrapState.timeoutHandle);
    this.bootstrapState.deferred.reject(new Error(reasonCode));
    this.bootstrapState = null;
  }

  private completeBootstrap(generation: number): void {
    if (!this.bootstrapState || this.bootstrapState.generation !== generation) {
      return;
    }

    clearTimeout(this.bootstrapState.timeoutHandle);
    this.bootstrapState.deferred.resolve();
    this.bootstrapState = null;
    this.trusted = true;
    this.bootstrapFailureReason = null;
    this.bootstrapCompletedAt = new Date().toISOString();
    this.connectionStatus = 'connected';
    for (const asset of this.assets.values()) {
      asset.connectionStatus = 'connected';
    }
  }

  private async fetchRestTruth(assetIds: string[]): Promise<Map<string, MarketRestSnapshot>> {
    const snapshots = await Promise.all(
      assetIds.map(async (assetId) => [assetId, await this.fetchOrderbook(assetId)] as const),
    );
    const result = new Map<string, MarketRestSnapshot>();
    for (const [assetId, snapshot] of snapshots) {
      result.set(assetId, snapshot);
      this.applySnapshot({
        assetId,
        bidLevels: snapshot.bidLevels,
        askLevels: snapshot.askLevels,
        lastTrade: snapshot.lastTrade,
        tickSize: snapshot.tickSize,
        observedAt: snapshot.observedAt,
      });
    }
    return result;
  }

  private async fetchOrderbook(assetId: string): Promise<MarketRestSnapshot> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.restTimeoutMs);

    try {
      const baseUrl = (this.options.restBaseUrl ?? 'https://clob.polymarket.com').replace(/\/$/, '');
      const response = await this.fetchImpl(
        `${baseUrl}/book?token_id=${encodeURIComponent(assetId)}`,
        {
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new Error(`market_stream_rest_bootstrap_http_${response.status}`);
      }

      const payload = (await response.json()) as Record<string, unknown>;
      return {
        assetId,
        bidLevels: this.parseLevels(payload.bids, 'bid'),
        askLevels: this.parseLevels(payload.asks, 'ask'),
        tickSize: this.parseNullableNumber(payload.tick_size ?? payload.tickSize),
        minOrderSize: this.parseNullableNumber(payload.min_order_size ?? payload.minOrderSize),
        negRisk:
          typeof (payload.neg_risk ?? payload.negRisk) === 'boolean'
            ? Boolean(payload.neg_risk ?? payload.negRisk)
            : null,
        lastTrade: this.parseNullableNumber(payload.last_trade_price ?? payload.lastTradePrice),
        hash: this.readString(payload.hash),
        observedAt: new Date().toISOString(),
      };
    } catch (error) {
      const reasonCode =
        error instanceof Error ? error.message : 'market_stream_bootstrap_rest_failed';
      throw new Error(reasonCode);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async handleMessagePayload(payload: unknown, receivedAt: string): Promise<void> {
    if (Array.isArray(payload)) {
      for (const item of payload) {
        await this.handleMessagePayload(item, receivedAt);
      }
      return;
    }

    if (typeof payload !== 'object' || payload === null) {
      return;
    }

    const message = payload as Record<string, unknown>;
    const eventType = this.readString(message.event_type) ?? this.readString(message.eventType);
    if (!eventType) {
      return;
    }

    if (eventType === 'book') {
      const assetId = this.readString(message.asset_id) ?? this.readString(message.assetId);
      if (!assetId || !this.trackedAssetIds.has(assetId)) {
        return;
      }

      const observedAt = this.parseTimestamp(
        message.timestamp ?? message.last_update ?? receivedAt,
      );
      const eventKey = `${eventType}:${assetId}:${this.readString(message.hash) ?? observedAt}`;
      if (!this.shouldApplyEvent(assetId, observedAt, eventKey)) {
        return;
      }

      this.applySnapshot({
        assetId,
        bidLevels: this.parseLevels(message.bids, 'bid'),
        askLevels: this.parseLevels(message.asks, 'ask'),
        observedAt,
      });
      this.handleBootstrapSnapshot(assetId);
      return;
    }

    if (eventType === 'price_change') {
      const observedAt = this.parseTimestamp(message.timestamp ?? receivedAt);
      const changes = Array.isArray(message.price_changes) ? message.price_changes : [];
      for (const change of changes) {
        if (typeof change !== 'object' || change === null) {
          continue;
        }
        const record = change as Record<string, unknown>;
        const assetId = this.readString(record.asset_id) ?? this.readString(record.assetId);
        if (!assetId || !this.trackedAssetIds.has(assetId)) {
          continue;
        }
        const sideValue = this.readString(record.side)?.toUpperCase();
        const price = this.parseNullableNumber(record.price);
        const size = this.parseNullableNumber(record.size);
        if (!price && price !== 0) {
          continue;
        }
        if (!size && size !== 0) {
          continue;
        }
        const hash = this.readString(record.hash);
        const eventKey = `${eventType}:${assetId}:${hash ?? `${sideValue}:${price}:${size}:${observedAt}`}`;
        if (!this.shouldApplyEvent(assetId, observedAt, eventKey)) {
          continue;
        }
        this.applyPriceLevelDelta(assetId, {
          side: sideValue === 'SELL' ? 'SELL' : 'BUY',
          price,
          size,
          bestBid: this.parseNullableNumber(record.best_bid),
          bestAsk: this.parseNullableNumber(record.best_ask),
          observedAt,
        });
      }
      return;
    }

    if (eventType === 'tick_size_change') {
      const assetId = this.readString(message.asset_id) ?? this.readString(message.assetId);
      if (!assetId || !this.trackedAssetIds.has(assetId)) {
        return;
      }
      const observedAt = this.parseTimestamp(message.timestamp ?? receivedAt);
      const eventKey = `${eventType}:${assetId}:${observedAt}`;
      if (!this.shouldApplyEvent(assetId, observedAt, eventKey)) {
        return;
      }
      this.applyTickSizeChange(
        assetId,
        this.parseNullableNumber(message.new_tick_size ?? message.tick_size),
        observedAt,
      );
      return;
    }

    if (eventType === 'last_trade_price') {
      const assetId = this.readString(message.asset_id) ?? this.readString(message.assetId);
      if (!assetId || !this.trackedAssetIds.has(assetId)) {
        return;
      }
      const observedAt = this.parseTimestamp(message.timestamp ?? receivedAt);
      const eventKey = `${eventType}:${assetId}:${observedAt}:${this.readString(message.side) ?? ''}`;
      if (!this.shouldApplyEvent(assetId, observedAt, eventKey)) {
        return;
      }
      const price = this.parseNullableNumber(message.price);
      if (price == null) {
        return;
      }
      this.applyLastTrade(assetId, price, observedAt);
      return;
    }

    if (eventType === 'best_bid_ask') {
      const assetId = this.readString(message.asset_id) ?? this.readString(message.assetId);
      if (!assetId || !this.trackedAssetIds.has(assetId)) {
        return;
      }
      const observedAt = this.parseTimestamp(message.timestamp ?? receivedAt);
      const eventKey = `${eventType}:${assetId}:${observedAt}`;
      if (!this.shouldApplyEvent(assetId, observedAt, eventKey)) {
        return;
      }
      this.applyBestBidAsk(assetId, {
        bestBid: this.parseNullableNumber(message.best_bid),
        bestAsk: this.parseNullableNumber(message.best_ask),
        observedAt,
      });
    }
  }

  private handleBootstrapSnapshot(assetId: string): void {
    if (!this.bootstrapState || !this.bootstrapState.awaitingAssets.has(assetId)) {
      return;
    }

    const restSnapshot = this.bootstrapState.restSnapshots.get(assetId) ?? null;
    const streamSnapshot = this.assets.get(assetId) ?? null;
    if (!streamSnapshot) {
      return;
    }

    if (this.isBootstrapDivergent(restSnapshot, streamSnapshot)) {
      const reasonCode = 'market_stream_bootstrap_divergence';
      this.bootstrapFailureReason = reasonCode;
      this.connectionStatus = 'failed';
      this.cancelBootstrap(reasonCode);
      void this.connection?.triggerReconnect(reasonCode);
      return;
    }

    this.bootstrapState.awaitingAssets.delete(assetId);
    if (this.bootstrapState.awaitingAssets.size === 0) {
      this.completeBootstrap(this.bootstrapState.generation);
    }
  }

  private isBootstrapDivergent(
    restSnapshot: MarketRestSnapshot | null,
    streamSnapshot: MarketWebSocketAssetState,
  ): boolean {
    if (!restSnapshot) {
      return false;
    }

    const restHasDepth = restSnapshot.bidLevels.length > 0 || restSnapshot.askLevels.length > 0;
    const streamHasDepth =
      streamSnapshot.bidLevels.length > 0 || streamSnapshot.askLevels.length > 0;

    if (restHasDepth !== streamHasDepth) {
      return true;
    }

    const topBidDiff =
      restSnapshot.bidLevels[0] && streamSnapshot.bidLevels[0]
        ? Math.abs(restSnapshot.bidLevels[0].price - streamSnapshot.bidLevels[0].price)
        : 0;
    const topAskDiff =
      restSnapshot.askLevels[0] && streamSnapshot.askLevels[0]
        ? Math.abs(restSnapshot.askLevels[0].price - streamSnapshot.askLevels[0].price)
        : 0;

    return topBidDiff > 0.25 || topAskDiff > 0.25;
  }

  private applyPriceLevelDelta(
    assetId: string,
    input: {
      side: 'BUY' | 'SELL';
      price: number;
      size: number;
      bestBid: number | null;
      bestAsk: number | null;
      observedAt: string;
    },
  ): void {
    const asset = this.getAsset(assetId);
    const levels = input.side === 'BUY' ? asset.bidLevels : asset.askLevels;
    const existingIndex = levels.findIndex((level) => level.price === input.price);

    if (input.size === 0) {
      if (existingIndex >= 0) {
        levels.splice(existingIndex, 1);
      }
    } else if (existingIndex >= 0) {
      levels[existingIndex] = {
        price: input.price,
        size: input.size,
      };
    } else {
      levels.push({
        price: input.price,
        size: input.size,
      });
    }

    asset.bidLevels.sort((left, right) => right.price - left.price);
    asset.askLevels.sort((left, right) => left.price - right.price);
    asset.bestBid = input.bestBid ?? asset.bidLevels[0]?.price ?? null;
    asset.bestAsk = input.bestAsk ?? asset.askLevels[0]?.price ?? null;
    asset.midpoint =
      asset.bestBid !== null && asset.bestAsk !== null
        ? (asset.bestBid + asset.bestAsk) / 2
        : null;
    asset.spread =
      asset.bestBid !== null && asset.bestAsk !== null
        ? Math.max(0, asset.bestAsk - asset.bestBid)
        : null;
    asset.lastUpdateAt = input.observedAt;
    asset.connectionStatus = 'connected';
    asset.stale = false;
    this.lastEventAt = input.observedAt;
  }

  private applyBestBidAsk(
    assetId: string,
    input: {
      bestBid: number | null;
      bestAsk: number | null;
      observedAt: string;
    },
  ): void {
    const asset = this.getAsset(assetId);
    asset.bestBid = input.bestBid;
    asset.bestAsk = input.bestAsk;
    asset.midpoint =
      asset.bestBid !== null && asset.bestAsk !== null
        ? (asset.bestBid + asset.bestAsk) / 2
        : null;
    asset.spread =
      asset.bestBid !== null && asset.bestAsk !== null
        ? Math.max(0, asset.bestAsk - asset.bestBid)
        : null;
    asset.lastUpdateAt = input.observedAt;
    asset.connectionStatus = 'connected';
    asset.stale = false;
    this.lastEventAt = input.observedAt;
  }

  private shouldApplyEvent(assetId: string, observedAt: string, eventKey: string): boolean {
    const observedAtMs = new Date(observedAt).getTime();
    const cursor = this.messageCursorByAsset.get(assetId) ?? {
      lastTimestampMs: 0,
      recentEventKeys: [],
    };

    if (cursor.recentEventKeys.includes(eventKey)) {
      return false;
    }

    if (observedAtMs < cursor.lastTimestampMs) {
      return false;
    }

    cursor.lastTimestampMs = Math.max(cursor.lastTimestampMs, observedAtMs);
    cursor.recentEventKeys.push(eventKey);
    if (cursor.recentEventKeys.length > 64) {
      cursor.recentEventKeys.shift();
    }
    this.messageCursorByAsset.set(assetId, cursor);
    return true;
  }

  private parseLevels(raw: unknown, side: 'bid' | 'ask'): MarketLevel[] {
    if (!Array.isArray(raw)) {
      return [];
    }

    const levels = raw
      .map((entry) => {
        if (typeof entry !== 'object' || entry === null) {
          return null;
        }

        const record = entry as Record<string, unknown>;
        const price = this.parseNullableNumber(record.price ?? record.p);
        const size = this.parseNullableNumber(record.size ?? record.s);
        if (price == null || size == null || size <= 0 || price < 0 || price > 1) {
          return null;
        }

        return { price, size };
      })
      .filter((level): level is MarketLevel => level !== null);

    levels.sort((left, right) =>
      side === 'bid' ? right.price - left.price : left.price - right.price,
    );
    return levels;
  }

  private parseNullableNumber(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private readString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
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

  private normalizeAssetIds(assetIds: string[]): string[] {
    return [...new Set(assetIds.map((assetId) => assetId.trim()).filter((assetId) => assetId.length > 0))];
  }

  private getAsset(assetId: string): MarketWebSocketAssetState {
    if (!this.assets.has(assetId)) {
      this.assets.set(assetId, this.createEmptyAssetState(assetId));
    }

    return this.assets.get(assetId)!;
  }

  private createEmptyAssetState(assetId: string): MarketWebSocketAssetState {
    return {
      assetId,
      bidLevels: [],
      askLevels: [],
      bestBid: null,
      bestAsk: null,
      midpoint: null,
      spread: null,
      lastTrade: null,
      tickSize: null,
      lastUpdateAt: null,
      connectionStatus: this.connectionStatus,
      stale: false,
      metadataInvalidatedAt: null,
    };
  }
}
