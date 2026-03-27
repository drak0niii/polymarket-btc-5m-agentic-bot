import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createDefaultExecutionLearningState,
  createDefaultLearningState,
  createDefaultStrategyDeploymentRegistryState,
  createDefaultStrategyVariantState,
  createEmptyDecisionVersionLineage,
  buildStrategyVariantId,
  type ExecutionPolicyVersion,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { buildExecutionLearningContextKey } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { BuildSignalsJob } from '../jobs/buildSignals.job';
import { DailyReviewJob } from '../jobs/dailyReview.job';
import { EvaluateTradeOpportunitiesJob } from '../jobs/evaluateTradeOpportunities.job';
import { ExecuteOrdersJob } from '../jobs/executeOrders.job';
import { LearningEventLog } from '../runtime/learning-event-log';
import { LearningStateStore } from '../runtime/learning-state-store';
import { StrategyDeploymentRegistry } from '../runtime/strategy-deployment-registry';
import { VersionLineageRegistry } from '../runtime/version-lineage-registry';
import { TradeQualityHistoryStore } from '@polymarket-btc-5m-agentic-bot/risk-engine';

async function testBuildSignalsPreservesArchetypeToxicityAndAlphaEvidence(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase7-build-signals-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const versionLineageRegistry = new VersionLineageRegistry(
    path.join(rootDir, 'version-lineage'),
  );
  const deploymentRegistry = new StrategyDeploymentRegistry(
    path.join(rootDir, 'deployment-registry'),
  );
  const createdSignals: Array<Record<string, unknown>> = [];
  const createdSignalDecisions: Array<Record<string, unknown>> = [];
  const auditEvents: Array<Record<string, unknown>> = [];

  const prisma = {
    strategyVersion: {
      findFirst: async () => ({ id: 'strategy-live-1' }),
    },
    market: {
      findMany: async () => [
        {
          id: 'm1',
          slug: 'btc-toxic',
          title: 'Will BTC be higher in 5 minutes?',
          status: 'active',
          tokenIdYes: 'yes1',
          tokenIdNo: 'no1',
          expiresAt: new Date(Date.now() + 55_000),
          updatedAt: new Date(),
        },
      ],
    },
    orderbook: {
      findFirst: async () => ({
        ...buildOrderbook({
          spread: 0.042,
          bidLevels: [
            { price: 0.47, size: 4 },
            { price: 0.45, size: 2 },
          ],
          askLevels: [
            { price: 0.512, size: 10 },
            { price: 0.53, size: 3 },
          ],
        }),
        tickSize: 0.01,
        minOrderSize: 1,
        negRisk: false,
        observedAt: new Date(),
      }),
    },
    marketSnapshot: {
      findFirst: async () => ({
        observedAt: new Date(),
        expiresAt: new Date(Date.now() + 55_000),
        volume: 700,
      }),
    },
    signal: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdSignals.push(data);
        return data;
      },
    },
    signalDecision: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdSignalDecisions.push(data);
        return data;
      },
    },
    auditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        auditEvents.push(data);
        return data;
      },
    },
  };

  const job = new BuildSignalsJob(
    prisma as never,
    deploymentRegistry,
    learningStateStore,
    versionLineageRegistry,
  );
  const result = await job.run(buildBtcReference());

  assert.strictEqual(result.created, 0);
  assert.strictEqual(createdSignals.length, 1);
  assert.strictEqual(createdSignals[0]?.status, 'rejected');
  assert.strictEqual(createdSignalDecisions.length, 1);
  assert.strictEqual(
    String(createdSignalDecisions[0]?.reasonMessage ?? '').includes('archetype='),
    true,
  );
  assert.strictEqual(
    String(createdSignalDecisions[0]?.reasonMessage ?? '').includes('toxicity='),
    true,
  );

  const signalId = String(createdSignals[0]?.id ?? '');
  const lineage = await versionLineageRegistry.getLatestForSignal(signalId);
  assert.ok(lineage);
  assert.strictEqual(
    lineage?.tags.some((tag) => tag.startsWith('archetype:')),
    true,
  );
  assert.strictEqual(
    lineage?.tags.some((tag) => tag.startsWith('toxicity:')),
    true,
  );
  const bundle =
    lineage?.replay.activeParameterBundle &&
    typeof lineage.replay.activeParameterBundle === 'object'
      ? (lineage.replay.activeParameterBundle as Record<string, unknown>)
      : null;
  assert.ok(bundle);
  assert.strictEqual(bundle?.alphaAttribution != null, true);
  assert.strictEqual(bundle?.phaseTwoContext != null, true);
  assert.strictEqual(bundle?.toxicity != null, true);

  const admissionEvent = auditEvents.find(
    (event) => event.eventType === 'signal.admission_decision',
  );
  const admissionMetadata =
    admissionEvent?.metadata && typeof admissionEvent.metadata === 'object'
      ? (admissionEvent.metadata as Record<string, unknown>)
      : null;
  assert.ok(admissionMetadata);
  assert.strictEqual(admissionMetadata?.alphaAttribution != null, true);
  assert.strictEqual(admissionMetadata?.phaseTwoContext != null, true);
  assert.strictEqual(admissionMetadata?.toxicity != null, true);
}

