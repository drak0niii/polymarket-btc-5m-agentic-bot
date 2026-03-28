import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { type TradingOperatingMode } from '@polymarket-btc-5m-agentic-bot/domain';
import { appEnv } from '../config/env';
import { BotStateStore } from '../runtime/bot-state';
import { StartStopManager } from '../runtime/start-stop-manager';
import { StartupGateService } from '../runtime/startup-gate.service';
import {
  assessDeploymentTierEvidence,
  getDeploymentTierEvidenceThresholds,
} from '../runtime/startup-runbook';
import {
  getProductionReadinessArtifactPath,
  runProductionReadiness,
} from '../smoke/production-readiness';

async function testPhaseNineTierEvidenceAssessmentBlocksScaledLiveWithoutProof(): Promise<void> {
  const thresholds = getDeploymentTierEvidenceThresholds({
    ...appEnv,
    BOT_DEPLOYMENT_TIER: 'scaled_live',
    BOT_MIN_LIVE_TRADES_FOR_SCALED_LIVE: 20,
  });
  const assessment = assessDeploymentTierEvidence(
    {
      tier: 'scaled_live',
      incumbentVariantId: null,
      liveTradeCount: 3,
      liveTrustScore: 0.42,
      averageAbsoluteRealizedExpectedEdgeGapBps: 78,
      reconciliationDefectRate: 0.2,
      recentReadinessPassAt: null,
      recentSmokePassAt: null,
      dailyDecisionQualityReportAt: null,
      shadowDecisionLoggingEnabled: false,
    },
    thresholds,
  );

  assert.strictEqual(assessment.ok, false);
  assert.strictEqual(
    assessment.reasonCodes.includes('live_trade_evidence_below_tier_threshold'),
    true,
  );
  assert.strictEqual(
    assessment.reasonCodes.includes('live_trust_score_below_tier_threshold'),
    true,
  );
  assert.strictEqual(
    assessment.reasonCodes.includes('recent_production_readiness_pass_missing'),
    true,
  );
  assert.strictEqual(
    assessment.reasonCodes.includes('shadow_decision_logging_disabled'),
    true,
  );
}

async function testPhaseNinePaperTierDoesNotRequireLiveProof(): Promise<void> {
  const assessment = assessDeploymentTierEvidence({
    tier: 'paper',
    incumbentVariantId: null,
    liveTradeCount: 0,
    liveTrustScore: null,
    averageAbsoluteRealizedExpectedEdgeGapBps: null,
    reconciliationDefectRate: null,
    recentReadinessPassAt: null,
    recentSmokePassAt: null,
    dailyDecisionQualityReportAt: null,
    shadowDecisionLoggingEnabled: false,
  });

  assert.strictEqual(assessment.ok, true);
  assert.deepStrictEqual(assessment.reasonCodes, []);
}

async function testPhaseNineStartupGateAddsLiveTierBlockingCheck(): Promise<void> {
  const checkpoints: Array<{ source: string; status: string }> = [];
  await withEnvOverrides(
    {
      BOT_DEPLOYMENT_TIER: 'scaled_live',
      BOT_REQUIRE_PRODUCTION_READINESS_PASS: true,
    },
    async () => {
      const gate = new StartupGateService(
        {
          recordReconciliationCheckpoint: async (input: { source: string; status: string }) => {
            checkpoints.push(input);
          },
        } as never,
        {
          run: async () => ({
            passed: false,
            reasonCode: 'recent_production_readiness_pass_missing',
            executedAt: new Date().toISOString(),
            steps: [],
            smoke: null,
            externalSnapshot: null,
          }),
        } as never,
      );

      const verdict = await gate.evaluate('live');
      const liveTierCheck = verdict.checks.find(
        (check) => check.name === 'live_deployment_tier_enforcement',
      );

      assert.strictEqual(verdict.passed, false);
      assert.strictEqual(liveTierCheck?.blocking, true);
      assert.strictEqual(liveTierCheck?.passed, false);
      assert.strictEqual(
        verdict.blockingReasons.includes(
          'live_deployment_tier_enforcement:recent_production_readiness_pass_missing',
        ),
        true,
      );
    },
  );

  assert.strictEqual(
    checkpoints.some(
      (entry) => entry.source === 'startup_gate_verdict' && entry.status === 'failed',
    ),
    true,
  );
}

