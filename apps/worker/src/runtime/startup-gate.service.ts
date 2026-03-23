import { AppLogger } from '@worker/common/logger';
import { appEnv } from '@worker/config/env';
import { SignerHealth } from '@polymarket-btc-5m-agentic-bot/signing-engine';
import {
  StartupRunbook,
  StartupRunbookResult,
} from './startup-runbook';
import {
  CrashRecoveryResult,
  CrashRecoveryService,
} from './crash-recovery';
import { RuntimeControlRepository } from './runtime-control.repository';
import { MarketWebSocketStateService } from '@polymarket-btc-5m-agentic-bot/market-data';
import { UserWebSocketStateService } from './user-websocket-state.service';

export interface StartupGateCheckResult {
  name: string;
  passed: boolean;
  blocking: boolean;
  checkedAt: string;
  reasonCode: string | null;
  evidence: Record<string, unknown>;
}

export interface StartupGateVerdict {
  passed: boolean;
  timestamp: string;
  mode: 'live' | 'test';
  checks: StartupGateCheckResult[];
  blockingReasons: string[];
  warningReasons: string[];
  evidence: Record<string, unknown>;
}

export class StartupGateService {
  private readonly logger = new AppLogger('StartupGateService');
  private readonly signerHealth = new SignerHealth();

  constructor(
    private readonly runtimeControl: RuntimeControlRepository,
    private readonly startupRunbook: StartupRunbook,
    private readonly crashRecoveryService?: CrashRecoveryService,
    private readonly marketStreamService?: MarketWebSocketStateService,
    private readonly userStreamService?: UserWebSocketStateService,
  ) {}

  async evaluate(mode: 'live' | 'test' = 'live'): Promise<StartupGateVerdict> {
    const timestamp = new Date().toISOString();
    const checks: StartupGateCheckResult[] = [];

    const secretPolicyPassed =
      !appEnv.IS_PRODUCTION || appEnv.SECRET_CONFIGURATION.productionPolicyPassed;
    checks.push({
      name: 'production_secret_policy',
      passed: secretPolicyPassed,
      blocking: true,
      checkedAt: timestamp,
      reasonCode: secretPolicyPassed ? null : 'production_secret_policy_failed',
      evidence: {
        issues: appEnv.SECRET_CONFIGURATION.issues,
        sources: appEnv.SECRET_CONFIGURATION.sources,
        requiredSecrets: appEnv.SECRET_CONFIGURATION.evidence.requiredSecrets,
        loadedFiles: appEnv.SECRET_CONFIGURATION.loadedFiles,
      },
    });

    const signerHealth = this.signerHealth.check({
      privateKey: appEnv.POLY_PRIVATE_KEY,
      apiKey: appEnv.POLY_API_KEY,
      apiSecret: appEnv.POLY_API_SECRET,
      apiPassphrase: appEnv.POLY_API_PASSPHRASE,
    });
    checks.push({
      name: 'signer_health',
      passed: signerHealth.healthy,
      blocking: true,
      checkedAt: timestamp,
      reasonCode: signerHealth.healthy ? null : signerHealth.reasonCodes.join(','),
      evidence: {
        healthy: signerHealth.healthy,
        reasonCodes: signerHealth.reasonCodes,
        checks: signerHealth.checks,
        checkedAt: signerHealth.checkedAt,
      },
    });

    const runbook = await this.startupRunbook.run();
    checks.push(this.asCheck('startup_runbook', runbook.passed, runbook.reasonCode, runbook));

    if (this.marketStreamService) {
      const marketStreamHealth = this.marketStreamService.evaluateHealth();
      const preBootstrap = marketStreamHealth.connectionStatus === 'idle';
      checks.push({
        name: 'market_stream_bootstrap',
        passed: preBootstrap ? true : marketStreamHealth.healthy,
        blocking: !preBootstrap,
        checkedAt: timestamp,
        reasonCode: preBootstrap ? null : marketStreamHealth.reasonCode,
        evidence: {
          ...marketStreamHealth,
          preBootstrap,
        } as unknown as Record<string, unknown>,
      });
    }

    if (this.userStreamService) {
      const userStreamHealth = this.userStreamService.evaluateHealth();
      const preBootstrap = userStreamHealth.connectionStatus === 'idle';
      checks.push({
        name: 'user_stream_bootstrap',
        passed: preBootstrap ? true : userStreamHealth.healthy,
        blocking: !preBootstrap,
        checkedAt: timestamp,
        reasonCode: preBootstrap ? null : userStreamHealth.reasonCode,
        evidence: {
          ...userStreamHealth,
          preBootstrap,
        } as unknown as Record<string, unknown>,
      });
    }

    let recovery: CrashRecoveryResult | null = null;
    if (appEnv.BOT_STARTUP_RECOVERY_REQUIRED && this.crashRecoveryService) {
      recovery = await this.crashRecoveryService.run();
      checks.push(
        this.asCheck(
          'crash_recovery',
          recovery.recovered,
          recovery.reasonCode,
          recovery,
        ),
      );
    }

    const blockingReasons = checks
      .filter((check) => check.blocking && !check.passed)
      .map((check) => `${check.name}:${check.reasonCode ?? 'failed'}`);
    const warningReasons = checks
      .filter((check) => !check.blocking && !check.passed)
      .map((check) => `${check.name}:${check.reasonCode ?? 'failed'}`);

    const verdict: StartupGateVerdict = {
      passed: blockingReasons.length === 0,
      timestamp,
      mode,
      checks,
      blockingReasons,
      warningReasons,
      evidence: {
        secretConfiguration: appEnv.SECRET_CONFIGURATION,
        startupRunbook: runbook,
        crashRecovery: recovery,
      },
    };

    await this.runtimeControl.recordReconciliationCheckpoint({
      cycleKey: `startup-gate:${Date.now()}`,
      source: 'startup_gate_verdict',
      status: verdict.passed ? 'completed' : 'failed',
      details: verdict as unknown as Record<string, unknown>,
    });

    if (verdict.passed) {
      this.logger.log('Startup gate passed.');
    } else {
      this.logger.warn('Startup gate failed.', {
        blockingReasons: verdict.blockingReasons,
      });
    }

    return verdict;
  }

  async assertLiveStartupAllowed(): Promise<StartupGateVerdict> {
    const verdict = await this.evaluate(appEnv.IS_TEST ? 'test' : 'live');
    if (!verdict.passed) {
      throw new Error(
        `startup_gate_failed:${verdict.blockingReasons.join('|') || 'unknown'}`,
      );
    }

    return verdict;
  }

  private asCheck(
    name: string,
    passed: boolean,
    reasonCode: string | null,
    evidence: StartupRunbookResult | CrashRecoveryResult,
  ): StartupGateCheckResult {
    return {
      name,
      passed,
      blocking: true,
      checkedAt: new Date().toISOString(),
      reasonCode,
      evidence: evidence as unknown as Record<string, unknown>,
    };
  }
}