async function testEvaluateTradeOpportunitiesCarriesUpstreamBuildEvidence(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase7-evaluate-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const versionLineageRegistry = new VersionLineageRegistry(
    path.join(rootDir, 'version-lineage'),
  );
  const deploymentRegistry = new StrategyDeploymentRegistry(
    path.join(rootDir, 'deployment-registry'),
  );
  const tradeQualityHistoryStore = new TradeQualityHistoryStore(
    path.join(rootDir, 'trade-quality'),
  );
  const strategyVariantId = buildStrategyVariantId('strategy-live-1');
  const learningState = createDefaultLearningState(new Date('2026-03-25T00:00:00.000Z'));
  learningState.strategyVariants[strategyVariantId] = {
    ...createDefaultStrategyVariantState(strategyVariantId),
    health: 'healthy',
    regimeSnapshots: {
      'regime:momentum_continuation': {
        key: 'regime:momentum_continuation',
        regime: 'momentum_continuation',
        liquidityBucket: 'balanced',
        spreadBucket: 'normal',
        timeToExpiryBucket: 'under_15m',
        entryTimingBucket: 'early',
        executionStyle: 'hybrid',
        side: 'buy',
        strategyVariantId,
        sampleCount: 24,
        winRate: 0.61,
        expectedEvSum: 0.36,
        realizedEvSum: 0.31,
        avgExpectedEv: 0.015,
        avgRealizedEv: 0.0129,
        realizedVsExpected: 0.86,
        avgFillRate: 0.84,
        avgSlippage: 0.002,
        health: 'healthy',
        lastObservedAt: '2026-03-25T00:00:00.000Z',
      },
    },
  };
  learningState.calibration[`strategy:${strategyVariantId}|regime:momentum_continuation`] = {
    contextKey: `strategy:${strategyVariantId}|regime:momentum_continuation`,
    strategyVariantId,
    regime: 'momentum_continuation',
    sampleCount: 28,
    brierScore: 0.15,
    logLoss: 0.41,
    shrinkageFactor: 1,
    overconfidenceScore: 0.04,
    health: 'healthy',
    version: 1,
    driftSignals: [],
    lastUpdatedAt: '2026-03-25T00:00:00.000Z',
  };
  await learningStateStore.save(learningState);

  await versionLineageRegistry.recordDecision({
    decisionId: 'build-signal-1',
    decisionType: 'signal_build',
    signalId: 'signal-1',
    summary: 'Upstream signal build evidence',
    strategyVariantId,
    recordedAt: '2026-03-25T00:00:00.000Z',
    lineage: createEmptyDecisionVersionLineage(),
    replay: {
      marketState: null,
      runtimeState: null,
      learningState: null,
      lineageState: null,
      activeParameterBundle: {
        alphaAttribution: {
          expectedNetEdge: 0.048,
          paperEdge: 0.055,
        },
        phaseTwoContext: {
          marketArchetype: 'balanced_rotation',
          marketStateTransition: 'range_balance',
        },
        toxicity: {
          toxicityState: 'normal',
        },
      },
      venueMode: null,
      venueUncertainty: null,
    },
    tags: ['signal-build', 'archetype:balanced_rotation', 'toxicity:normal'],
  });

  const createdDecisions: Array<Record<string, unknown>> = [];
  const auditEvents: Array<Record<string, unknown>> = [];
  const signal = buildExecutionSignal({
    regime: 'momentum_continuation',
    expectedEv: 0.055,
    edge: 0.036,
    observedAt: new Date(Date.now() - 4_000),
  });
  const prisma = {
    signal: {
      findMany: async () => [signal],
      update: async () => null,
    },
    portfolioSnapshot: {
      findFirst: async () => ({
        bankroll: 1_000,
        availableCapital: 500,
        realizedPnlDay: 0,
        consecutiveLosses: 0,
        capturedAt: new Date(),
      }),
    },
    position: {
      findMany: async () => [],
    },
    order: {
      findMany: async () => [],
    },
    signalDecision: {
      findFirst: async () => null,
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdDecisions.push(data);
        return data;
      },
    },
    market: {
      findMany: async () => [buildMarket()],
    },
    orderbook: {
      findFirst: async () => ({
        ...buildOrderbook(),
        observedAt: new Date(),
      }),
    },
    marketSnapshot: {
      findFirst: async () => buildSnapshot(300),
    },
    reconciliationCheckpoint: {
      findFirst: async ({ where }: { where: { source: string } }) => ({
        source: where.source,
        status: 'passed',
        recordedAt: new Date().toISOString(),
        details:
          where.source === 'research_governance_validation'
            ? {
                robustness: { passed: true },
                promotion: { score: 0.82 },
              }
            : {},
      }),
    },
    botRuntimeStatus: {
      findUnique: async () => ({
        status: 'healthy',
        lastHeartbeatAt: new Date().toISOString(),
        reasonCodes: [],
        warnings: [],
        updatedAt: new Date(),
      }),
    },
    stressTestRun: {
      findFirst: async () => ({
        family: 'chaos_harness',
        verdict: 'passed',
        status: 'passed',
        startedAt: new Date(),
      }),
    },
    executionDiagnostic: {
      findMany: async () => [],
    },
    auditEvent: {
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        auditEvents.push(data);
        return data;
      },
    },
  };
  const runtimeControl = {
    getLatestSafetyState: async () => ({
      state: 'normal',
      enteredAt: new Date(0).toISOString(),
      reasonCodes: [],
      sizeMultiplier: 1,
      evaluationCadenceMultiplier: 1,
      allowAggressiveEntries: true,
      allowNewEntries: true,
      haltRequested: false,
      maxNewSignalsPerTick: 4,
      evidence: {},
    }),
    recordSafetyStateTransition: async () => null,
  };

  const job = new EvaluateTradeOpportunitiesJob(
    prisma as never,
    runtimeControl as never,
    deploymentRegistry,
    learningStateStore,
    versionLineageRegistry,
    undefined,
    tradeQualityHistoryStore,
  );
  const result = await job.run(buildRuntimeConfig());

  assert.strictEqual(result.approved >= 0, true);
  const decisionEvent = auditEvents.find(
    (event) => event.eventType === 'signal.execution_decision',
  );
  const metadata =
    decisionEvent?.metadata && typeof decisionEvent.metadata === 'object'
      ? (decisionEvent.metadata as Record<string, unknown>)
      : null;
  assert.ok(metadata);
  const upstreamSignalBuildEvidence =
    metadata?.upstreamSignalBuildEvidence &&
    typeof metadata.upstreamSignalBuildEvidence === 'object'
      ? (metadata.upstreamSignalBuildEvidence as Record<string, unknown>)
      : null;
  const retainedEdgeExpectation =
    metadata?.retainedEdgeExpectation &&
    typeof metadata.retainedEdgeExpectation === 'object'
      ? (metadata.retainedEdgeExpectation as Record<string, unknown>)
      : null;
  assert.ok(upstreamSignalBuildEvidence);
  assert.ok(retainedEdgeExpectation);
  assert.strictEqual(upstreamSignalBuildEvidence?.marketArchetype, 'balanced_rotation');
  assert.strictEqual(upstreamSignalBuildEvidence?.toxicityState, 'normal');
  assert.strictEqual(retainedEdgeExpectation?.marketArchetype, 'balanced_rotation');

  const approvedDecision = createdDecisions.find((decision) => decision.verdict === 'approved');
  if (approvedDecision && typeof approvedDecision.id === 'string') {
    const lineage = await versionLineageRegistry.getLatestForSignalDecision(
      approvedDecision.id,
    );
    const bundle =
      lineage?.replay.activeParameterBundle &&
      typeof lineage.replay.activeParameterBundle === 'object'
        ? (lineage.replay.activeParameterBundle as Record<string, unknown>)
        : null;
    assert.ok(bundle);
    assert.strictEqual(bundle?.upstreamSignalBuildEvidence != null, true);
    assert.strictEqual(bundle?.retainedEdgeExpectation != null, true);
  }
}