async function testPhaseNineStartupGateUsesSentinelRunbook(): Promise<void> {
  let liveRunInvoked = false;
  let sentinelRunInvoked = false;

  const gate = new StartupGateService(
    {
      recordReconciliationCheckpoint: async () => undefined,
    } as never,
    {
      run: async () => {
        liveRunInvoked = true;
        return {
          passed: false,
          reasonCode: 'live_runbook_should_not_execute',
          executedAt: new Date().toISOString(),
          steps: [],
          smoke: null,
          externalSnapshot: null,
        };
      },
      runSentinelSimulation: async () => {
        sentinelRunInvoked = true;
        return {
          passed: true,
          reasonCode: null,
          executedAt: new Date().toISOString(),
          steps: [],
          smoke: null,
          externalSnapshot: null,
        };
      },
    } as never,
  );

  const verdict = await gate.evaluate('sentinel');

  assert.strictEqual(verdict.passed, true);
  assert.strictEqual(liveRunInvoked, false);
  assert.strictEqual(sentinelRunInvoked, true);
}

async function testPhaseNineStartStopManagerUsesOperatingModeAwareGate(): Promise<void> {
  const stateStore = new BotStateStore('stopped');
  let requestedMode: string | null = null;
  const manager = new StartStopManager(
    stateStore,
    {
      assertStartupAllowedForMode: async (operatingMode: TradingOperatingMode) => {
        requestedMode = operatingMode;
        return {
          passed: true,
          timestamp: new Date().toISOString(),
          mode: 'sentinel',
          checks: [],
          blockingReasons: [],
          warningReasons: [],
          evidence: {},
        };
      },
    } as never,
  );

  await manager.start('manual start', 'sentinel_simulation');

  assert.strictEqual(requestedMode, 'sentinel_simulation');
  assert.strictEqual(stateStore.getState(), 'bootstrapping');
}

