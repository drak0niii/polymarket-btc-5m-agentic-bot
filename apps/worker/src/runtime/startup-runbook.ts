import { AppLogger } from '@worker/common/logger';
import path from 'path';
import { appEnv, type AppEnv } from '@worker/config/env';
import { type TradingOperatingMode } from '@polymarket-btc-5m-agentic-bot/domain';
import { SignerHealth } from '@polymarket-btc-5m-agentic-bot/signing-engine';
import { OfficialPolymarketTradingClient } from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';
import { LiveTrustScore } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import {
  ExternalPortfolioService,
  ExternalPortfolioSnapshot,
} from '@worker/portfolio/external-portfolio.service';
import { RuntimeControlRepository } from './runtime-control.repository';
import {
  PolymarketSmokeResult,
  runPolymarketAuthenticatedSmoke,
} from '@worker/smoke/polymarket-auth-smoke';
import { readLatestDailyDecisionQualityReport } from '@worker/validation/daily-decision-quality-report';
import { ResolvedTradeLedger } from './resolved-trade-ledger';
import { StrategyDeploymentRegistry } from './strategy-deployment-registry';

export type StartupRunbookStepName =
  | 'geoblock_clear'
  | 'credentials_valid'
  | 'funder_proxy_valid'
  | 'api_key_works'
  | 'orderbook_data_channel_live'
  | 'external_truth_fresh'
  | 'dry_authenticated_read_path_tested'
  | 'heartbeat_path_tested'
  | 'cancel_path_tested'
  | 'authenticated_venue_smoke_gate'
  | 'recent_smoke_test_timestamp'
  | 'recent_production_readiness_pass'
  | 'deployment_tier_live_evidence';

export interface StartupRunbookStepResult {
  step: StartupRunbookStepName;
  ok: boolean;
  checkedAt: string;
  reasonCode: string;
  evidence: Record<string, unknown>;
}

export interface StartupRunbookResult {
  passed: boolean;
  reasonCode: string | null;
  executedAt: string;
  steps: StartupRunbookStepResult[];
  smoke: PolymarketSmokeResult | null;
  externalSnapshot: ExternalPortfolioSnapshot | null;
}

type LiveExecutableDeploymentTier = Extract<
  AppEnv['BOT_DEPLOYMENT_TIER'],
  'canary' | 'cautious_live' | 'scaled_live'
>;

export interface DeploymentTierEvidenceThresholds {
  tier: AppEnv['BOT_DEPLOYMENT_TIER'];
  minLiveTrades: number;
  minLiveTrustScore: number;
  maxAllowedRealizedExpectedEdgeGapBps: number;
  maxAllowedReconciliationDefectRate: number;
  requireRecentReadinessPass: boolean;
  requireRecentSmokePass: boolean;
  requireDailyDecisionQualityReport: boolean;
  requireShadowDecisionLogging: boolean;
  requiredCheckpointMaxAgeMs: number;
  dailyDecisionQualityMaxAgeMs: number;
}

export interface DeploymentTierEvidenceSnapshot {
  tier: AppEnv['BOT_DEPLOYMENT_TIER'];
  incumbentVariantId: string | null;
  liveTradeCount: number;
  liveTrustScore: number | null;
  averageAbsoluteRealizedExpectedEdgeGapBps: number | null;
  reconciliationDefectRate: number | null;
  recentReadinessPassAt: string | null;
  recentSmokePassAt: string | null;
  dailyDecisionQualityReportAt: string | null;
  shadowDecisionLoggingEnabled: boolean;
}

export interface DeploymentTierEvidenceAssessment {
  ok: boolean;
  reasonCodes: string[];
  thresholds: DeploymentTierEvidenceThresholds;
  summary: DeploymentTierEvidenceSnapshot;
}

export function isLiveExecutableDeploymentTier(
  tier: AppEnv['BOT_DEPLOYMENT_TIER'],
): tier is LiveExecutableDeploymentTier {
  return tier === 'canary' || tier === 'cautious_live' || tier === 'scaled_live';
}