async function testExecuteOrdersProducesRealizedRetentionDiagnostics(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase7-execute-orders-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const versionLineageRegistry = new VersionLineageRegistry(
    path.join(rootDir, 'version-lineage'),
  );
  const learningState = createDefaultLearningState(
    new Date('2026-03-25T00:00:00.000Z'),
  );
  const strategyVariantId = buildStrategyVariantId('strategy-live-1');
  const contextKey = buildExecutionLearningContextKey(
    strategyVariantId,
    'momentum_continuation',
  );
  const activePolicy: ExecutionPolicyVersion = {
    versionId: 'execution-policy:phase7:v1',
    contextKey,
    strategyVariantId,
    regime: 'momentum_continuation',
    mode: 'taker_preferred',
    recommendedRoute: 'taker',
    recommendedExecutionStyle: 'cross',
    sampleCount: 16,
    makerFillRateAssumption: 0.42,
    takerFillRateAssumption: 0.9,
    expectedFillDelayMs: 18_000,
    expectedSlippage: 0.0038,
    adverseSelectionScore: 0.46,
    cancelSuccessRate: 0.7,
    partialFillRate: 0.24,
    health: 'degraded',
    rationale: ['phase7_test_policy'],
    sourceCycleId: 'cycle-1',
    supersedesVersionId: null,
    createdAt: '2026-03-25T00:00:00.000Z',
  };
  learningState.strategyVariants[strategyVariantId] = {
    ...createDefaultStrategyVariantState(strategyVariantId),
    health: 'degraded',
    regimeSnapshots: {
      'regime:momentum_continuation': {
        key: 'regime:momentum_continuation',
        regime: 'momentum_continuation',
        liquidityBucket: 'balanced',
        spreadBucket: 'normal',
        timeToExpiryBucket: 'under_15m',
        entryTimingBucket: 'early',
        executionStyle: 'hybrid',
        side: 'buy',
        strategyVariantId,
        sampleCount: 12,
        winRate: 0.35,
        expectedEvSum: 0.18,
        realizedEvSum: 0.11,
        avgExpectedEv: 0.015,
        avgRealizedEv: 0.009,
        realizedVsExpected: 0.72,
        avgFillRate: 0.64,
        avgSlippage: 0.0042,
        health: 'degraded',
        lastObservedAt: '2026-03-25T00:00:00.000Z',
      },
    },
    executionLearning: {
      ...createDefaultExecutionLearningState(),
      contexts: {
        [contextKey]: {
          contextKey,
          strategyVariantId,
          regime: 'momentum_continuation',
          sampleCount: 16,
          makerSampleCount: 8,
          takerSampleCount: 8,
          makerFillRate: 0.42,
          takerFillRate: 0.9,
          averageFillDelayMs: 18_000,
          averageSlippage: 0.0038,
          adverseSelectionScore: 0.46,
          cancelSuccessRate: 0.7,
          partialFillRate: 0.24,
          makerPunished: false,
          health: 'degraded',
          notes: ['phase7_test_context'],
          activePolicyVersionId: activePolicy.versionId,
          lastUpdatedAt: '2026-03-25T00:00:00.000Z',
        },
      },
      policyVersions: {
        [activePolicy.versionId]: activePolicy,
      },
      activePolicyVersionIds: {
        [contextKey]: activePolicy.versionId,
      },
    },
  };
  learningState.calibration[`strategy:${strategyVariantId}|regime:momentum_continuation`] = {
    contextKey: `strategy:${strategyVariantId}|regime:momentum_continuation`,
    strategyVariantId,
    regime: 'momentum_continuation',
    sampleCount: 20,
    brierScore: 0.23,
    logLoss: 0.61,
    shrinkageFactor: 0.78,
    overconfidenceScore: 0.17,
    health: 'degraded',
    version: 1,
    driftSignals: ['phase7_degraded_calibration'],
    lastUpdatedAt: '2026-03-25T00:00:00.000Z',
  };
  await learningStateStore.save(learningState);

  await versionLineageRegistry.recordDecision({
    decisionId: 'evaluate-decision-1',
    decisionType: 'signal_execution',
    signalId: 'signal-1',
    signalDecisionId: 'signal-decision-1',
    summary: 'Upstream evaluation evidence',
    strategyVariantId,
    recordedAt: '2026-03-25T00:00:00.000Z',
    lineage: createEmptyDecisionVersionLineage(),
    replay: {
      marketState: null,
      runtimeState: null,
      learningState: null,
      lineageState: null,
      activeParameterBundle: {
        alphaAttribution: {
          expectedNetEdge: 0.018,
          paperEdge: 0.026,
        },
        upstreamSignalBuildEvidence: {
          marketArchetype: 'balanced_rotation',
          toxicityState: 'normal',
        },
        retainedEdgeExpectation: {
          marketArchetype: 'balanced_rotation',
          toxicityState: 'normal',
        },
      },
      venueMode: null,
      venueUncertainty: null,
    },
    tags: ['signal-execution', 'archetype:balanced_rotation', 'toxicity:normal'],
  });

  const createdSignalDecisions: Array<Record<string, unknown>> = [];
  let auditMetadata: Record<string, unknown> | null = null;
  const storedAuditEvents: Array<Record<string, unknown>> = [
    {
      eventType: 'learning.alpha_attribution_review',
      createdAt: new Date('2026-03-25T00:05:00.000Z'),
      metadata: {
        averageExpectedNetEdge: 0.02,
        averageRealizedNetEdge: 0.012,
        averageRetentionRatio: 0.58,
      },
    },
  ];
  const prisma = {
    signal: {
      findMany: async () => [
        buildExecutionSignal({
          regime: 'momentum_continuation',
          observedAt: new Date(Date.now() - 5_000),
          expectedEv: 0.06,
        }),
      ],
      update: async () => null,
    },
    signalDecision: {
      findFirst: async () => ({
        id: 'signal-decision-1',
        signalId: 'signal-1',
        positionSize: 12,
        verdict: 'approved',
      }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdSignalDecisions.push(data);
        return data;
      },
    },
    market: {
      findUnique: async () => buildMarket(),
    },
    marketSnapshot: {
      findFirst: async () => buildSnapshot(300),
    },
    orderbook: {
      findFirst: async () =>
        buildOrderbook({
          spread: 0.016,
          bidLevels: [
            { price: 0.52, size: 12 },
            { price: 0.51, size: 8 },
          ],
          askLevels: [
            { price: 0.536, size: 13 },
            { price: 0.548, size: 8 },
          ],
          observedAt: new Date(),
        }),
    },
    order: {
      findFirst: async () => null,
      create: async () => null,
      update: async () => null,
    },
    orderIntent: {
      findFirst: async () => null,
      create: async () => null,
    },
    fill: {
      findMany: async () => [],
    },
    executionDiagnostic: {
      create: async () => null,
      findMany: async () => [],
    },
    portfolioSnapshot: {
      findFirst: async () => ({
        bankroll: 1_000,
        availableCapital: 600,
        realizedPnlDay: 0,
        consecutiveLosses: 0,
        capturedAt: new Date(),
      }),
    },
    position: {
      findMany: async () => [],
    },
    auditEvent: {
      findMany: async () => storedAuditEvents,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (data.eventType === 'order.submitted') {
          auditMetadata =
            data.metadata && typeof data.metadata === 'object'
              ? (data.metadata as Record<string, unknown>)
              : null;
        }
        storedAuditEvents.push(data);
        return data;
      },
    },
    reconciliationCheckpoint: {
      findFirst: async ({ where }: { where: { source: string } }) => ({
        source: where.source,
        status: 'passed',
        recordedAt: new Date().toISOString(),
        details: {},
      }),
      create: async () => null,
    },
    botRuntimeStatus: {
      findUnique: async () => ({
        status: 'healthy',
        lastHeartbeatAt: new Date().toISOString(),
        reasonCodes: [],
        warnings: [],
        updatedAt: new Date(),
      }),
    },
    liveConfig: {
      findUnique: async () => ({ id: 'live', noTradeWindowSeconds: 30 }),
    },
  };
  const runtimeControl = {
    assessOperationalFreshness: async () => ({
      healthy: true,
      reasonCode: null,
    }),
    getLatestSafetyState: async () => ({
      state: 'normal',
      enteredAt: new Date(0).toISOString(),
      reasonCodes: [],
      sizeMultiplier: 1,
      evaluationCadenceMultiplier: 1,
      allowAggressiveEntries: true,
      allowNewEntries: true,
      haltRequested: false,
      maxNewSignalsPerTick: 4,
      evidence: {},
    }),
    recordSafetyStateTransition: async () => null,
    updateRuntimeStatus: async () => null,
  };

  const job = new ExecuteOrdersJob(
    prisma as never,
    runtimeControl as never,
    learningStateStore,
    versionLineageRegistry,
  );
  (job as any).signerHealth = {
    check: () => ({
      checks: {
        privateKey: true,
        apiKey: true,
        apiSecret: true,
        apiPassphrase: true,
      },
    }),
  };
  (job as any).liveTradeGuard = {
    evaluate: () => ({
      passed: true,
      reasonCode: 'passed',
      reasonMessage: null,
    }),
  };
  (job as any).externalPortfolioService = {
    capture: async () => createExternalPortfolioSnapshot(),
  };
  (job as any).accountStateService = {
    capture: async () => ({
      deployableRiskNow: 10_000,
    }),
  };
  (job as any).tradingClient = {
    postOrder: async () => ({
      success: true,
      orderId: 'venue-order-1',
      status: 'acknowledged',
    }),
  };

  const result = await job.run({ canSubmit: () => true });

  assert.strictEqual(result.submitted === 1 || result.rejected >= 1, true);
  if (auditMetadata) {
    const submittedMetadata = auditMetadata as Record<string, unknown>;
    assert.strictEqual(submittedMetadata.alphaAttribution != null, true);
    assert.strictEqual(submittedMetadata.retainedEdgeExpectation != null, true);
    assert.strictEqual(submittedMetadata.upstreamEvaluationEvidence != null, true);
    assert.strictEqual(submittedMetadata.executionPlannerAssumptions != null, true);
    const retained =
      submittedMetadata.retainedEdgeExpectation &&
      typeof submittedMetadata.retainedEdgeExpectation === 'object'
        ? (submittedMetadata.retainedEdgeExpectation as Record<string, unknown>)
        : null;
    const plannerAssumptions =
      submittedMetadata.executionPlannerAssumptions &&
      typeof submittedMetadata.executionPlannerAssumptions === 'object'
        ? (submittedMetadata.executionPlannerAssumptions as Record<string, unknown>)
        : null;
    assert.ok(retained);
    assert.ok(plannerAssumptions);
    assert.strictEqual(retained?.marketArchetype, 'balanced_rotation');
    assert.strictEqual(
      typeof plannerAssumptions?.expectedFillProbability === 'number',
      true,
    );
    assert.strictEqual(
      typeof plannerAssumptions?.expectedFillFraction === 'number',
      true,
    );
    assert.strictEqual(
      typeof plannerAssumptions?.expectedQueueDelayMs === 'number',
      true,
    );
    assert.strictEqual(
      typeof plannerAssumptions?.expectedAdverseSelectionPenaltyBps === 'number',
      true,
    );
    assert.strictEqual(
      Array.isArray(plannerAssumptions?.recommendedOrderStyleRationale),
      true,
    );
    assert.strictEqual(plannerAssumptions?.executionBucketContext != null, true);
  } else {
    assert.strictEqual(
      createdSignalDecisions.some(
        (decision) =>
          String(decision.verdict ?? '') === 'rejected' &&
          String(decision.reasonCode ?? '').length > 0,
      ),
      true,
    );
  }
}