async function testPhaseNineProductionReadinessPersistsArtifact(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase9-readiness-'));
  await withEnvOverrides(
    {
      BOT_DEPLOYMENT_TIER: 'paper',
      POLY_SMOKE_TOKEN_ID: 'yes1',
      POLY_SMOKE_PRICE: '0.5',
      POLY_SMOKE_SIZE: '1',
      POLY_SMOKE_EXECUTE: 'true',
      POLY_SMOKE_ORDER_TYPE: 'GTC',
      POLY_SMOKE_EXPIRATION_SECONDS: '75',
      POLY_SMOKE_MAX_WAIT_MS: '25',
      POLY_SMOKE_POLL_INTERVAL_MS: '10',
    },
    async () => {
      const timestamp = new Date().toISOString();
      const marketHealth = {
        healthy: true,
        trusted: true,
        trackedAssets: 1,
        lastEventAt: timestamp,
        lastTrafficAt: timestamp,
        bootstrapCompletedAt: timestamp,
        reasonCode: null,
      };
      const userHealth = {
        healthy: true,
        trusted: true,
        subscribedMarkets: 1,
        lastEventAt: timestamp,
        lastTrafficAt: timestamp,
        reasonCode: null,
        connectionStatus: 'connected' as const,
        connected: true,
        stale: false,
        lastEventAgeMs: 0,
        lastTrafficAgeMs: 0,
        openOrders: 0,
        liveOrdersWhileStale: false,
        recentTrades: 0,
        divergenceDetected: false,
        lastReconciliationAt: timestamp,
        reconnectAttempt: 0,
      };

      const result = await runProductionReadiness({
        artifactRootDir: rootDir,
        connectPrisma: false,
        trackedMarkets: [
          {
            id: 'm1',
            tokenIdYes: 'yes1',
            tokenIdNo: 'no1',
          },
        ],
        prisma: {
          market: {
            findMany: async () => [],
          },
        },
        runtimeControl: {
          recordReconciliationCheckpoint: async () => undefined,
          getLatestCheckpoint: async () => null,
        },
        marketStreamService: {
          start: async () => marketHealth,
          evaluateHealth: () => ({
            ...marketHealth,
            connectionStatus: 'connected' as const,
            staleAssets: [],
            metadataInvalidations: [],
            reconnectAttempt: 0,
          }),
          getAssetState: () => ({
            lastUpdateAt: timestamp,
          }),
          stop: () => undefined,
        } as never,
        userStreamService: {
          start: async () => userHealth,
          evaluateHealth: () => userHealth,
          getOpenOrderIds: () => [],
          getTradeIds: () => [],
          detectDivergence: () => false,
          markReconciled: () => undefined,
          stop: () => undefined,
        } as never,
        reconnectMarketStreamService: {
          start: async () => marketHealth,
          evaluateHealth: () => ({
            ...marketHealth,
            connectionStatus: 'connected' as const,
            staleAssets: [],
            metadataInvalidations: [],
            reconnectAttempt: 0,
          }),
          stop: () => undefined,
        } as never,
        reconnectUserStreamService: {
          start: async () => userHealth,
          evaluateHealth: () => userHealth,
          stop: () => undefined,
        } as never,
        tradingClient: {
          getOpenOrders: async () => [],
          getTrades: async () => [],
        } as never,
        externalPortfolioService: {
          capture: async () => ({
            freshness: {
              overallVerdict: 'fresh',
            },
            tradingPermissions: {
              allowNewEntries: true,
              allowPositionManagement: true,
            },
            divergence: null,
            recovery: null,
            workingOpenOrders: 0,
          }),
        } as never,
        smokeRunner: async () => ({
          success: false,
          executedAt: timestamp,
          freshnessTtlMs: 25,
          orderId: null,
          steps: [],
        }),
      });

      const artifactPath = getProductionReadinessArtifactPath(rootDir);
      const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as {
        success: boolean;
      };
      assert.strictEqual(fs.existsSync(artifactPath), true);
      assert.strictEqual(result.success, false);
      assert.strictEqual(artifact.success, false);
    },
  );
}

async function withEnvOverrides(
  overrides: Record<string, string | boolean>,
  fn: () => Promise<void>,
): Promise<void> {
  const envRecord = appEnv as unknown as Record<string, unknown>;
  const previousProcessEnv = new Map<string, string | undefined>();
  const previousAppEnv = new Map<string, unknown>();

  for (const [key, value] of Object.entries(overrides)) {
    previousProcessEnv.set(key, process.env[key]);
    process.env[key] = String(value);
    previousAppEnv.set(key, envRecord[key]);
    envRecord[key] = value;
  }

  try {
    await fn();
  } finally {
    for (const [key, value] of previousProcessEnv.entries()) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    for (const [key, value] of previousAppEnv.entries()) {
      envRecord[key] = value;
    }
  }
}

export const phaseNineReadinessEnforcementTests = [
  {
    name: 'phase9 scaled live evidence fails without recent proof',
    fn: testPhaseNineTierEvidenceAssessmentBlocksScaledLiveWithoutProof,
  },
  {
    name: 'phase9 paper tier does not require live proof',
    fn: testPhaseNinePaperTierDoesNotRequireLiveProof,
  },
  {
    name: 'phase9 startup gate adds live tier hard block',
    fn: testPhaseNineStartupGateAddsLiveTierBlockingCheck,
  },
  {
    name: 'phase9 startup gate uses sentinel-specific runbook',
    fn: testPhaseNineStartupGateUsesSentinelRunbook,
  },
  {
    name: 'phase9 start-stop manager uses operating mode aware startup gate',
    fn: testPhaseNineStartStopManagerUsesOperatingModeAwareGate,
  },
  {
    name: 'phase9 production readiness persists latest artifact',
    fn: testPhaseNineProductionReadinessPersistsArtifact,
  },
];
