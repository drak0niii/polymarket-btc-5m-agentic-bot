import { AppLogger } from '@worker/common/logger';
import { appEnv } from '@worker/config/env';
import { SignerHealth } from '@polymarket-btc-5m-agentic-bot/signing-engine';
import { OfficialPolymarketTradingClient } from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';
import {
  ExternalPortfolioService,
  ExternalPortfolioSnapshot,
} from '@worker/portfolio/external-portfolio.service';
import { RuntimeControlRepository } from './runtime-control.repository';
import {
  PolymarketSmokeResult,
  runPolymarketAuthenticatedSmoke,
} from '@worker/smoke/polymarket-auth-smoke';

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
  | 'authenticated_venue_smoke_gate';

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

export class StartupRunbook {
  private readonly logger = new AppLogger('StartupRunbook');
  private readonly signerHealth = new SignerHealth();

  constructor(
    private readonly runtimeControl: RuntimeControlRepository,
    private readonly tradingClient: OfficialPolymarketTradingClient,
    private readonly externalPortfolioService: ExternalPortfolioService,
    private readonly smokeRunner: (
      env?: NodeJS.ProcessEnv,
      clientOverride?: OfficialPolymarketTradingClient,
    ) => Promise<PolymarketSmokeResult> = runPolymarketAuthenticatedSmoke,
  ) {}

  async run(): Promise<StartupRunbookResult> {
    const executedAt = new Date().toISOString();
    const cycleKey = `startup-runbook:${Date.now()}`;
    const steps: StartupRunbookStepResult[] = [];
    let smoke: PolymarketSmokeResult | null = null;
    let externalSnapshot: ExternalPortfolioSnapshot | null = null;

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
        ok: false,
        checkedAt: new Date().toISOString(),
        reasonCode: 'startup_token_id_missing',
        evidence: {},
      });
      if (appEnv.BOT_STARTUP_RUNBOOK_FAIL_FAST) {
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
      const externalTruthHealthy =
        externalSnapshot.freshness.overallVerdict !== 'stale' &&
        tradingPermissions.allowPositionManagement;
      steps.push({
        step: 'external_truth_fresh',
        ok: externalTruthHealthy,
        checkedAt: new Date().toISOString(),
        reasonCode: externalTruthHealthy ? 'passed' : 'external_truth_not_fresh',
        evidence: {
          freshness: externalSnapshot.freshness.overallVerdict,
          allowNewEntries: tradingPermissions.allowNewEntries,
          allowPositionManagement: tradingPermissions.allowPositionManagement,
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

    const latestSmokeCheckpoint = await this.runtimeControl.getLatestCheckpoint(
      'authenticated_venue_smoke_suite',
    );
    const recentSmokePassed =
      latestSmokeCheckpoint?.status === 'completed' &&
      Date.now() - latestSmokeCheckpoint.processedAt.getTime() <= appEnv.BOT_MAX_VENUE_SMOKE_AGE_MS;

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
      reasonCode: heartbeatStep?.reasonCode ?? (recentSmokePassed ? 'passed' : 'smoke_not_recent'),
      evidence: heartbeatStep?.evidence ?? {
        smokeCheckpointAt: latestSmokeCheckpoint?.processedAt?.toISOString() ?? null,
      },
    });
    steps.push({
      step: 'cancel_path_tested',
      ok: cancelStep?.ok ?? recentSmokePassed,
      checkedAt: new Date().toISOString(),
      reasonCode: cancelStep?.reasonCode ?? (recentSmokePassed ? 'passed' : 'smoke_not_recent'),
      evidence: cancelStep?.evidence ?? {
        smokeCheckpointAt: latestSmokeCheckpoint?.processedAt?.toISOString() ?? null,
      },
    });

    return this.finalize(cycleKey, executedAt, steps, smoke, externalSnapshot);
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
}
