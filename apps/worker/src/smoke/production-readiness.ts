import { PrismaClient } from '@prisma/client';
import { appEnv } from '@worker/config/env';
import { ExternalPortfolioService } from '@worker/portfolio/external-portfolio.service';
import { RuntimeControlRepository } from '@worker/runtime/runtime-control.repository';
import {
  buildCapitalExposureValidationReport,
  persistCapitalExposureValidationReport,
} from '@worker/runtime/capital-exposure-validation';
import { evaluateReadinessObserver } from '@worker/runtime/readiness-observer';
import { loadLatestLifecycleValidationEvidence } from '@worker/validation/live-order-lifecycle-validation';
import {
  UserStreamMarketSubscription,
  UserWebSocketStateService,
} from '@worker/runtime/user-websocket-state.service';
import {
  MarketWebSocketHealth,
  MarketWebSocketStateService,
  PolymarketSocket,
} from '@polymarket-btc-5m-agentic-bot/market-data';
import {
  OfficialPolymarketTradingClient,
  VenueOpenOrder,
  VenueTradeRecord,
} from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';
import {
  parsePolymarketSmokeEnv,
  PolymarketSmokeResult,
  runPolymarketAuthenticatedSmoke,
} from './polymarket-auth-smoke';

interface ActiveMarketRecord {
  id: string;
  tokenIdYes: string | null;
  tokenIdNo: string | null;
}

interface RuntimeControlLike {
  recordReconciliationCheckpoint: (input: {
    cycleKey: string;
    source: string;
    status: string;
    details?: Record<string, unknown>;
  }) => Promise<void>;
}

interface PrismaLike {
  $connect?: () => Promise<void>;
  $disconnect?: () => Promise<void>;
  market: {
    findMany: (...args: any[]) => Promise<ActiveMarketRecord[]>;
  };
  fill?: {
    findMany: (...args: any[]) => Promise<Array<{ price: number; size: number; filledAt: Date | string }>>;
  };
  reconciliationCheckpoint?: {
    findMany: (...args: any[]) => Promise<Array<Record<string, unknown>>>;
  };
}

interface TradingClientLike {
  getOpenOrders: () => Promise<VenueOpenOrder[]>;
  getTrades: () => Promise<VenueTradeRecord[]>;
}

export interface ProductionReadinessStepResult {
  name: string;
  ok: boolean;
  reasonCode: string | null;
  evidence: Record<string, unknown>;
}

export interface ProductionReadinessResult {
  success: boolean;
  executedAt: string;
  steps: ProductionReadinessStepResult[];
}

export interface ForcedDisconnectProbe {
  connections: number;
  forcedDisconnects: number;
  inboundFrames: number;
  inboundMessages: number;
  inboundHeartbeats: number;
}

export interface ProductionReadinessOptions {
  prisma?: PrismaLike;
  runtimeControl?: RuntimeControlLike;
  marketStreamService?: MarketWebSocketStateService;
  userStreamService?: UserWebSocketStateService;
  reconnectMarketStreamService?:
    | MarketWebSocketStateService
    | { service: MarketWebSocketStateService; probe: ForcedDisconnectProbe };
  reconnectUserStreamService?:
    | UserWebSocketStateService
    | { service: UserWebSocketStateService; probe: ForcedDisconnectProbe };
  externalPortfolioService?: Pick<ExternalPortfolioService, 'capture'>;
  tradingClient?: OfficialPolymarketTradingClient;
  smokeRunner?: () => Promise<PolymarketSmokeResult>;
  trackedMarkets?: ActiveMarketRecord[];
  fetchImpl?: typeof fetch;
  executeAt?: string;
  connectPrisma?: boolean;
}

interface LifecycleObservation {
  appearedOrderId: string | null;
  disappearedAfterAppearance: boolean;
  newTradeIds: string[];
  streamEventAdvanced: boolean;
}

function passStep(
  name: string,
  evidence: Record<string, unknown>,
): ProductionReadinessStepResult {
  return {
    name,
    ok: true,
    reasonCode: null,
    evidence,
  };
}

function failStep(
  name: string,
  reasonCode: string,
  evidence: Record<string, unknown> = {},
): ProductionReadinessStepResult {
  return {
    name,
    ok: false,
    reasonCode,
    evidence,
  };
}

function ageMs(timestamp: string | null, now = Date.now()): number | null {
  if (!timestamp) {
    return null;
  }

  return Math.max(0, now - new Date(timestamp).getTime());
}

