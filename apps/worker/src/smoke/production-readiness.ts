import fs from 'fs/promises';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { appEnv } from '@worker/config/env';
import { ExternalPortfolioService } from '@worker/portfolio/external-portfolio.service';
import { RuntimeControlRepository } from '@worker/runtime/runtime-control.repository';
import { ExecutionStateWatchdog } from '@worker/runtime/execution-state-watchdog';
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
import {
  assessDeploymentTierEvidence,
  getDeploymentTierEvidenceThresholds,
} from '@worker/runtime/startup-runbook';
import { readLatestDailyDecisionQualityReport } from '@worker/validation/daily-decision-quality-report';
import { ResolvedTradeLedger } from '@worker/runtime/resolved-trade-ledger';
import { StrategyDeploymentRegistry } from '@worker/runtime/strategy-deployment-registry';
import { resolveRepositoryRoot } from '@worker/runtime/learning-state-store';
import { LiveTrustScore } from '@polymarket-btc-5m-agentic-bot/risk-engine';

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
  getLatestCheckpoint?: (source: string) => Promise<{
    status: string;
    processedAt: Date;
    details: Record<string, unknown> | null;
  } | null>;
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
  resolvedTradeLedger?: Pick<ResolvedTradeLedger, 'loadWindow' | 'getPath'>;
  deploymentRegistry?: Pick<StrategyDeploymentRegistry, 'load'>;
  artifactRootDir?: string;
}

export function getProductionReadinessArtifactPath(
  rootDir = resolveRepositoryRoot(),
): string {
  return path.join(rootDir, 'artifacts/production-readiness/latest.json');
}