async function testDailyReviewPersistsStructuredReviewOutputs(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase7-daily-review-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const learningEventLog = new LearningEventLog(rootDir);
  const versionLineageRegistry = new VersionLineageRegistry(
    path.join(rootDir, 'version-lineage'),
  );
  const strategyDeploymentRegistry = new StrategyDeploymentRegistry(
    path.join(rootDir, 'deployment-registry'),
  );
  const learningState = createDefaultLearningState(
    new Date('2026-03-25T00:00:00.000Z'),
  );
  const strategyVariantId = buildStrategyVariantId('strategy-live-1');
  learningState.strategyVariants[strategyVariantId] = {
    ...createDefaultStrategyVariantState(strategyVariantId),
  };
  await learningStateStore.save(learningState);
  const registry = createDefaultStrategyDeploymentRegistryState(
    new Date('2026-03-25T00:00:00.000Z'),
  );
  registry.incumbentVariantId = strategyVariantId;
  registry.variants[strategyVariantId] = {
    ...registry.variants[strategyVariantId],
    strategyVersionId: 'strategy-live-1',
  };
  await strategyDeploymentRegistry.save(registry);

  const storedAuditEvents: Array<Record<string, unknown>> = [];
  const prisma = {
    strategyVersion: {
      findMany: async () => [],
    },
    executionDiagnostic: {
      findMany: async () => [],
    },
    order: {
      findMany: async () => [],
    },
    auditEvent: {
      findMany: async () => storedAuditEvents,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        storedAuditEvents.push(data);
        return data;
      },
    },
  };

  const job = new DailyReviewJob(
    prisma as never,
    learningStateStore,
    learningEventLog,
    strategyDeploymentRegistry,
    versionLineageRegistry,
  );
  const summary = await job.run({
    force: true,
    now: new Date('2026-03-25T00:10:00.000Z'),
  });
  const savedState = await learningStateStore.load();

  assert.ok(summary.reviewOutputs);
  assert.ok(savedState.lastCycleSummary?.reviewOutputs);
  const reviewOutputs =
    savedState.lastCycleSummary?.reviewOutputs &&
    typeof savedState.lastCycleSummary.reviewOutputs === 'object'
      ? (savedState.lastCycleSummary.reviewOutputs as Record<string, unknown>)
      : null;
  assert.ok(reviewOutputs);
  assert.strictEqual(reviewOutputs?.alphaAttribution != null, true);
  assert.strictEqual(reviewOutputs?.baselineBenchmarks != null, true);
  assert.strictEqual(reviewOutputs?.retentionReport != null, true);
  assert.strictEqual(reviewOutputs?.regimePerformanceReport != null, true);
  assert.strictEqual(reviewOutputs?.liveProofScorecard != null, true);
  assert.strictEqual(reviewOutputs?.liveSizingFeedback != null, true);
}