async function waitForCondition<T>(
  resolver: () => T | null | undefined,
  timeoutMs: number,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = resolver();
    if (value != null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error('readiness_wait_timeout');
}

function normalizeTokenIds(market: ActiveMarketRecord): string[] {
  return [market.tokenIdYes, market.tokenIdNo].filter(
    (tokenId): tokenId is string => Boolean(tokenId),
  );
}

function normalizeOutcomeLabel(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function extractTokenIds(record: Record<string, unknown>): {
  tokenIdYes: string | null;
  tokenIdNo: string | null;
} {
  let tokenIdYes: string | null = null;
  let tokenIdNo: string | null = null;

  const tokens = Array.isArray(record.tokens) ? record.tokens : [];
  for (const token of tokens) {
    if (typeof token !== 'object' || token === null) {
      continue;
    }

    const tokenRecord = token as Record<string, unknown>;
    const tokenId = String(
      tokenRecord.token_id ?? tokenRecord.tokenId ?? tokenRecord.id ?? '',
    ).trim();
    if (!tokenId) {
      continue;
    }

    const outcome = normalizeOutcomeLabel(
      tokenRecord.outcome ?? tokenRecord.name ?? tokenRecord.label,
    );

    if (!tokenIdYes && outcome.includes('yes')) {
      tokenIdYes = tokenId;
    } else if (!tokenIdNo && outcome.includes('no')) {
      tokenIdNo = tokenId;
    }
  }

  if (!tokenIdYes || !tokenIdNo) {
    const clobTokenIds = Array.isArray(record.clobTokenIds) ? record.clobTokenIds : [];
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

async function findActiveMarketByTokenId(
  tokenId: string,
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<ActiveMarketRecord | null> {
  let offset = 0;
  const limit = 200;
  const normalizedTokenId = tokenId.trim();

  while (true) {
    const response = await fetchImpl(
      `${baseUrl.replace(/\/$/, '')}/markets?active=true&closed=false&limit=${limit}&offset=${offset}`,
    );

    if (!response.ok) {
      throw new Error(`gamma_market_lookup_failed:${response.status}`);
    }

    const payload = (await response.json()) as unknown[];
    if (!Array.isArray(payload) || payload.length === 0) {
      return null;
    }

    for (const item of payload) {
      if (typeof item !== 'object' || item === null) {
        continue;
      }

      const record = item as Record<string, unknown>;
      const marketId = String(record.id ?? '').trim();
      if (!marketId) {
        continue;
      }

      const extracted = extractTokenIds(record);
      const tokenIds = new Set<string>([
        ...[extracted.tokenIdYes, extracted.tokenIdNo].filter(
          (value): value is string => Boolean(value),
        ),
        ...(Array.isArray(record.clobTokenIds)
          ? record.clobTokenIds
              .map((value) => String(value ?? '').trim())
              .filter((value) => value.length > 0)
          : []),
      ]);

      if (!tokenIds.has(normalizedTokenId)) {
        continue;
      }
      return {
        id: marketId,
        tokenIdYes: extracted.tokenIdYes,
        tokenIdNo: extracted.tokenIdNo,
      };
    }

    offset += limit;
  }
}

async function loadTrackedMarkets(
  prisma: PrismaLike,
  smokeTokenId: string,
  gammaBaseUrl: string,
  fetchImpl: typeof fetch,
): Promise<ActiveMarketRecord[]> {
  const activeMarkets = await prisma.market.findMany({
    where: {
      status: 'active',
    },
    select: {
      id: true,
      tokenIdYes: true,
      tokenIdNo: true,
    },
    take: 100,
  });

  const alreadyTracked = activeMarkets.some(
    (market) =>
      market.tokenIdYes === smokeTokenId ||
      market.tokenIdNo === smokeTokenId,
  );

  if (alreadyTracked) {
    return activeMarkets;
  }

  const smokeMarket = await findActiveMarketByTokenId(
    smokeTokenId,
    gammaBaseUrl,
    fetchImpl,
  );

  if (!smokeMarket) {
    throw new Error(`readiness_smoke_market_missing:${smokeTokenId}`);
  }

  return [...activeMarkets, smokeMarket];
}

export function createForcedDisconnectWebSocketFactory(input?: {
  disconnectAfterInboundFrames?: number;
}): {
  factory: (url: string) => PolymarketSocket;
  probe: ForcedDisconnectProbe;
} {
  const disconnectAfterInboundFrames = input?.disconnectAfterInboundFrames ?? 2;
  const probe: ForcedDisconnectProbe = {
    connections: 0,
    forcedDisconnects: 0,
    inboundFrames: 0,
    inboundMessages: 0,
    inboundHeartbeats: 0,
  };

  class ForcedDisconnectWebSocket implements PolymarketSocket {
    private readonly inner: WebSocket;
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: unknown) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;

    constructor(url: string) {
      const WebSocketCtor = (globalThis as unknown as {
        WebSocket?: new (socketUrl: string) => WebSocket;
      }).WebSocket;
      if (!WebSocketCtor) {
        throw new Error('global_websocket_unavailable');
      }

      this.inner = new WebSocketCtor(url);
      this.inner.onopen = (event) => {
        probe.connections += 1;
        this.onopen?.(event);
      };
      this.inner.onmessage = (event) => {
        const text = typeof event.data === 'string' ? event.data : String(event.data ?? '');
        probe.inboundFrames += 1;
        if (text === 'PONG') {
          probe.inboundHeartbeats += 1;
        } else {
          probe.inboundMessages += 1;
        }

        this.onmessage?.({ data: event.data });

        if (
          probe.forcedDisconnects === 0 &&
          probe.inboundFrames >= disconnectAfterInboundFrames
        ) {
          probe.forcedDisconnects += 1;
          setTimeout(() => {
            this.inner.close(4002, 'readiness_probe_disconnect');
          }, 0);
        }
      };
      this.inner.onclose = (event) => {
        this.onclose?.(event);
      };
      this.inner.onerror = (event) => {
        this.onerror?.(event);
      };
    }

    get readyState(): number {
      return this.inner.readyState;
    }

    send(data: string): void {
      this.inner.send(data);
    }

    close(code?: number, reason?: string): void {
      this.inner.close(code, reason);
    }
  }

  return {
    factory: (url: string) => new ForcedDisconnectWebSocket(url),
    probe,
  };
}

export async function probeMarketStreamReadiness(input: {
  service: MarketWebSocketStateService;
  assetIds: string[];
  staleAfterMs: number;
}): Promise<ProductionReadinessStepResult> {
  if (input.assetIds.length === 0) {
    return failStep('market_stream_live_subscription', 'market_assets_missing');
  }

  try {
    const health = await input.service.start(input.assetIds);
    const sampleAssetId =
      input.assetIds.find((assetId) => input.service.getAssetState(assetId)?.lastUpdateAt) ??
      input.assetIds[0] ??
      null;
    const sampleAssetState = sampleAssetId
      ? input.service.getAssetState(sampleAssetId)
      : null;
    const freshnessMs = ageMs(health.lastEventAt);
    const ok =
      health.healthy &&
      health.trusted &&
      health.lastEventAt !== null &&
      sampleAssetState !== null &&
      freshnessMs !== null &&
      freshnessMs <= input.staleAfterMs;

    return ok
      ? passStep('market_stream_live_subscription', {
          trackedAssets: health.trackedAssets,
          sampleAssetId,
          sampleAssetState,
          lastTrafficAt: health.lastTrafficAt,
          lastEventAt: health.lastEventAt,
          freshnessMs,
          bootstrapCompletedAt: health.bootstrapCompletedAt,
          trusted: health.trusted,
        })
      : failStep('market_stream_live_subscription', health.reasonCode ?? 'market_stream_unhealthy', {
          trackedAssets: health.trackedAssets,
          sampleAssetId,
          sampleAssetState,
          health,
          freshnessMs,
        });
  } catch (error) {
    return failStep('market_stream_live_subscription', 'market_stream_probe_failed', {
      error: error instanceof Error ? error.message : String(error),
      assetIds: input.assetIds,
    });
  }
}

export async function probeUserStreamReadiness(input: {
  service: UserWebSocketStateService;
  subscriptions: UserStreamMarketSubscription[];
  staleAfterMs: number;
}): Promise<ProductionReadinessStepResult> {
  if (input.subscriptions.length === 0) {
    return failStep('user_stream_authenticated_subscription', 'user_stream_markets_missing');
  }

  try {
    await input.service.start(input.subscriptions);
    const health =
      (await waitForCondition(
        () => {
          const current = input.service.evaluateHealth();
          return current.lastEventAt !== null ? current : null;
        },
        Math.max(input.staleAfterMs, 1_000),
        50,
      ).catch(() => null)) ?? input.service.evaluateHealth();
    const freshnessMs = ageMs(health.lastEventAt);
    const ok =
      health.healthy &&
      health.trusted &&
      health.subscribedMarkets > 0 &&
      health.lastEventAt !== null &&
      freshnessMs !== null &&
      freshnessMs <= input.staleAfterMs;

    return ok
      ? passStep('user_stream_authenticated_subscription', {
          subscribedMarkets: health.subscribedMarkets,
          openOrders: health.openOrders,
          recentTrades: health.recentTrades,
          lastTrafficAt: health.lastTrafficAt,
          lastEventAt: health.lastEventAt,
          freshnessMs,
          trusted: health.trusted,
        })
      : failStep(
          'user_stream_authenticated_subscription',
          health.reasonCode ?? 'user_stream_unhealthy',
          {
            health,
            freshnessMs,
            subscriptions: input.subscriptions,
          },
        );
  } catch (error) {
    return failStep('user_stream_authenticated_subscription', 'user_stream_probe_failed', {
      error: error instanceof Error ? error.message : String(error),
      subscriptions: input.subscriptions,
    });
  }
}

export function probeCombinedStreamFreshness(input: {
  marketHealth: MarketWebSocketHealth;
  userHealth: ReturnType<UserWebSocketStateService['evaluateHealth']>;
  marketStaleAfterMs: number;
  userStaleAfterMs: number;
}): ProductionReadinessStepResult {
  const marketFreshnessMs = ageMs(input.marketHealth.lastEventAt);
  const userFreshnessMs = ageMs(input.userHealth.lastEventAt);
  const ok =
    input.marketHealth.lastEventAt !== null &&
    input.userHealth.lastEventAt !== null &&
    marketFreshnessMs !== null &&
    userFreshnessMs !== null &&
    marketFreshnessMs <= input.marketStaleAfterMs &&
    userFreshnessMs <= input.userStaleAfterMs;

  return ok
    ? passStep('stream_truth_freshness', {
        marketLastEventAt: input.marketHealth.lastEventAt,
        marketLastTrafficAt: input.marketHealth.lastTrafficAt,
        marketFreshnessMs,
        userLastEventAt: input.userHealth.lastEventAt,
        userLastTrafficAt: input.userHealth.lastTrafficAt,
        userFreshnessMs,
      })
    : failStep('stream_truth_freshness', 'stream_truth_stale', {
        marketLastEventAt: input.marketHealth.lastEventAt,
        marketLastTrafficAt: input.marketHealth.lastTrafficAt,
        marketFreshnessMs,
        userLastEventAt: input.userHealth.lastEventAt,
        userLastTrafficAt: input.userHealth.lastTrafficAt,
        userFreshnessMs,
      });
}

export async function probeReconnectRecovery(input: {
  name: 'market_stream_reconnect_recovery' | 'user_stream_reconnect_recovery';
  starter: () => Promise<unknown>;
  evaluator: () => { healthy: boolean; reasonCode: string | null };
  probe: ForcedDisconnectProbe;
  timeoutMs: number;
}): Promise<ProductionReadinessStepResult> {
  try {
    await input.starter();
    await waitForCondition(
      () =>
        input.probe.forcedDisconnects > 0 &&
        input.probe.connections >= 2 &&
        input.evaluator().healthy
          ? true
          : null,
      input.timeoutMs,
      50,
    );

    return passStep(input.name, {
      connections: input.probe.connections,
      forcedDisconnects: input.probe.forcedDisconnects,
      inboundFrames: input.probe.inboundFrames,
      inboundMessages: input.probe.inboundMessages,
      inboundHeartbeats: input.probe.inboundHeartbeats,
      health: input.evaluator(),
    });
  } catch (error) {
    return failStep(input.name, 'stream_reconnect_recovery_failed', {
      error: error instanceof Error ? error.message : String(error),
      probe: input.probe,
      health: input.evaluator(),
    });
  }
}

export async function probeUserStreamLifecycleVisibility(input: {
  service: UserWebSocketStateService;
  smokeRunner: () => Promise<PolymarketSmokeResult>;
  timeoutMs: number;
}): Promise<{
  smoke: PolymarketSmokeResult;
  step: ProductionReadinessStepResult;
}> {
  const baselineOrders = new Set(input.service.getOpenOrderIds());
  const baselineTrades = new Set(input.service.getTradeIds());
  const baselineLastEventAt = input.service.evaluateHealth().lastEventAt;
  const observation: LifecycleObservation = {
    appearedOrderId: null,
    disappearedAfterAppearance: false,
    newTradeIds: [],
    streamEventAdvanced: false,
  };

  const watcher = setInterval(() => {
    const currentOrders = input.service.getOpenOrderIds();
    const currentTrades = input.service.getTradeIds();
    const currentHealth = input.service.evaluateHealth();

    if (!observation.streamEventAdvanced && currentHealth.lastEventAt !== baselineLastEventAt) {
      observation.streamEventAdvanced = true;
    }

    if (!observation.appearedOrderId) {
      observation.appearedOrderId =
        currentOrders.find((orderId) => !baselineOrders.has(orderId)) ?? null;
    }

    if (
      observation.appearedOrderId &&
      !currentOrders.includes(observation.appearedOrderId)
    ) {
      observation.disappearedAfterAppearance = true;
    }

    observation.newTradeIds = currentTrades.filter((tradeId) => !baselineTrades.has(tradeId));
  }, 50);

  try {
    const smoke = await input.smokeRunner();
    await waitForCondition(
      () =>
        smoke.success &&
        observation.appearedOrderId !== null &&
        observation.disappearedAfterAppearance &&
        observation.streamEventAdvanced
          ? true
          : null,
      input.timeoutMs,
      50,
    );

    return {
      smoke,
      step: passStep('user_stream_lifecycle_visibility', {
        smokeSuccess: smoke.success,
        smokeOrderId: smoke.orderId,
        appearedOrderId: observation.appearedOrderId,
        disappearedAfterAppearance: observation.disappearedAfterAppearance,
        newTradeIds: observation.newTradeIds,
        streamEventAdvanced: observation.streamEventAdvanced,
        finalOpenOrders: input.service.getOpenOrderIds(),
        finalTrades: input.service.getTradeIds(),
      }),
    };
  } catch (error) {
    const smoke =
      error && typeof error === 'object' && 'success' in (error as object)
        ? (error as PolymarketSmokeResult)
        : await Promise.resolve({
            success: false,
            executedAt: new Date().toISOString(),
            freshnessTtlMs: input.timeoutMs,
            orderId: null,
            steps: [],
          } satisfies PolymarketSmokeResult);

    return {
      smoke,
      step: failStep('user_stream_lifecycle_visibility', 'user_stream_lifecycle_not_observed', {
        error: error instanceof Error ? error.message : String(error),
        smokeSuccess: smoke.success,
        smokeOrderId: smoke.orderId,
        appearedOrderId: observation.appearedOrderId,
        disappearedAfterAppearance: observation.disappearedAfterAppearance,
        newTradeIds: observation.newTradeIds,
        streamEventAdvanced: observation.streamEventAdvanced,
        finalOpenOrders: input.service.getOpenOrderIds(),
        finalTrades: input.service.getTradeIds(),
      }),
    };
  } finally {
    clearInterval(watcher);
  }
}

export async function probeStreamReconciliation(input: {
  userStreamService: UserWebSocketStateService;
  tradingClient: TradingClientLike;
  externalPortfolioService: Pick<ExternalPortfolioService, 'capture'>;
}): Promise<ProductionReadinessStepResult> {
  try {
    const [openOrders, trades, externalSnapshot] = await Promise.all([
      input.tradingClient.getOpenOrders(),
      input.tradingClient.getTrades(),
      input.externalPortfolioService.capture({
        cycleKey: `production-readiness:${Date.now()}`,
        source: 'production_readiness_external_truth',
      }),
    ]);

    const divergence = input.userStreamService.detectDivergence({
      openOrderIds: openOrders.map((order) => order.id),
      tradeIds: trades.map((trade) => trade.id),
    });

    if (divergence) {
      return failStep('stream_truth_reconciliation', 'stream_truth_divergent', {
        userStreamHealth: input.userStreamService.evaluateHealth(),
        venueOpenOrders: openOrders.map((order) => order.id),
        venueTrades: trades.map((trade) => trade.id),
        externalFreshness: externalSnapshot.freshness,
        externalDivergence: externalSnapshot.divergence,
      });
    }

    input.userStreamService.markReconciled();
    const health = input.userStreamService.evaluateHealth();
    const externalHealthy =
      externalSnapshot.freshness.overallVerdict !== 'stale' &&
      (externalSnapshot.tradingPermissions?.allowPositionManagement ?? false);

    return externalHealthy
      ? passStep('stream_truth_reconciliation', {
          userStreamHealth: health,
          venueOpenOrders: openOrders.length,
          venueTrades: trades.length,
          externalFreshness: externalSnapshot.freshness,
          externalDivergence: externalSnapshot.divergence,
          externalRecovery: externalSnapshot.recovery,
        })
      : failStep('stream_truth_reconciliation', 'external_truth_unhealthy', {
          userStreamHealth: health,
          venueOpenOrders: openOrders.length,
          venueTrades: trades.length,
          externalFreshness: externalSnapshot.freshness,
          externalDivergence: externalSnapshot.divergence,
          externalRecovery: externalSnapshot.recovery,
        });
  } catch (error) {
    return failStep('stream_truth_reconciliation', 'stream_truth_reconciliation_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function createDefaultTradingClient(): OfficialPolymarketTradingClient {
  return new OfficialPolymarketTradingClient({
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

function createDefaultMarketStreamService(
  webSocketFactory?: (url: string) => PolymarketSocket,
): MarketWebSocketStateService {
  return new MarketWebSocketStateService(
    appEnv.BOT_MAX_MARKET_STREAM_STALENESS_MS,
    {
      url: appEnv.BOT_MARKET_WS_URL ?? undefined,
      restBaseUrl: appEnv.POLY_CLOB_HOST,
      webSocketFactory,
    },
  );
}

function createDefaultUserStreamService(
  tradingClient: TradingClientLike,
  webSocketFactory?: (url: string) => PolymarketSocket,
): UserWebSocketStateService {
  return new UserWebSocketStateService(
    appEnv.BOT_MAX_USER_STREAM_STALENESS_MS,
    {
      url: appEnv.BOT_USER_WS_URL ?? undefined,
      gammaBaseUrl: appEnv.POLY_GAMMA_HOST,
      auth:
        appEnv.POLY_API_KEY && appEnv.POLY_API_SECRET && appEnv.POLY_API_PASSPHRASE
          ? {
              apiKey: appEnv.POLY_API_KEY,
              secret: appEnv.POLY_API_SECRET,
              passphrase: appEnv.POLY_API_PASSPHRASE,
            }
          : null,
      restClient: tradingClient,
      webSocketFactory,
    },
  );
}

export async function runProductionReadiness(
  options: ProductionReadinessOptions = {},
): Promise<ProductionReadinessResult> {
  const executedAt = options.executeAt ?? new Date().toISOString();
  const fetchImpl = options.fetchImpl ?? fetch;
  const prisma =
    options.prisma ??
    new PrismaClient({
      log: ['error', 'warn'],
    });
  const runtimeControl =
    options.runtimeControl ??
    new RuntimeControlRepository(prisma as PrismaClient, {
      maxOpenPositions: appEnv.MAX_OPEN_POSITIONS,
      maxDailyLossPct: appEnv.MAX_DAILY_LOSS_PCT,
      maxPerTradeRiskPct: appEnv.MAX_PER_TRADE_RISK_PCT,
      maxKellyFraction: appEnv.MAX_KELLY_FRACTION,
      maxConsecutiveLosses: appEnv.MAX_CONSECUTIVE_LOSSES,
      noTradeWindowSeconds: appEnv.NO_TRADE_WINDOW_SECONDS,
      evaluationIntervalMs: appEnv.BOT_EVALUATION_INTERVAL_MS,
      orderReconcileIntervalMs: appEnv.BOT_ORDER_RECONCILE_INTERVAL_MS,
      portfolioRefreshIntervalMs: appEnv.BOT_PORTFOLIO_REFRESH_INTERVAL_MS,
    });
  const tradingClient = options.tradingClient ?? createDefaultTradingClient();
  const externalPortfolioService =
    options.externalPortfolioService ?? new ExternalPortfolioService(prisma as PrismaClient);
  const smokeConfig = parsePolymarketSmokeEnv(process.env);
  const steps: ProductionReadinessStepResult[] = [];
  const cycleKey = `production-readiness:${Date.now()}`;

  const marketStreamService =
    options.marketStreamService ?? createDefaultMarketStreamService();
  const userStreamService =
    options.userStreamService ?? createDefaultUserStreamService(tradingClient);

  const marketReconnectProbe =
    options.reconnectMarketStreamService ??
    (() => {
      const forced = createForcedDisconnectWebSocketFactory();
      return {
        service: createDefaultMarketStreamService(forced.factory),
        probe: forced.probe,
      };
    })();
  const userReconnectProbe =
    options.reconnectUserStreamService ??
    (() => {
      const forced = createForcedDisconnectWebSocketFactory();
      return {
        service: createDefaultUserStreamService(tradingClient, forced.factory),
        probe: forced.probe,
      };
    })();

  const reconnectMarketStreamService =
    'service' in marketReconnectProbe
      ? marketReconnectProbe.service
      : marketReconnectProbe;
  const reconnectMarketProbe =
    'probe' in marketReconnectProbe ? marketReconnectProbe.probe : null;
  const reconnectUserStreamService =
    'service' in userReconnectProbe ? userReconnectProbe.service : userReconnectProbe;
  const reconnectUserProbe =
    'probe' in userReconnectProbe ? userReconnectProbe.probe : null;

  const connectPrisma = options.connectPrisma ?? !options.prisma;

  try {
    if (connectPrisma && prisma.$connect) {
      await prisma.$connect();
    }

    const trackedMarkets =
      options.trackedMarkets ??
      (await loadTrackedMarkets(
        prisma,
        smokeConfig.POLY_SMOKE_TOKEN_ID,
        appEnv.POLY_GAMMA_HOST,
        fetchImpl,
      ));

    const marketAssetIds = [...new Set(trackedMarkets.flatMap(normalizeTokenIds))];
    const userSubscriptions: UserStreamMarketSubscription[] = trackedMarkets.map((market) => ({
      marketId: market.id,
      tokenIds: normalizeTokenIds(market),
    }));

    const liveMarketStep = await probeMarketStreamReadiness({
      service: marketStreamService,
      assetIds: marketAssetIds,
      staleAfterMs: appEnv.BOT_MAX_MARKET_STREAM_STALENESS_MS,
    });
    steps.push(liveMarketStep);

    const liveUserStep = await probeUserStreamReadiness({
      service: userStreamService,
      subscriptions: userSubscriptions,
      staleAfterMs: appEnv.BOT_MAX_USER_STREAM_STALENESS_MS,
    });
    steps.push(liveUserStep);

    const smokeRunner =
      options.smokeRunner ??
      (() => runPolymarketAuthenticatedSmoke(process.env, tradingClient));
    const lifecycle = await probeUserStreamLifecycleVisibility({
      service: userStreamService,
      smokeRunner,
      timeoutMs: Math.max(smokeConfig.POLY_SMOKE_MAX_WAIT_MS * 2, 8_000),
    });
    steps.push(
      ...lifecycle.smoke.steps.map((step) => ({
        name: `smoke:${step.step}`,
        ok: step.ok,
        reasonCode: step.ok ? null : step.reasonCode,
        evidence: step.evidence,
      })),
    );
    steps.push(lifecycle.step);

    const marketHealth = marketStreamService.evaluateHealth();
    const userHealth = userStreamService.evaluateHealth();
    steps.push(
      probeCombinedStreamFreshness({
        marketHealth,
        userHealth,
        marketStaleAfterMs: appEnv.BOT_MAX_MARKET_STREAM_STALENESS_MS,
        userStaleAfterMs: appEnv.BOT_MAX_USER_STREAM_STALENESS_MS,
      }),
    );

    steps.push(
      await probeStreamReconciliation({
        userStreamService,
        tradingClient,
        externalPortfolioService,
      }),
    );
    const streamReconciliationStep = steps[steps.length - 1];

    if (reconnectMarketProbe) {
      steps.push(
        await probeReconnectRecovery({
          name: 'market_stream_reconnect_recovery',
          starter: () => reconnectMarketStreamService.start(marketAssetIds),
          evaluator: () => reconnectMarketStreamService.evaluateHealth(),
          probe: reconnectMarketProbe,
          timeoutMs: Math.max(smokeConfig.POLY_SMOKE_MAX_WAIT_MS, 8_000),
        }),
      );
    }

    if (reconnectUserProbe) {
      steps.push(
        await probeReconnectRecovery({
          name: 'user_stream_reconnect_recovery',
          starter: () => reconnectUserStreamService.start(userSubscriptions),
          evaluator: () => reconnectUserStreamService.evaluateHealth(),
          probe: reconnectUserProbe,
          timeoutMs: Math.max(smokeConfig.POLY_SMOKE_MAX_WAIT_MS, 8_000),
        }),
      );
    }

    const lifecycleSuite = loadLatestLifecycleValidationEvidence();
    const observerVerdict = evaluateReadinessObserver({
      internalSteps: steps.map((step) => ({ name: step.name, ok: step.ok })),
      marketHealth: marketStreamService.evaluateHealth(),
      userHealth: userStreamService.evaluateHealth(),
      smokeSuccess: lifecycle.smoke.success,
      externalFreshness:
        streamReconciliationStep?.evidence &&
        typeof streamReconciliationStep.evidence === 'object' &&
        'externalFreshness' in streamReconciliationStep.evidence
          ? (streamReconciliationStep.evidence.externalFreshness as { overallVerdict?: string | null })
          : null,
      lifecycleSuite,
      marketStaleAfterMs: appEnv.BOT_MAX_MARKET_STREAM_STALENESS_MS,
      userStaleAfterMs: appEnv.BOT_MAX_USER_STREAM_STALENESS_MS,
    });
    steps.push(
      observerVerdict.observerHealthy && !observerVerdict.materialDiscrepancy
        ? passStep('observer_readiness_cross_check', observerVerdict as unknown as Record<string, unknown>)
        : failStep(
            'observer_readiness_cross_check',
            observerVerdict.materialDiscrepancy
              ? 'observer_discrepancy_detected'
              : observerVerdict.reasonCodes[0] ?? 'observer_readiness_failed',
            observerVerdict as unknown as Record<string, unknown>,
          ),
    );

    const recentFills = prisma.fill?.findMany
      ? await prisma.fill.findMany({
          orderBy: { filledAt: 'desc' },
          take: 25,
        })
      : [];
    const prismaAny = prisma as any;
    const recentExecutionDiagnostics = prismaAny.executionDiagnostic?.findMany
      ? await prismaAny.executionDiagnostic.findMany({
          orderBy: { capturedAt: 'desc' },
          take: 50,
        })
      : [];
    const recentPortfolioSnapshots = prismaAny.portfolioSnapshot?.findMany
      ? await prismaAny.portfolioSnapshot.findMany({
          orderBy: { capturedAt: 'desc' },
          take: 50,
        })
      : [];
    const divergenceFailures = prisma.reconciliationCheckpoint?.findMany
      ? (
          await prisma.reconciliationCheckpoint.findMany({
            where: {
              source: 'external_portfolio_reconcile',
              status: 'failed',
            },
            orderBy: { processedAt: 'desc' },
            take: 25,
          })
        ).length
      : 0;
    const capitalExposureReport = persistCapitalExposureValidationReport(
      buildCapitalExposureValidationReport({
        deploymentTier: appEnv.BOT_DEPLOYMENT_TIER,
        lifecycleSuite,
        readinessSuitePassed: steps.every((step) => step.ok),
        observerHealthy:
          observerVerdict.observerHealthy && !observerVerdict.materialDiscrepancy,
        fills: recentFills,
        divergenceFailures,
        executionDiagnostics: recentExecutionDiagnostics,
        portfolioSnapshots: recentPortfolioSnapshots,
      }),
    );
    steps.push(
      capitalExposureReport.allowLiveScale
        ? passStep(
            'capital_exposure_validation',
            capitalExposureReport as unknown as Record<string, unknown>,
          )
        : failStep(
            'capital_exposure_validation',
            capitalExposureReport.reasons[0] ?? 'capital_exposure_validation_missing',
            capitalExposureReport as unknown as Record<string, unknown>,
          ),
    );

    const result: ProductionReadinessResult = {
      success: steps.every((step) => step.ok),
      executedAt,
      steps,
    };

    await runtimeControl.recordReconciliationCheckpoint({
      cycleKey,
      source: 'production_readiness_stream_truth',
      status: result.success ? 'completed' : 'failed',
      details: {
        executedAt,
        marketAssetIds,
        userSubscriptions,
        steps,
      },
    });

    await runtimeControl.recordReconciliationCheckpoint({
      cycleKey,
      source: 'production_readiness_suite',
      status: result.success ? 'completed' : 'failed',
      details: result as unknown as Record<string, unknown>,
    });
    await runtimeControl.recordReconciliationCheckpoint({
      cycleKey,
      source: 'production_readiness_observer',
      status:
        observerVerdict.observerHealthy && !observerVerdict.materialDiscrepancy
          ? 'completed'
          : 'failed',
      details: observerVerdict as unknown as Record<string, unknown>,
    });
    await runtimeControl.recordReconciliationCheckpoint({
      cycleKey,
      source: 'capital_exposure_validation',
      status: capitalExposureReport.allowLiveScale ? 'completed' : 'failed',
      details: capitalExposureReport as unknown as Record<string, unknown>,
    });

    return result;
  } catch (error) {
    const result: ProductionReadinessResult = {
      success: false,
      executedAt,
      steps: [
        ...steps,
        failStep('production_readiness_runtime_error', 'production_readiness_runtime_error', {
          error: error instanceof Error ? error.message : String(error),
        }),
      ],
    };

    await runtimeControl.recordReconciliationCheckpoint({
      cycleKey,
      source: 'production_readiness_suite',
      status: 'failed',
      details: result as unknown as Record<string, unknown>,
    });

    return result;
  } finally {
    marketStreamService.stop();
    userStreamService.stop();
    reconnectMarketStreamService.stop();
    reconnectUserStreamService.stop();
    if (connectPrisma && prisma.$disconnect) {
      await prisma.$disconnect();
    }
  }
}

if (require.main === module) {
  runProductionReadiness()
    .then((result) => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.success ? 0 : 1);
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error(
        JSON.stringify(
          {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          },
          null,
          2,
        ),
      );
      process.exit(1);
    });
}
