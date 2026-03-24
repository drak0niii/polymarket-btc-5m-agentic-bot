import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createDefaultLearningState,
  createDefaultStrategyDeploymentRegistryState,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { VenueHealthLearningStore } from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';
import { DecisionReplayContext } from '../runtime/decision-replay-context';
import { LearningStateStore } from '../runtime/learning-state-store';
import { StrategyDeploymentRegistry } from '../runtime/strategy-deployment-registry';
import {
  VersionLineageRegistry,
  buildFeatureSetVersionLineage,
  buildRiskPolicyVersionLineage,
  buildStrategyVersionLineage,
} from '../runtime/version-lineage-registry';

async function testVersionLineageRegistryAndReplayContextReconstructDecision(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave5-version-lineage-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const strategyDeploymentRegistry = new StrategyDeploymentRegistry(rootDir);
  const versionLineageRegistry = new VersionLineageRegistry(rootDir);
  const venueHealthLearningStore = new VenueHealthLearningStore(rootDir);

  const learningState = createDefaultLearningState(new Date('2026-03-26T00:00:00.000Z'));
  learningState.strategyVariants['variant:strategy-live-1'] = {
    strategyVariantId: 'variant:strategy-live-1',
    health: 'healthy',
    lastLearningAt: '2026-03-26T00:00:00.000Z',
    regimeSnapshots: {},
    calibrationContexts: [],
    executionLearning: learningState.executionLearning,
    lastPromotionDecision: { decision: 'not_evaluated', reasons: [], evidence: {}, decidedAt: null },
    lastQuarantineDecision: { status: 'none', severity: 'none', reasons: [], scope: {}, decidedAt: null },
    lastCapitalAllocationDecision: { status: 'unchanged', targetMultiplier: 1, reasons: [], decidedAt: null },
  };
  await learningStateStore.save(learningState);

  const registryState = createDefaultStrategyDeploymentRegistryState(
    new Date('2026-03-26T00:00:00.000Z'),
  );
  registryState.incumbentVariantId = 'variant:strategy-live-1';
  await strategyDeploymentRegistry.save(registryState);

  await venueHealthLearningStore.recordRequest({ latencyMs: 1_000 });
  await venueHealthLearningStore.setOperationalAssessment({
    activeMode: 'size-reduced',
    uncertaintyLabel: 'degraded',
  });

  await versionLineageRegistry.recordDecision({
    decisionId: 'decision-1',
    decisionType: 'signal_execution',
    recordedAt: '2026-03-26T00:05:00.000Z',
    summary: 'approved',
    signalId: 'signal-1',
    signalDecisionId: 'signal-decision-1',
    marketId: 'market-1',
    strategyVariantId: 'variant:strategy-live-1',
    lineage: {
      strategyVersion: buildStrategyVersionLineage({
        strategyVersionId: 'strategy-live-1',
        strategyVariantId: 'variant:strategy-live-1',
      }),
      featureSetVersion: buildFeatureSetVersionLineage({
        featureSetId: 'btc-five-minute-live-signal',
        parentStrategyVersionId: 'strategy-live-1',
        parameters: {
          regime: 'trend_burst',
        },
      }),
      calibrationVersion: null,
      executionPolicyVersion: null,
      riskPolicyVersion: buildRiskPolicyVersionLineage({
        policyId: 'trade-evaluation',
        parameters: {
          maxOpenPositions: 1,
        },
      }),
      allocationPolicyVersion: null,
    },
    replay: {
      marketState: {
        marketId: 'market-1',
        orderbookSpread: 0.02,
      },
      runtimeState: {
        state: 'running',
      },
      learningState: {
        lastCycleSummary: null,
      },
      lineageState: {
        incumbentVariantId: 'variant:strategy-live-1',
      },
      activeParameterBundle: {
        positionSize: 12,
      },
      venueMode: 'size-reduced',
      venueUncertainty: 'degraded',
    },
    tags: ['wave5', 'lineage'],
  });

  const prisma = {
    signal: {
      findUnique: async () => ({ id: 'signal-1', marketId: 'market-1' }),
    },
    signalDecision: {
      findUnique: async () => ({ id: 'signal-decision-1', verdict: 'approved' }),
      findFirst: async () => ({ id: 'signal-decision-1', verdict: 'approved' }),
    },
    order: {
      findUnique: async () => null,
    },
    fill: {
      findMany: async () => [],
    },
    auditEvent: {
      findMany: async () => [{ eventType: 'signal.execution_decision' }],
    },
    market: {
      findUnique: async () => ({ id: 'market-1', slug: 'btc-5m' }),
    },
    marketSnapshot: {
      findFirst: async () => ({ marketId: 'market-1', observedAt: new Date() }),
    },
    orderbook: {
      findFirst: async () => ({ marketId: 'market-1', observedAt: new Date() }),
    },
    botRuntimeStatus: {
      findUnique: async () => ({ state: 'running', lastHeartbeatAt: new Date() }),
    },
  };

  const replayContext = new DecisionReplayContext(
    prisma as never,
    versionLineageRegistry,
    learningStateStore,
    strategyDeploymentRegistry,
    venueHealthLearningStore,
  );
  const replay = await replayContext.reconstructByDecisionId('decision-1');

  assert.ok(replay);
  assert.strictEqual(replay?.reconstructable, true);
  assert.strictEqual(replay?.venueMode, 'size-reduced');
  assert.strictEqual(replay?.lineageState?.incumbentVariantId, 'variant:strategy-live-1');
  assert.strictEqual(replay?.activeParameterBundle?.positionSize, 12);
}

export const waveFiveVersionLineageIntegrationTests = [
  {
    name: 'wave5 version lineage registry reconstructs replay context',
    fn: testVersionLineageRegistryAndReplayContextReconstructDecision,
  },
];