function buildRuntimeConfig() {
  return {
    maxOpenPositions: 2,
    maxDailyLossPct: 5,
    maxPerTradeRiskPct: 1,
    maxKellyFraction: 0.05,
    maxConsecutiveLosses: 2,
    noTradeWindowSeconds: 30,
    evaluationIntervalMs: 1_000,
    orderReconcileIntervalMs: 2_000,
    portfolioRefreshIntervalMs: 5_000,
  };
}

function buildExecutionSignal(
  overrides?: Partial<{
    regime: string;
    expectedEv: number;
    edge: number;
    observedAt: Date;
  }>,
) {
  return {
    id: 'signal-1',
    marketId: 'm1',
    strategyVersionId: 'strategy-live-1',
    side: 'BUY',
    tokenId: 'yes1',
    outcome: 'YES',
    intent: 'ENTER',
    inventoryEffect: 'INCREASE',
    priorProbability: 0.58,
    posteriorProbability: 0.69,
    marketImpliedProb: 0.55,
    edge: overrides?.edge ?? 0.03,
    expectedEv: overrides?.expectedEv ?? 0.045,
    regime: overrides?.regime ?? 'momentum_continuation',
    status: 'approved',
    observedAt: overrides?.observedAt ?? new Date(Date.now() - 3_000),
  };
}