export function getDeploymentTierEvidenceThresholds(
  env: Pick<
    AppEnv,
    | 'BOT_DEPLOYMENT_TIER'
    | 'BOT_MIN_LIVE_TRADES_FOR_CANARY'
    | 'BOT_MIN_LIVE_TRADES_FOR_CAUTIOUS_LIVE'
    | 'BOT_MIN_LIVE_TRADES_FOR_SCALED_LIVE'
    | 'BOT_MAX_ALLOWED_REALIZED_EXPECTED_EDGE_GAP_BPS'
    | 'BOT_MAX_ALLOWED_RECONCILIATION_DEFECT_RATE'
    | 'BOT_ENABLE_SHADOW_DECISION_LOGGING'
    | 'BOT_REQUIRE_PRODUCTION_READINESS_PASS'
    | 'BOT_MAX_VENUE_SMOKE_AGE_MS'
  > = appEnv,
): DeploymentTierEvidenceThresholds {
  const liveTier = isLiveExecutableDeploymentTier(env.BOT_DEPLOYMENT_TIER);
  const minLiveTrades =
    env.BOT_DEPLOYMENT_TIER === 'scaled_live'
      ? env.BOT_MIN_LIVE_TRADES_FOR_SCALED_LIVE
      : env.BOT_DEPLOYMENT_TIER === 'cautious_live'
        ? env.BOT_MIN_LIVE_TRADES_FOR_CAUTIOUS_LIVE
        : env.BOT_DEPLOYMENT_TIER === 'canary'
          ? env.BOT_MIN_LIVE_TRADES_FOR_CANARY
          : 0;
  const minLiveTrustScore =
    env.BOT_DEPLOYMENT_TIER === 'scaled_live'
      ? 0.8
      : env.BOT_DEPLOYMENT_TIER === 'cautious_live'
        ? 0.65
        : env.BOT_DEPLOYMENT_TIER === 'canary'
          ? 0.45
          : 0;

  return {
    tier: env.BOT_DEPLOYMENT_TIER,
    minLiveTrades,
    minLiveTrustScore,
    maxAllowedRealizedExpectedEdgeGapBps:
      env.BOT_MAX_ALLOWED_REALIZED_EXPECTED_EDGE_GAP_BPS,
    maxAllowedReconciliationDefectRate:
      env.BOT_MAX_ALLOWED_RECONCILIATION_DEFECT_RATE,
    requireRecentReadinessPass:
      liveTier && env.BOT_REQUIRE_PRODUCTION_READINESS_PASS,
    requireRecentSmokePass: liveTier,
    requireDailyDecisionQualityReport: liveTier,
    requireShadowDecisionLogging: liveTier,
    requiredCheckpointMaxAgeMs: env.BOT_MAX_VENUE_SMOKE_AGE_MS,
    dailyDecisionQualityMaxAgeMs: 36 * 60 * 60 * 1000,
  };
}