async function persistProductionReadinessArtifact(
  result: ProductionReadinessResult,
  rootDir = resolveRepositoryRoot(),
): Promise<string> {
  const latestPath = getProductionReadinessArtifactPath(rootDir);
  const historyDir = path.join(rootDir, 'artifacts/production-readiness/history');
  await fs.mkdir(historyDir, { recursive: true });
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  const snapshotPath = path.join(
    historyDir,
    `${result.executedAt.replace(/[:.]/g, '-')}.json`,
  );
  const tmpPath = `${latestPath}.tmp`;
  await Promise.all([
    fs.writeFile(snapshotPath, serialized, 'utf8'),
    (async () => {
      await fs.writeFile(tmpPath, serialized, 'utf8');
      await fs.rename(tmpPath, latestPath);
    })(),
  ]);
  return latestPath;
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

function average(values: Array<number | null>): number | null {
  const usable = values.filter(
    (value): value is number => value != null && Number.isFinite(value),
  );
  if (usable.length === 0) {
    return null;
  }
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
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

async function buildDeploymentTierEvidenceStep(input: {
  resolvedTradeLedger: Pick<ResolvedTradeLedger, 'loadWindow' | 'getPath'>;
  deploymentRegistry: Pick<StrategyDeploymentRegistry, 'load'>;
  runtimeControl: RuntimeControlLike;
  now: Date;
}): Promise<ProductionReadinessStepResult> {
  const thresholds = {
    ...getDeploymentTierEvidenceThresholds(),
    requireRecentReadinessPass: false,
    requireRecentSmokePass: false,
  };
  const [registryState, recentResolvedTrades, latestDailyDecisionQualityReport, latestSmokeCheckpoint] =
    await Promise.all([
      input.deploymentRegistry.load(),
      input.resolvedTradeLedger.loadWindow({
        start: new Date(input.now.getTime() - 30 * 24 * 60 * 60 * 1000),
        end: input.now,
      }),
      readLatestDailyDecisionQualityReport(
        path.dirname(input.resolvedTradeLedger.getPath()),
      ),
      input.runtimeControl.getLatestCheckpoint?.('authenticated_venue_smoke_suite') ??
        Promise.resolve(null),
    ]);

  const incumbentVariantId = registryState.incumbentVariantId;
  const filteredTrades = recentResolvedTrades.filter((trade) =>
    incumbentVariantId == null ? true : trade.strategyVariantId === incumbentVariantId,
  );
  const trustDecision = new LiveTrustScore().evaluate({
    strategyVariantId: incumbentVariantId,
    regime: null,
    resolvedTrades: recentResolvedTrades,
  });
  const recentSmokePassAt =
    latestSmokeCheckpoint?.status === 'completed' &&
    input.now.getTime() - latestSmokeCheckpoint.processedAt.getTime() <=
      thresholds.requiredCheckpointMaxAgeMs
      ? latestSmokeCheckpoint.processedAt.toISOString()
      : null;
  const snapshot = {
    tier: appEnv.BOT_DEPLOYMENT_TIER,
    incumbentVariantId,
    liveTradeCount: filteredTrades.length,
    liveTrustScore: trustDecision.trustScore,
    averageAbsoluteRealizedExpectedEdgeGapBps: average(
      filteredTrades.map((trade) => {
        const expected = trade.netOutcome.expectedNetEdgeBps ?? trade.expectedNetEdgeBps;
        const realized = trade.netOutcome.realizedNetEdgeBps ?? trade.realizedNetEdgeBps;
        if (
          typeof expected !== 'number' ||
          !Number.isFinite(expected) ||
          typeof realized !== 'number' ||
          !Number.isFinite(realized)
        ) {
          return null;
        }
        return Math.abs(realized - expected);
      }),
    ),
    reconciliationDefectRate:
      filteredTrades.length === 0
        ? null
        : filteredTrades.filter(
            (trade) =>
              trade.lifecycleState !== 'economically_resolved_with_portfolio_truth',
          ).length / filteredTrades.length,
    recentReadinessPassAt: null,
    recentSmokePassAt,
    dailyDecisionQualityReportAt:
      latestDailyDecisionQualityReport != null &&
      ageMs(latestDailyDecisionQualityReport.generatedAt, input.now.getTime()) != null &&
      ageMs(latestDailyDecisionQualityReport.generatedAt, input.now.getTime())! <=
        thresholds.dailyDecisionQualityMaxAgeMs
        ? latestDailyDecisionQualityReport.generatedAt
        : null,
    shadowDecisionLoggingEnabled: appEnv.BOT_ENABLE_SHADOW_DECISION_LOGGING,
  } as const;
  const assessment = assessDeploymentTierEvidence(snapshot, thresholds);

  return assessment.ok
    ? passStep('deployment_tier_evidence_thresholds', {
        assessment,
        trustDecision,
      })
    : failStep(
        'deployment_tier_evidence_thresholds',
        assessment.reasonCodes[0] ?? 'deployment_tier_evidence_thresholds_not_met',
        {
          assessment,
          trustDecision,
        },
      );
}

async function buildReconciliationDefectRateStep(input: {
  resolvedTradeLedger: Pick<ResolvedTradeLedger, 'loadWindow'>;
  now: Date;
}): Promise<ProductionReadinessStepResult> {
  if (!getDeploymentTierEvidenceThresholds().requireRecentReadinessPass) {
    return passStep('reconciliation_defect_rate', {
      tier: appEnv.BOT_DEPLOYMENT_TIER,
      required: false,
    });
  }

  const recentResolvedTrades = await input.resolvedTradeLedger.loadWindow({
    start: new Date(input.now.getTime() - 30 * 24 * 60 * 60 * 1000),
    end: input.now,
  });
  const defectRate =
    recentResolvedTrades.length === 0
      ? null
      : recentResolvedTrades.filter(
          (trade) =>
            trade.lifecycleState !== 'economically_resolved_with_portfolio_truth',
        ).length / recentResolvedTrades.length;

  if (defectRate == null) {
    return failStep(
      'reconciliation_defect_rate',
      'reconciliation_defect_rate_unavailable',
      {
        sampleCount: 0,
        maxAllowedDefectRate: appEnv.BOT_MAX_ALLOWED_RECONCILIATION_DEFECT_RATE,
      },
    );
  }

  return defectRate <= appEnv.BOT_MAX_ALLOWED_RECONCILIATION_DEFECT_RATE
    ? passStep('reconciliation_defect_rate', {
        sampleCount: recentResolvedTrades.length,
        defectRate,
        maxAllowedDefectRate: appEnv.BOT_MAX_ALLOWED_RECONCILIATION_DEFECT_RATE,
      })
    : failStep('reconciliation_defect_rate', 'reconciliation_defect_rate_too_high', {
        sampleCount: recentResolvedTrades.length,
        defectRate,
        maxAllowedDefectRate: appEnv.BOT_MAX_ALLOWED_RECONCILIATION_DEFECT_RATE,
      });
}

async function buildDailyDecisionQualityStep(input: {
  resolvedTradeLedger: Pick<ResolvedTradeLedger, 'getPath'>;
  now: Date;
}): Promise<ProductionReadinessStepResult> {
  if (!getDeploymentTierEvidenceThresholds().requireDailyDecisionQualityReport) {
    return passStep('daily_decision_quality_report', {
      tier: appEnv.BOT_DEPLOYMENT_TIER,
      required: false,
    });
  }

  const report = await readLatestDailyDecisionQualityReport(
    path.dirname(input.resolvedTradeLedger.getPath()),
  );
  const maxAgeMs = getDeploymentTierEvidenceThresholds().dailyDecisionQualityMaxAgeMs;
  const reportAgeMs = report ? ageMs(report.generatedAt, input.now.getTime()) : null;

  return report != null && reportAgeMs != null && reportAgeMs <= maxAgeMs
    ? passStep('daily_decision_quality_report', {
        generatedAt: report.generatedAt,
        ageMs: reportAgeMs,
        overall: report.overall,
      })
    : failStep('daily_decision_quality_report', 'daily_decision_quality_report_missing', {
        generatedAt: report?.generatedAt ?? null,
        ageMs: reportAgeMs,
        maxAgeMs,
      });
}

async function buildExecutionStateWatchdogHealthStep(input: {
  runtimeControl: RuntimeControlLike;
  now: Date;
}): Promise<ProductionReadinessStepResult> {
  const latestCheckpoint = await input.runtimeControl.getLatestCheckpoint?.(
    'execution_state_watchdog',
  );

  if (!latestCheckpoint) {
    return passStep('execution_state_watchdog_health', {
      checkpointMissing: true,
    });
  }

  const checkpointAgeMs = ageMs(
    latestCheckpoint.processedAt.toISOString(),
    input.now.getTime(),
  );
  const unhealthy =
    latestCheckpoint.status !== 'completed' &&
    (checkpointAgeMs == null ||
      checkpointAgeMs <= getDeploymentTierEvidenceThresholds().requiredCheckpointMaxAgeMs);

  return unhealthy
    ? failStep(
        'execution_state_watchdog_health',
        'execution_state_watchdog_unhealthy',
        {
          status: latestCheckpoint.status,
          processedAt: latestCheckpoint.processedAt.toISOString(),
          checkpointAgeMs,
          details: latestCheckpoint.details,
        },
      )
    : passStep('execution_state_watchdog_health', {
        status: latestCheckpoint.status,
        processedAt: latestCheckpoint.processedAt.toISOString(),
        checkpointAgeMs,
      });
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

export async function probeExecutionStateWatchdogDegradation(input: {
  runtimeControl?: RuntimeControlLike;
}): Promise<ProductionReadinessStepResult> {
  const checkpoints: Array<Record<string, unknown>> = [];
  const watchdog = new ExecutionStateWatchdog(
    input.runtimeControl
      ? {
          recordReconciliationCheckpoint: async (value) => {
            checkpoints.push(value as unknown as Record<string, unknown>);
            await input.runtimeControl?.recordReconciliationCheckpoint(value);
          },
        }
      : undefined,
  );

  const scenarios = await Promise.all([
    watchdog.evaluate({
      currentState: 'running',
      anomalyInput: {
        userStream: {
          stale: true,
          liveOrdersWhileStale: true,
          connected: false,
          reconnectAttempt: 2,
          openOrders: 2,
          lastTrafficAgeMs: 12_000,
          divergenceDetected: false,
        },
        venueTruth: {
          disagreementCount: 0,
          unresolvedGhostMismatch: false,
          lastVenueTruthAgeMs: 1_000,
          workingOpenOrders: 2,
          cancelPendingTooLongCount: 0,
        },
        lifecycle: {
          retryingCount: 0,
          failedCount: 0,
          ghostExposureDetected: false,
          unresolvedIntentCount: 0,
          locallyFilledButAbsentCount: 0,
          oldestLocallyFilledAbsentAgeMs: null,
        },
      },
    }),
    watchdog.evaluate({
      currentState: 'running',
      anomalyInput: {
        userStream: {
          stale: false,
          liveOrdersWhileStale: false,
          connected: true,
          reconnectAttempt: 0,
          openOrders: 3,
          lastTrafficAgeMs: 200,
          divergenceDetected: true,
        },
        venueTruth: {
          disagreementCount: 3,
          unresolvedGhostMismatch: true,
          lastVenueTruthAgeMs: 3_000,
          workingOpenOrders: 3,
          cancelPendingTooLongCount: 0,
        },
        lifecycle: {
          retryingCount: 0,
          failedCount: 0,
          ghostExposureDetected: false,
          unresolvedIntentCount: 0,
          locallyFilledButAbsentCount: 0,
          oldestLocallyFilledAbsentAgeMs: null,
        },
      },
    }),
    watchdog.evaluate({
      currentState: 'running',
      anomalyInput: {
        userStream: {
          stale: false,
          liveOrdersWhileStale: false,
          connected: true,
          reconnectAttempt: 0,
          openOrders: 2,
          lastTrafficAgeMs: 250,
          divergenceDetected: false,
        },
        venueTruth: {
          disagreementCount: 0,
          unresolvedGhostMismatch: false,
          lastVenueTruthAgeMs: 2_000,
          workingOpenOrders: 2,
          cancelPendingTooLongCount: 2,
        },
        lifecycle: {
          retryingCount: 0,
          failedCount: 0,
          ghostExposureDetected: false,
          unresolvedIntentCount: 0,
          locallyFilledButAbsentCount: 0,
          oldestLocallyFilledAbsentAgeMs: null,
        },
      },
    }),
  ]);

  const ok = scenarios.every((scenario) => scenario.transitionRequest !== null);
  const evidence = {
    scenarios: scenarios.map((scenario, index) => ({
      index,
      nextState: scenario.transitionRequest?.nextState ?? null,
      reasonCodes: scenario.reasonCodes,
      degradeOrderPersistence: scenario.degradeOrderPersistence,
      avoidBlindReposts: scenario.avoidBlindReposts,
      forceCancelOnlyBehavior: scenario.forceCancelOnlyBehavior,
    })),
    checkpointCount: checkpoints.length,
  };

  return ok
    ? passStep('execution_state_watchdog_degradation', evidence)
    : failStep('execution_state_watchdog_degradation', 'watchdog_transition_missing', evidence);
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
  const now = options.executeAt ? new Date(options.executeAt) : new Date();
  const executedAt = now.toISOString();
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
  const resolvedTradeLedger = options.resolvedTradeLedger ?? new ResolvedTradeLedger();
  const deploymentRegistry =
    options.deploymentRegistry ?? new StrategyDeploymentRegistry();
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

    steps.push(
      await buildDeploymentTierEvidenceStep({
        resolvedTradeLedger,
        deploymentRegistry,
        runtimeControl,
        now,
      }),
    );
    steps.push(
      await buildDailyDecisionQualityStep({
        resolvedTradeLedger,
        now,
      }),
    );
    steps.push(
      await buildReconciliationDefectRateStep({
        resolvedTradeLedger,
        now,
      }),
    );

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
    steps.push(
      await probeExecutionStateWatchdogDegradation({
        runtimeControl,
      }),
    );
    steps.push(
      await buildExecutionStateWatchdogHealthStep({
        runtimeControl,
        now,
      }),
    );

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
    await persistProductionReadinessArtifact(
      result,
      options.artifactRootDir ?? resolveRepositoryRoot(),
    );

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
    await persistProductionReadinessArtifact(
      result,
      options.artifactRootDir ?? resolveRepositoryRoot(),
    );

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