function buildMarket() {
  return {
    id: 'm1',
    slug: 'btc-5m',
    title: 'Will BTC be higher in 5 minutes?',
    status: 'active',
    tokenIdYes: 'yes1',
    tokenIdNo: 'no1',
    expiresAt: new Date(Date.now() + 300_000),
  };
}

function buildSnapshot(expirySeconds: number) {
  return {
    observedAt: new Date(),
    expiresAt: new Date(Date.now() + expirySeconds * 1_000),
    volume: 500,
    marketPrice: 0.55,
  };
}

function buildOrderbook(input?: {
  spread?: number;
  bidLevels?: Array<{ price: number; size: number }>;
  askLevels?: Array<{ price: number; size: number }>;
  observedAt?: Date;
}) {
  return {
    bestBid: input?.bidLevels?.[0]?.price ?? 0.54,
    bestAsk: input?.askLevels?.[0]?.price ?? 0.55,
    spread: input?.spread ?? 0.01,
    bidLevels:
      input?.bidLevels ?? [
        { price: 0.54, size: 18 },
        { price: 0.53, size: 14 },
      ],
    askLevels:
      input?.askLevels ?? [
        { price: 0.55, size: 18 },
        { price: 0.56, size: 14 },
      ],
    tickSize: 0.01,
    minOrderSize: 1,
    negRisk: false,
    observedAt: input?.observedAt ?? new Date(),
  };
}