export function assessDeploymentTierEvidence(
  snapshot: DeploymentTierEvidenceSnapshot,
  thresholds = getDeploymentTierEvidenceThresholds(),
): DeploymentTierEvidenceAssessment {
  if (!isLiveExecutableDeploymentTier(snapshot.tier)) {
    return {
      ok: true,
      reasonCodes: [],
      thresholds,
      summary: snapshot,
    };
  }

  const reasonCodes: string[] = [];
  if (!snapshot.incumbentVariantId) {
    reasonCodes.push('incumbent_variant_missing_for_live_tier');
  }
  if (snapshot.liveTradeCount < thresholds.minLiveTrades) {
    reasonCodes.push('live_trade_evidence_below_tier_threshold');
  }
  if ((snapshot.liveTrustScore ?? 0) < thresholds.minLiveTrustScore) {
    reasonCodes.push('live_trust_score_below_tier_threshold');
  }
  if (
    snapshot.averageAbsoluteRealizedExpectedEdgeGapBps == null &&
    snapshot.liveTradeCount > 0 &&
    snapshot.liveTradeCount >= thresholds.minLiveTrades
  ) {
    reasonCodes.push('realized_expected_edge_gap_unavailable');
  } else if (
    snapshot.averageAbsoluteRealizedExpectedEdgeGapBps != null &&
    snapshot.averageAbsoluteRealizedExpectedEdgeGapBps >
      thresholds.maxAllowedRealizedExpectedEdgeGapBps
  ) {
    reasonCodes.push('realized_expected_edge_gap_above_limit');
  }
  if (
    snapshot.reconciliationDefectRate == null &&
    snapshot.liveTradeCount > 0 &&
    snapshot.liveTradeCount >= thresholds.minLiveTrades
  ) {
    reasonCodes.push('reconciliation_defect_rate_unavailable');
  } else if (
    snapshot.reconciliationDefectRate != null &&
    snapshot.reconciliationDefectRate >
      thresholds.maxAllowedReconciliationDefectRate
  ) {
    reasonCodes.push('reconciliation_defect_rate_above_limit');
  }
  if (
    thresholds.requireRecentReadinessPass &&
    snapshot.recentReadinessPassAt == null
  ) {
    reasonCodes.push('recent_production_readiness_pass_missing');
  }
  if (thresholds.requireRecentSmokePass && snapshot.recentSmokePassAt == null) {
    reasonCodes.push('recent_smoke_test_missing');
  }
  if (
    thresholds.requireDailyDecisionQualityReport &&
    snapshot.dailyDecisionQualityReportAt == null
  ) {
    reasonCodes.push('daily_decision_quality_report_missing');
  }
  if (
    thresholds.requireShadowDecisionLogging &&
    !snapshot.shadowDecisionLoggingEnabled
  ) {
    reasonCodes.push('shadow_decision_logging_disabled');
  }

  return {
    ok: reasonCodes.length === 0,
    reasonCodes,
    thresholds,
    summary: snapshot,
  };
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

export class StartupRunbook {
  private readonly logger = new AppLogger('StartupRunbook');
  private readonly signerHealth = new SignerHealth();
  private readonly liveTrustScore = new LiveTrustScore();

  constructor(
    private readonly runtimeControl: RuntimeControlRepository,
    private readonly tradingClient: OfficialPolymarketTradingClient,
    private readonly externalPortfolioService: ExternalPortfolioService,
    private readonly smokeRunner: (
      env?: NodeJS.ProcessEnv,
      clientOverride?: OfficialPolymarketTradingClient,
    ) => Promise<PolymarketSmokeResult> = runPolymarketAuthenticatedSmoke,
    private readonly resolvedTradeLedger = new ResolvedTradeLedger(),
    private readonly deploymentRegistry = new StrategyDeploymentRegistry(),
  ) {}

  async run(
    operatingMode: TradingOperatingMode = 'live_trading',
  ): Promise<StartupRunbookResult> {
    const executedAt = new Date().toISOString();
    const cycleKey = `startup-runbook:${Date.now()}`;
    const steps: StartupRunbookStepResult[] = [];
    let smoke: PolymarketSmokeResult | null = null;
    let externalSnapshot: ExternalPortfolioSnapshot | null = null;
    const sentinelSimulation = operatingMode === 'sentinel_simulation';

    const preflight = await this.tradingClient.preflightVenue();
    steps.push({
      step: 'geoblock_clear',
      ok: preflight.ready,
      checkedAt: new Date().toISOString(),
      reasonCode: preflight.ready ? 'passed' : preflight.reasonCode ?? 'venue_preflight_failed',
      evidence: preflight.details ?? {},
    });
    if (!preflight.ready && appEnv.BOT_STARTUP_RUNBOOK_FAIL_FAST) {
      return this.finalize(cycleKey, executedAt, steps, smoke, externalSnapshot);
    }

    const signerHealth = this.signerHealth.check({
      privateKey: appEnv.POLY_PRIVATE_KEY,
      apiKey: appEnv.POLY_API_KEY,
      apiSecret: appEnv.POLY_API_SECRET,
      apiPassphrase: appEnv.POLY_API_PASSPHRASE,
    });
    const credentialsValid =
      signerHealth.healthy &&
      appEnv.SECRET_CONFIGURATION.healthy &&
      !!appEnv.POLY_PRIVATE_KEY &&
      !!appEnv.POLY_API_KEY &&
      !!appEnv.POLY_API_SECRET &&
      !!appEnv.POLY_API_PASSPHRASE;
    steps.push({
      step: 'credentials_valid',
      ok: credentialsValid,
      checkedAt: new Date().toISOString(),
      reasonCode: credentialsValid ? 'passed' : 'credentials_invalid',
      evidence: {
        signerHealthy: signerHealth.healthy,
        secretIssues: appEnv.SECRET_CONFIGURATION.issues,
        secretSources: appEnv.SECRET_CONFIGURATION.sources,
      },
    });
    if (!credentialsValid && appEnv.BOT_STARTUP_RUNBOOK_FAIL_FAST) {
      return this.finalize(cycleKey, executedAt, steps, smoke, externalSnapshot);
    }

    const funderProxyValid = this.validateIdentityMode();
    steps.push({
      step: 'funder_proxy_valid',
      ok: funderProxyValid.ok,
      checkedAt: new Date().toISOString(),
      reasonCode: funderProxyValid.reasonCode,
      evidence: funderProxyValid.evidence,
    });
    if (!funderProxyValid.ok && appEnv.BOT_STARTUP_RUNBOOK_FAIL_FAST) {
      return this.finalize(cycleKey, executedAt, steps, smoke, externalSnapshot);
    }

    try {
      const [openOrders, trades, balance] = await Promise.all([
        this.tradingClient.getOpenOrders(),
        this.tradingClient.getTrades(),
        this.tradingClient.getBalanceAllowance({ assetType: 'COLLATERAL' }),
      ]);

      steps.push({
        step: 'api_key_works',
        ok: true,
        checkedAt: new Date().toISOString(),
        reasonCode: 'passed',
        evidence: {
          openOrders: openOrders.length,
        },
      });
      steps.push({
        step: 'dry_authenticated_read_path_tested',
        ok: true,
        checkedAt: new Date().toISOString(),
        reasonCode: 'passed',
        evidence: {
          trades: trades.length,
          collateralBalance: balance.balance,
          collateralAllowance: balance.allowance,
        },
      });
    } catch (error) {
      const reasonCode = 'authenticated_read_failed';
      steps.push({
        step: 'api_key_works',
        ok: false,
        checkedAt: new Date().toISOString(),
        reasonCode,
        evidence: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      steps.push({
        step: 'dry_authenticated_read_path_tested',
        ok: false,
        checkedAt: new Date().toISOString(),
        reasonCode,
        evidence: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      if (appEnv.BOT_STARTUP_RUNBOOK_FAIL_FAST) {
        return this.finalize(cycleKey, executedAt, steps, smoke, externalSnapshot);
      }
    }

    const startupTokenId = appEnv.POLY_STARTUP_TOKEN_ID ?? process.env.POLY_SMOKE_TOKEN_ID ?? null;
    if (!startupTokenId) {
      steps.push({
        step: 'orderbook_data_channel_live',
        ok: sentinelSimulation,
        checkedAt: new Date().toISOString(),
        reasonCode: sentinelSimulation ? 'not_required_for_sentinel' : 'startup_token_id_missing',
        evidence: sentinelSimulation ? { operatingMode } : {},
      });
      if (!sentinelSimulation && appEnv.BOT_STARTUP_RUNBOOK_FAIL_FAST) {
        return this.finalize(cycleKey, executedAt, steps, smoke, externalSnapshot);
      }
    } else {
      try {
        const orderBook = await this.tradingClient.getOrderBook(startupTokenId);
        const ok =
          orderBook.tickSize != null &&
          orderBook.minOrderSize != null &&
          orderBook.negRisk != null;
        steps.push({
          step: 'orderbook_data_channel_live',
          ok,
          checkedAt: new Date().toISOString(),
          reasonCode: ok ? 'passed' : 'orderbook_metadata_incomplete',
          evidence: {
            tokenId: startupTokenId,
            tickSize: orderBook.tickSize,
            minOrderSize: orderBook.minOrderSize,
            negRisk: orderBook.negRisk,
          },
        });
      } catch (error) {
        steps.push({
          step: 'orderbook_data_channel_live',
          ok: false,
          checkedAt: new Date().toISOString(),
          reasonCode: 'orderbook_data_channel_failed',
          evidence: {
            tokenId: startupTokenId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

    try {
      externalSnapshot = await this.externalPortfolioService.capture({
        cycleKey,
        source: 'startup_runbook_external_truth',
      });
      const tradingPermissions = externalSnapshot.tradingPermissions ?? {
        allowNewEntries: false,
        allowPositionManagement: false,
        reasonCodes: ['trading_permissions_missing'],
      };
      const externalTruthReasonCode = this.resolveExternalTruthReasonCode({
        freshnessVerdict: externalSnapshot.freshness.overallVerdict,
        allowPositionManagement: tradingPermissions.allowPositionManagement,
        reasonCodes: tradingPermissions.reasonCodes ?? [],
      });
      const externalTruthHealthy = externalTruthReasonCode === 'passed';
      steps.push({
        step: 'external_truth_fresh',
        ok: externalTruthHealthy,
        checkedAt: new Date().toISOString(),
        reasonCode: externalTruthReasonCode,
        evidence: {
          freshness: externalSnapshot.freshness.overallVerdict,
          allowNewEntries: tradingPermissions.allowNewEntries,
          allowPositionManagement: tradingPermissions.allowPositionManagement,
          reasonCodes: tradingPermissions.reasonCodes ?? [],
          recoveryMode: externalSnapshot.recovery.mode,
          divergenceStatus: externalSnapshot.divergence.status,
          divergenceClasses: externalSnapshot.divergence.classes,
          workingOpenOrders: externalSnapshot.workingOpenOrders,
        },
      });
    } catch (error) {
      steps.push({
        step: 'external_truth_fresh',
        ok: false,
        checkedAt: new Date().toISOString(),
        reasonCode: 'external_truth_capture_failed',
        evidence: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      if (appEnv.BOT_STARTUP_RUNBOOK_FAIL_FAST) {
        return this.finalize(cycleKey, executedAt, steps, smoke, externalSnapshot);
      }
    }

    let recentSmokePassAt: string | null = null;
    if (sentinelSimulation) {
      for (const step of [
        'recent_smoke_test_timestamp',
        'authenticated_venue_smoke_gate',
        'heartbeat_path_tested',
        'cancel_path_tested',
      ] as const) {
        steps.push({
          step,
          ok: true,
          checkedAt: new Date().toISOString(),
          reasonCode: 'not_required_for_sentinel',
          evidence: {
            operatingMode,
          },
        });
      }
    } else {
      const latestSmokeCheckpoint = await this.runtimeControl.getLatestCheckpoint(
        'authenticated_venue_smoke_suite',
      );
      const recentSmokePassed =
        latestSmokeCheckpoint?.status === 'completed' &&
        Date.now() - latestSmokeCheckpoint.processedAt.getTime() <=
          appEnv.BOT_MAX_VENUE_SMOKE_AGE_MS;

      if (appEnv.BOT_RUN_VENUE_SMOKE_ON_STARTUP) {
        smoke = await this.smokeRunner(process.env, this.tradingClient);
        await this.runtimeControl.recordReconciliationCheckpoint({
          cycleKey: `smoke-gate:${Date.now()}`,
          source: 'authenticated_venue_smoke_suite',
          status: smoke.success ? 'completed' : 'failed',
          details: {
            executedAt: smoke.executedAt,
            freshnessTtlMs: smoke.freshnessTtlMs,
            steps: smoke.steps,
            orderId: smoke.orderId,
          },
        });
      }

      const effectiveSmokeSuccess = smoke?.success ?? recentSmokePassed;
      recentSmokePassAt = smoke?.success
        ? smoke.executedAt
        : recentSmokePassed
          ? latestSmokeCheckpoint?.processedAt?.toISOString() ?? null
          : null;
      steps.push({
        step: 'recent_smoke_test_timestamp',
        ok:
          recentSmokePassAt != null ||
          !isLiveExecutableDeploymentTier(appEnv.BOT_DEPLOYMENT_TIER),
        checkedAt: new Date().toISOString(),
        reasonCode:
          recentSmokePassAt != null
            ? 'passed'
            : isLiveExecutableDeploymentTier(appEnv.BOT_DEPLOYMENT_TIER)
              ? 'recent_smoke_test_missing'
              : 'not_required_for_tier',
        evidence: {
          tier: appEnv.BOT_DEPLOYMENT_TIER,
          recentSmokePassAt,
          maxAllowedAgeMs: appEnv.BOT_MAX_VENUE_SMOKE_AGE_MS,
          checkpointAt: latestSmokeCheckpoint?.processedAt?.toISOString() ?? null,
          checkpointStatus: latestSmokeCheckpoint?.status ?? null,
        },
      });
      steps.push({
        step: 'authenticated_venue_smoke_gate',
        ok: effectiveSmokeSuccess,
        checkedAt: new Date().toISOString(),
        reasonCode: effectiveSmokeSuccess ? 'passed' : 'recent_smoke_gate_missing',
        evidence: smoke
          ? {
              executedAt: smoke.executedAt,
              success: smoke.success,
            }
          : {
              checkpointAt: latestSmokeCheckpoint?.processedAt?.toISOString() ?? null,
              checkpointStatus: latestSmokeCheckpoint?.status ?? null,
            },
      });

      const heartbeatStep = smoke?.steps.find((step) => step.step === 'heartbeat');
      const cancelStep = smoke?.steps.find((step) => step.step === 'cancel');
      steps.push({
        step: 'heartbeat_path_tested',
        ok: heartbeatStep?.ok ?? recentSmokePassed,
        checkedAt: new Date().toISOString(),
        reasonCode:
          heartbeatStep?.reasonCode ?? (recentSmokePassed ? 'passed' : 'smoke_not_recent'),
        evidence: heartbeatStep?.evidence ?? {
          smokeCheckpointAt: latestSmokeCheckpoint?.processedAt?.toISOString() ?? null,
        },
      });
      steps.push({
        step: 'cancel_path_tested',
        ok: cancelStep?.ok ?? recentSmokePassed,
        checkedAt: new Date().toISOString(),
        reasonCode:
          cancelStep?.reasonCode ?? (recentSmokePassed ? 'passed' : 'smoke_not_recent'),
        evidence: cancelStep?.evidence ?? {
          smokeCheckpointAt: latestSmokeCheckpoint?.processedAt?.toISOString() ?? null,
        },
      });
    }

    const latestReadinessCheckpoint = await this.runtimeControl.getLatestCheckpoint(
      'production_readiness_suite',
    );
    const recentReadinessPassed =
      latestReadinessCheckpoint?.status === 'completed' &&
      Date.now() - latestReadinessCheckpoint.processedAt.getTime() <=
        appEnv.BOT_MAX_VENUE_SMOKE_AGE_MS;
    const recentReadinessPassAt = recentReadinessPassed
      ? latestReadinessCheckpoint?.processedAt?.toISOString() ?? null
      : null;
    steps.push({
      step: 'recent_production_readiness_pass',
      ok:
        recentReadinessPassAt != null ||
        !getDeploymentTierEvidenceThresholds().requireRecentReadinessPass,
      checkedAt: new Date().toISOString(),
      reasonCode:
        recentReadinessPassAt != null
          ? 'passed'
          : getDeploymentTierEvidenceThresholds().requireRecentReadinessPass
            ? 'recent_production_readiness_pass_missing'
            : 'not_required_for_tier',
      evidence: {
        tier: appEnv.BOT_DEPLOYMENT_TIER,
        recentReadinessPassAt,
        checkpointAt: latestReadinessCheckpoint?.processedAt?.toISOString() ?? null,
        checkpointStatus: latestReadinessCheckpoint?.status ?? null,
        maxAllowedAgeMs: appEnv.BOT_MAX_VENUE_SMOKE_AGE_MS,
      },
    });

    const [deploymentRegistryState, recentResolvedTrades, latestDecisionQualityReport] =
      await Promise.all([
        this.deploymentRegistry.load(),
        this.resolvedTradeLedger.loadWindow({
          start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
          end: new Date(),
        }),
        readLatestDailyDecisionQualityReport(
          path.dirname(this.resolvedTradeLedger.getPath()),
        ),
      ]);
    const incumbentVariantId = deploymentRegistryState.incumbentVariantId;
    const liveTrustDecision = this.liveTrustScore.evaluate({
      strategyVariantId: incumbentVariantId,
      regime: null,
      resolvedTrades: recentResolvedTrades,
    });
    const filteredTrades = recentResolvedTrades.filter((trade) =>
      incumbentVariantId == null ? true : trade.strategyVariantId === incumbentVariantId,
    );
    const averageAbsoluteRealizedExpectedEdgeGapBps = average(
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
    );
    const reconciliationDefectRate =
      filteredTrades.length === 0
        ? null
        : filteredTrades.filter(
            (trade) =>
              trade.lifecycleState !== 'economically_resolved_with_portfolio_truth',
          ).length / filteredTrades.length;
    const tierEvidenceAssessment = assessDeploymentTierEvidence({
      tier: appEnv.BOT_DEPLOYMENT_TIER,
      incumbentVariantId,
      liveTradeCount: filteredTrades.length,
      liveTrustScore: liveTrustDecision.trustScore,
      averageAbsoluteRealizedExpectedEdgeGapBps,
      reconciliationDefectRate,
      recentReadinessPassAt,
      recentSmokePassAt,
      dailyDecisionQualityReportAt:
        latestDecisionQualityReport?.generatedAt ?? null,
      shadowDecisionLoggingEnabled: appEnv.BOT_ENABLE_SHADOW_DECISION_LOGGING,
    });
    steps.push({
      step: 'deployment_tier_live_evidence',
      ok: tierEvidenceAssessment.ok,
      checkedAt: new Date().toISOString(),
      reasonCode: tierEvidenceAssessment.ok
        ? 'passed'
        : tierEvidenceAssessment.reasonCodes[0] ?? 'deployment_tier_live_evidence_failed',
      evidence: {
        ...tierEvidenceAssessment,
        registryTrustScore:
          incumbentVariantId != null
            ? deploymentRegistryState.variants[incumbentVariantId]?.liveTrustScore ?? null
            : null,
        liveTrustDecision,
      },
    });

    return this.finalize(cycleKey, executedAt, steps, smoke, externalSnapshot);
  }

  async runSentinelSimulation(): Promise<StartupRunbookResult> {
    return this.run('sentinel_simulation');
  }

  private async finalize(
    cycleKey: string,
    executedAt: string,
    steps: StartupRunbookStepResult[],
    smoke: PolymarketSmokeResult | null,
    externalSnapshot: ExternalPortfolioSnapshot | null,
  ): Promise<StartupRunbookResult> {
    const failure = steps.find((step) => !step.ok) ?? null;
    const result: StartupRunbookResult = {
      passed: failure === null,
      reasonCode: failure?.reasonCode ?? null,
      executedAt,
      steps,
      smoke,
      externalSnapshot,
    };

    await this.runtimeControl.recordReconciliationCheckpoint({
      cycleKey,
      source: 'startup_runbook',
      status: result.passed ? 'completed' : 'failed',
      details: {
        executedAt,
        reasonCode: result.reasonCode,
        steps,
      },
    });

    if (result.passed) {
      this.logger.log('Startup runbook passed.', {
        reasonCode: null,
      });
    } else {
      this.logger.warn('Startup runbook failed.', {
        reasonCode: result.reasonCode,
      });
    }

    return result;
  }

  private validateIdentityMode(): {
    ok: boolean;
    reasonCode: string;
    evidence: Record<string, unknown>;
  } {
    const isAddress = (value: string | undefined) =>
      !!value && /^0x[a-fA-F0-9]{40}$/.test(value.trim());
    const signatureType = appEnv.POLY_SIGNATURE_TYPE;
    const funder = appEnv.POLY_FUNDER;
    const profileAddress = appEnv.POLY_PROFILE_ADDRESS;

    if (funder && !isAddress(funder)) {
      return {
        ok: false,
        reasonCode: 'invalid_funder_address',
        evidence: { signatureType, hasFunder: true, hasProfileAddress: !!profileAddress },
      };
    }

    if (profileAddress && !isAddress(profileAddress)) {
      return {
        ok: false,
        reasonCode: 'invalid_profile_address',
        evidence: { signatureType, hasFunder: !!funder, hasProfileAddress: true },
      };
    }

    if (signatureType > 0 && !funder) {
      return {
        ok: false,
        reasonCode: 'proxy_signature_requires_funder',
        evidence: { signatureType, hasFunder: false, hasProfileAddress: !!profileAddress },
      };
    }

    return {
      ok: true,
      reasonCode: 'passed',
      evidence: {
        signatureType,
        hasFunder: !!funder,
        hasProfileAddress: !!profileAddress,
      },
    };
  }

  private resolveExternalTruthReasonCode(input: {
    freshnessVerdict: ExternalPortfolioSnapshot['freshness']['overallVerdict'];
    allowPositionManagement: boolean;
    reasonCodes: string[];
  }): string {
    if (input.freshnessVerdict === 'stale') {
      return 'external_truth_stale';
    }

    if (input.allowPositionManagement) {
      return 'passed';
    }

    if (input.reasonCodes.includes('trading_permissions_missing')) {
      return 'external_truth_permissions_missing';
    }

    return 'external_truth_position_management_blocked';
  }
}
