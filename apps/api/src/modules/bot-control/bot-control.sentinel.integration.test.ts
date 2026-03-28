import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BotControlController } from './bot-control.controller';
import { BotControlRepository } from './bot-control.repository';
import { BotControlService } from './bot-control.service';
import { UiService } from '../ui/ui.service';

async function testModeSwitchPersistsThroughBotControlEndpoints(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-sentinel-mode-'));
  const runtimeStatePath = path.join(tempDir, 'artifacts/runtime/bot-state.latest.json');
  const sentinelReadinessPath = path.join(
    tempDir,
    'artifacts/learning/sentinel/readiness.latest.json',
  );
  fs.mkdirSync(path.dirname(sentinelReadinessPath), { recursive: true });
  fs.writeFileSync(
    sentinelReadinessPath,
    JSON.stringify(
      {
        updatedAt: '2026-03-27T00:00:00.000Z',
        recommendationState: 'not_ready',
        recommendationMessage:
          'Sentinel is still learning. Simulated trades: 0/20. Learned trades: 0/20. Readiness score: 0.00/0.75. Do not enable live trading yet.',
        simulatedTradesCompleted: 0,
        simulatedTradesLearned: 0,
        targetSimulatedTrades: 20,
        targetLearnedTrades: 20,
        readinessScore: 0,
        readinessThreshold: 0.75,
        expectedVsRealizedEdgeGapBps: 0,
        fillQualityPassRate: 0,
        noTradeDisciplinePassRate: 0,
        learningCoverage: 0,
        unresolvedAnomalyCount: 0,
        recommendedLiveEnable: false,
      },
      null,
      2,
    ),
  );

  const repository = new BotControlRepository(buildPrismaFixture() as never, {
    runtimeStatePath,
    sentinelReadinessPath,
  });
  const service = new BotControlService(repository, {
    record: async () => undefined,
  } as never);
  const controller = new BotControlController(service);

  await controller.setMode({
    operatingMode: 'sentinel_simulation',
    requestedBy: 'test',
  } as never);
  const mode = await controller.getMode();

  assert.strictEqual(mode.operatingMode, 'sentinel_simulation');
  assert.strictEqual(mode.sentinelEnabled, true);
  assert.strictEqual(fs.existsSync(runtimeStatePath), true);
}

async function testDashboardResponseContainsSentinelFields(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-sentinel-dashboard-'));
  const runtimeStatePath = path.join(tempDir, 'artifacts/runtime/bot-state.latest.json');
  const sentinelReadinessPath = path.join(
    tempDir,
    'artifacts/learning/sentinel/readiness.latest.json',
  );
  fs.mkdirSync(path.dirname(sentinelReadinessPath), { recursive: true });
  fs.writeFileSync(
    sentinelReadinessPath,
    JSON.stringify(
      {
        updatedAt: '2026-03-27T00:00:00.000Z',
        recommendationState: 'ready_to_consider_live',
        recommendationMessage:
          'Sentinel thresholds are satisfied. Simulated trades: 20/20. Learned trades: 20/20. Readiness score: 0.90/0.75. It is safe to consider enabling live trading.',
        simulatedTradesCompleted: 20,
        simulatedTradesLearned: 20,
        targetSimulatedTrades: 20,
        targetLearnedTrades: 20,
        readinessScore: 0.9,
        readinessThreshold: 0.75,
        expectedVsRealizedEdgeGapBps: 4,
        fillQualityPassRate: 0.9,
        noTradeDisciplinePassRate: 0.95,
        learningCoverage: 1,
        unresolvedAnomalyCount: 0,
        recommendedLiveEnable: true,
      },
      null,
      2,
    ),
  );

  const repository = new BotControlRepository(buildPrismaFixture() as never, {
    runtimeStatePath,
    sentinelReadinessPath,
  });
  await repository.setOperatingMode('sentinel_simulation', 'test');
  const botControlService = new BotControlService(repository, {
    record: async () => undefined,
    listAuditEvents: async () => [],
  } as never);
  const uiService = new UiService(
    { listMarkets: async () => [] } as never,
    { listSignals: async () => [] } as never,
    { listOrders: async () => [] } as never,
    { getLatestPortfolio: async () => null } as never,
    botControlService,
    {
      getExecutionDiagnostics: async () => [],
      getEvDriftDiagnostics: async () => [],
      getRegimeDiagnostics: async () => [],
      getStressTestRuns: async () => [],
      getReconciliationDiagnostics: async () => [],
    } as never,
    { listAuditEvents: async () => [] } as never,
  );

  const dashboard = await uiService.getDashboard();

  assert.strictEqual(dashboard.operatingMode, 'sentinel_simulation');
  assert.strictEqual(dashboard.simulatedTradesCompleted, 20);
  assert.strictEqual(dashboard.simulatedTradesLearned, 20);
  assert.strictEqual(dashboard.readinessScore, 0.9);
  assert.strictEqual(dashboard.recommendedLiveEnable, true);
}

function buildPrismaFixture() {
  let runtimeStatus = {
    id: 'live',
    state: 'stopped',
    reason: 'initialized',
    updatedAt: new Date('2026-03-27T00:00:00.000Z'),
  };
  let liveConfig = {
    id: 'live',
    maxOpenPositions: 1,
    maxDailyLossPct: 5,
    maxPerTradeRiskPct: 1,
    maxKellyFraction: 0.05,
    maxConsecutiveLosses: 2,
    noTradeWindowSeconds: 30,
    evaluationIntervalMs: 1000,
    orderReconcileIntervalMs: 2000,
    portfolioRefreshIntervalMs: 5000,
    updatedAt: new Date('2026-03-27T00:00:00.000Z'),
  };

  return {
    botRuntimeStatus: {
      upsert: async ({ create }: { create: typeof runtimeStatus }) => runtimeStatus ?? create,
    },
    liveConfig: {
      upsert: async ({ create }: { create: typeof liveConfig }) => liveConfig ?? create,
      update: async ({ data }: { data: Partial<typeof liveConfig> }) => {
        liveConfig = { ...liveConfig, ...data };
        return liveConfig;
      },
    },
    botRuntimeCommand: {
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => data,
    },
  };
}

export const botControlSentinelIntegrationTests = [
  {
    name: 'api mode switch persists through bot-control endpoints',
    fn: testModeSwitchPersistsThroughBotControlEndpoints,
  },
  {
    name: 'api dashboard response exposes sentinel readiness fields',
    fn: testDashboardResponseContainsSentinelFields,
  },
];