function createExternalPortfolioSnapshot() {
  return {
    cashBalance: 2_000,
    totalPortfolioValue: 10_000,
    buyingPower: 8_000,
    availableBalance: 8_000,
    openExposure: 0,
    positions: [],
    orders: [],
    capturedAt: new Date().toISOString(),
  };
}

function buildBtcReference() {
  return {
    symbol: 'BTCUSD',
    spotPrice: 105_000,
    candles: buildBtcCandleSeries().candles,
    observedAt: new Date().toISOString(),
  };
}

function buildBtcCandleSeries() {
  const candles: Array<{
    timestamp: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }> = [];
  let price = 100;

  for (let index = 0; index < 24; index += 1) {
    const open = price;
    const close = open + 0.8 + index * 0.06;
    candles.push({
      timestamp: new Date(Date.now() - (24 - index) * 5 * 60_000).toISOString(),
      open,
      high: close + 0.12,
      low: open - 0.08,
      close,
      volume: 70 + index * 5,
    });
    price = close;
  }

  return {
    symbol: 'BTCUSD',
    timeframe: '5m',
    candles,
  };
}

export const phaseSevenLivePathWiringTests = [
  {
    name: 'phase7 build signals preserves archetype toxicity and alpha evidence',
    fn: testBuildSignalsPreservesArchetypeToxicityAndAlphaEvidence,
  },
  {
    name: 'phase7 evaluate opportunities carries upstream build evidence',
    fn: testEvaluateTradeOpportunitiesCarriesUpstreamBuildEvidence,
  },
  {
    name: 'phase7 execute orders produces realized retention diagnostics',
    fn: testExecuteOrdersProducesRealizedRetentionDiagnostics,
  },
  {
    name: 'phase7 daily review persists structured review outputs',
    fn: testDailyReviewPersistsStructuredReviewOutputs,
  },
];
