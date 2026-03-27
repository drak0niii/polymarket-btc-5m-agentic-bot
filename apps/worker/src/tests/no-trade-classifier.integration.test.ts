import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildStrategyVariantId,
  createDefaultLearningState,
  createDefaultStrategyVariantState,
  createEmptyDecisionVersionLineage,
} from '@polymarket-btc-5m-agentic-bot/domain';
import {
  NoTradeClassifier,
  NoTradeReasonStore,
  TradeAdmissionGate,
} from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { BuildSignalsJob } from '../jobs/buildSignals.job';
import { EvaluateTradeOpportunitiesJob } from '../jobs/evaluateTradeOpportunities.job';
import { LearningStateStore } from '../runtime/learning-state-store';
import { StrategyDeploymentRegistry } from '../runtime/strategy-deployment-registry';
import { VersionLineageRegistry } from '../runtime/version-lineage-registry';
import { TradeQualityHistoryStore } from '@polymarket-btc-5m-agentic-bot/risk-engine';

async function testNoTradeClassifierEmitsExplicitReasonCodes(): Promise<void> {
  const classifier = new NoTradeClassifier();
  const decision = classifier.classify({
    spread: 0.061,
    spreadLimit: 0.05,
    orderbookFresh: false,
    orderbookAgeMs: 8_500,
    topLevelDepth: 7,
    minimumTopLevelDepth: 20,
    toxicityScore: 0.81,
    toxicityState: 'unsafe',
    venueUncertaintyLabel: 'degraded',
    regimeLabel: 'spike_and_revert',
    regimeConfidence: 0.44,
    regimeTransitionRisk: 0.76,
    expectedNetEdgeBps: 9,
    minimumNetEdgeBps: 14,
    timeToExpirySeconds: 28,
    noTradeWindowSeconds: 30,
    empiricalEvidence: {
      blockRate: 0.72,
      sampleCount: 12,
      dominantReasonCodes: ['regime_unstable', 'event_window_too_noisy'],
    },
  });

  assert.strictEqual(decision.allowTrade, false);
  assert.strictEqual(decision.reasonCodes.includes('spread_too_wide'), true);
  assert.strictEqual(decision.reasonCodes.includes('orderbook_stale'), true);
  assert.strictEqual(decision.reasonCodes.includes('low_depth'), true);
  assert.strictEqual(decision.reasonCodes.includes('high_toxicity'), true);
  assert.strictEqual(decision.reasonCodes.includes('venue_uncertainty_elevated'), true);
  assert.strictEqual(decision.reasonCodes.includes('regime_unstable'), true);
  assert.strictEqual(
    decision.reasonCodes.includes('edge_too_marginal_after_costs'),
    true,
  );
  assert.strictEqual(
    decision.reasonCodes.includes('event_window_too_noisy'),
    true,
  );
  assert.strictEqual(decision.confidence >= 0.6, true);
}

async function testNoTradeReasonStoreWritesReadsAndSummarizes(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase4-no-trade-store-'));
  const store = new NoTradeReasonStore(rootDir);

  await store.append({
    timestamp: '2026-03-27T10:00:00.000Z',
    marketId: 'm1',
    tokenId: 'yes1',
    strategyVariantId: 'variant-1',
    regimeLabel: 'spike_and_revert',
    regimeConfidence: 0.52,
    regimeTransitionRisk: 0.68,
    allowTrade: false,
    reasonCodes: ['regime_unstable', 'edge_too_marginal_after_costs'],
    conditions: {
      spread: 0.04,
      spreadLimit: 0.05,
      orderbookFresh: true,
      orderbookAgeMs: 500,
      topLevelDepth: 18,
      minimumTopLevelDepth: 20,
      toxicityScore: 0.41,
      toxicityState: 'elevated',
      venueUncertaintyLabel: 'healthy',
      regimeLabel: 'spike_and_revert',
      regimeConfidence: 0.52,
      regimeTransitionRisk: 0.68,
      expectedNetEdgeBps: 11,
      minimumNetEdgeBps: 12,
      empiricalBlockRate: 0.61,
      empiricalSampleCount: 9,
      timeToExpirySeconds: 120,
      noTradeWindowSeconds: 30,
    },
    expectedNetEdgeBps: 11,
    evidenceSummary: {
      source: 'build_signals',
      signalId: 'signal-1',
      signalDecisionId: null,
      regimeEvidenceQuality: 'limited',
      empiricalBlockRate: 0.61,
      sampleCount: 9,
      notes: ['regime_block_bias'],
    },
  });
  await store.append({
    timestamp: '2026-03-27T10:01:00.000Z',
    marketId: 'm2',
    tokenId: 'yes2',
    strategyVariantId: 'variant-1',
    regimeLabel: 'spike_and_revert',
    regimeConfidence: 0.66,
    regimeTransitionRisk: 0.59,
    allowTrade: true,
    reasonCodes: [],
    conditions: {
      spread: 0.018,
      spreadLimit: 0.05,
      orderbookFresh: true,
      orderbookAgeMs: 220,
      topLevelDepth: 32,
      minimumTopLevelDepth: 20,
      toxicityScore: 0.22,
      toxicityState: 'normal',
      venueUncertaintyLabel: 'healthy',
      regimeLabel: 'spike_and_revert',
      regimeConfidence: 0.66,
      regimeTransitionRisk: 0.59,
      expectedNetEdgeBps: 22,
      minimumNetEdgeBps: 12,
      empiricalBlockRate: 0.61,
      empiricalSampleCount: 9,
      timeToExpirySeconds: 180,
      noTradeWindowSeconds: 30,
    },
    expectedNetEdgeBps: 22,
    evidenceSummary: {
      source: 'evaluate_trade_opportunities',
      signalId: 'signal-2',
      signalDecisionId: null,
      regimeEvidenceQuality: 'strong',
      empiricalBlockRate: 0.61,
      sampleCount: 9,
      notes: [],
    },
  });

  const recent = await store.loadRecent(5);
  const summary = await store.summarizeRecent({ strategyVariantId: 'variant-1' });

  assert.strictEqual(recent.length, 2);
  assert.strictEqual(summary.totalCount, 2);
  assert.strictEqual(summary.blockedCount, 1);
  assert.strictEqual(summary.byReasonCode[0]?.reasonCode, 'regime_unstable');
  assert.strictEqual(summary.byRegime[0]?.regimeLabel, 'spike_and_revert');
}

async function testTradeAdmissionGateRejectsLowConfidenceAndInsufficientEvidence(): Promise<void> {
  const gate = new TradeAdmissionGate();
  const baseInput = {
    edgeDefinitionVersion: 'edge-v1',
    signalPresent: true,
    directionalEdge: 0.02,
    executableEv: 0.01,
    signalConfidence: 0.82,
    walkForwardConfidence: 0.84,
    liquidityHealthy: true,
    freshnessHealthy: true,
    venueHealthy: true,
    reconciliationHealthy: true,
    riskHealthy: true,
    regimeAllowed: true,
    executableEdge: {
      edgeDefinitionVersion: 'edge-v1',
      executionStyle: 'hybrid' as const,
      rawModelEdge: 0.02,
      spreadAdjustedEdge: 0.018,
      slippageAdjustedEdge: 0.015,
      feeAdjustedEdge: 0.013,
      timeoutAdjustedEdge: 0.012,
      staleSignalAdjustedEdge: 0.011,
      inventoryAdjustedEdge: 0.01,
      finalNetEdge: 0.01,
      threshold: 0.0025,
      missingInputs: [],
      staleInputs: [],
      paperEdgeBlocked: false,
      confidence: 0.83,
    },
    regimeLabel: 'spike_and_revert',
  };

  const lowConfidence = gate.evaluate({
    ...baseInput,
    regimeConfidence: 0.42,
    regimeTransitionRisk: 0.71,
    regimeEvidenceSampleCount: 12,
    minimumRegimeEvidenceSampleCount: 6,
  });
  const thinEvidence = gate.evaluate({
    ...baseInput,
    regimeConfidence: 0.74,
    regimeTransitionRisk: 0.34,
    regimeEvidenceSampleCount: 2,
    minimumRegimeEvidenceSampleCount: 6,
  });

  assert.strictEqual(lowConfidence.admitted, false);
  assert.strictEqual(lowConfidence.reasonCode, 'regime_confidence_too_low');
  assert.strictEqual(lowConfidence.regimeContext.regimeLabel, 'spike_and_revert');
  assert.strictEqual(thinEvidence.admitted, false);
  assert.strictEqual(thinEvidence.reasonCode, 'regime_evidence_insufficient');
  assert.strictEqual(
    thinEvidence.evidenceQualitySummary.regimeEvidenceQuality,
    'insufficient',
  );
}

async function testBuildSignalsAttachesRegimeAndNoTradeContext(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase4-build-signals-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const versionLineageRegistry = new VersionLineageRegistry(
    path.join(rootDir, 'version-lineage'),
  );
  const deploymentRegistry = new StrategyDeploymentRegistry(
    path.join(rootDir, 'deployment-registry'),
  );
  const noTradeReasonStore = new NoTradeReasonStore(path.join(rootDir, 'no-trade'));
  const createdSignals: Array<Record<string, unknown>> = [];
  const auditEvents: Array<Record<string, unknown>> = [];

  const prisma = {
    strategyVersion: {
      findFirst: async () => ({ id: 'strategy-live-1' }),
    },
    market: {
      findMany: async () => [
        {
          id: 'm1',
          slug: 'btc-5m',
          title: 'Will BTC be higher in 5 minutes?',
          status: 'active',
          tokenIdYes: 'yes1',
          tokenIdNo: 'no1',
          expiresAt: new Date(Date.now() + 240_000),
          updatedAt: new Date(),
        },
      ],
    },
    orderbook: {
      findFirst: async () => ({
        bestBid: 0.46,
        bestAsk: 0.522,
        spread: 0.062,
        bidLevels: [{ price: 0.46, size: 4 }],
        askLevels: [{ price: 0.522, size: 7 }],
        tickSize: 0.01,
        minOrderSize: 1,
        negRisk: false,
        observedAt: new Date(),
      }),
    },
    marketSnapshot: {
      findFirst: async () => ({
        observedAt: new Date(),
        expiresAt: new Date(Date.now() + 240_000),
        volume: 220,
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
      create: async () => null,
    },
    auditEvent: {
      findMany: async () => [],
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
    noTradeReasonStore,
  );
  const result = await job.run(buildBtcReference());
  const edgeAudit = auditEvents.find((event) => event.eventType === 'signal.edge_assessed');
  const admissionAudit = auditEvents.find(
    (event) => event.eventType === 'signal.admission_decision',
  );
  const edgeMetadata =
    edgeAudit && typeof edgeAudit.metadata === 'object'
      ? (edgeAudit.metadata as Record<string, unknown>)
      : null;
  const admissionMetadata =
    admissionAudit && typeof admissionAudit.metadata === 'object'
      ? (admissionAudit.metadata as Record<string, unknown>)
      : null;
  const storeSummary = await noTradeReasonStore.summarizeRecent();

  assert.strictEqual(result.created, 0);
  assert.strictEqual(createdSignals.length, 1);
  assert.ok(edgeMetadata?.regimeContext);
  assert.ok(edgeMetadata?.noTradePrecheck);
  assert.ok(admissionMetadata?.regimeContext);
  assert.ok(admissionMetadata?.noTradePrecheck);
  assert.ok(admissionMetadata?.noTradeEvidenceSummary);
  assert.strictEqual(storeSummary.totalCount >= 1, true);
}

async function testEvaluateTradeOpportunitiesPersistsNoTradeAndRegimeEvidence(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase4-evaluate-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const versionLineageRegistry = new VersionLineageRegistry(
    path.join(rootDir, 'version-lineage'),
  );
  const deploymentRegistry = new StrategyDeploymentRegistry(
    path.join(rootDir, 'deployment-registry'),
  );
  const noTradeReasonStore = new NoTradeReasonStore(path.join(rootDir, 'no-trade'));
  const tradeQualityHistoryStore = new TradeQualityHistoryStore(
    path.join(rootDir, 'trade-quality'),
  );
  const createdDecisions: Array<Record<string, unknown>> = [];
  const auditEvents: Array<Record<string, unknown>> = [];
  const signal = {
    id: 'signal-1',
    marketId: 'm1',
    strategyVersionId: 'strategy-live-1',
    status: 'created',
    observedAt: new Date(Date.now() - 5_000),
    posteriorProbability: 0.66,
    marketImpliedProb: 0.54,
    expectedEv: 0.05,
    edge: 0.032,
    regime: 'spike_and_revert',
    side: 'BUY',
  };
  const strategyVariantId = buildStrategyVariantId(signal.strategyVersionId);
  const learningState = createDefaultLearningState();
  const variant = createDefaultStrategyVariantState(strategyVariantId);
  variant.regimeSnapshots['regime:spike'] = {
    key: 'regime:spike',
    strategyVariantId,
    regime: 'spike_and_revert',
    liquidityBucket: 'balanced',
    spreadBucket: 'wide',
    timeToExpiryBucket: 'under_15m',
    entryTimingBucket: 'early',
    executionStyle: 'hybrid',
    side: 'buy',
    sampleCount: 12,
    winRate: 0.4,
    expectedEvSum: 0.2,
    realizedEvSum: 0.03,
    avgExpectedEv: 0.016,
    avgRealizedEv: 0.0025,
    realizedVsExpected: 0.16,
    avgFillRate: 0.62,
    avgSlippage: 0.011,
    health: 'degraded',
    lastObservedAt: '2026-03-27T09:00:00.000Z',
  };
  learningState.strategyVariants[strategyVariantId] = variant;
  await learningStateStore.save(learningState);

  await versionLineageRegistry.recordDecision({
    decisionId: 'build-signal-1',
    decisionType: 'signal_build',
    signalId: signal.id,
    summary: 'Phase 4 upstream signal build evidence',
    strategyVariantId,
    recordedAt: '2026-03-27T09:55:00.000Z',
    lineage: createEmptyDecisionVersionLineage(),
    replay: {
      marketState: null,
      runtimeState: null,
      learningState: null,
      lineageState: null,
      activeParameterBundle: {
        alphaAttribution: {
          expectedNetEdge: 0.022,
          paperEdge: 0.03,
        },
        phaseTwoContext: {
          marketArchetype: 'expiry_pressure',
        },
        toxicity: {
          toxicityState: 'high',
        },
        noTradePrecheck: {
          allowTrade: false,
          reasonCodes: ['spread_too_wide', 'regime_unstable'],
          confidence: 0.88,
          conditions: {
            regimeLabel: 'spike_and_revert',
            regimeConfidence: 0.53,
            regimeTransitionRisk: 0.71,
          },
        },
      },
      venueMode: null,
      venueUncertainty: null,
    },
    tags: ['signal-build'],
  });

  const prisma = {
    signal: {
      findMany: async () => [signal],
      update: async () => null,
    },
    portfolioSnapshot: {
      findFirst: async () => ({
        bankroll: 1_000,
        availableCapital: 450,
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
      findMany: async () => [
        {
          id: 'm1',
          slug: 'btc-5m',
          title: 'Will BTC be higher in 5 minutes?',
          status: 'active',
          tokenIdYes: 'yes1',
          tokenIdNo: 'no1',
          expiresAt: new Date(Date.now() + 180_000),
        },
      ],
    },
    orderbook: {
      findFirst: async () => ({
        bestBid: 0.48,
        bestAsk: 0.533,
        spread: 0.053,
        bidLevels: [{ price: 0.48, size: 8 }],
        askLevels: [{ price: 0.533, size: 10 }],
        tickSize: 0.01,
        minOrderSize: 1,
        negRisk: false,
        observedAt: new Date(),
      }),
    },
    marketSnapshot: {
      findFirst: async () => ({
        observedAt: new Date(),
        expiresAt: new Date(Date.now() + 180_000),
        volume: 320,
        marketPrice: 0.533,
      }),
    },
    reconciliationCheckpoint: {
      findFirst: async ({ where }: { where: { source: string } }) =>
        where.source === 'research_governance_validation'
          ? {
              source: where.source,
              processedAt: new Date(),
              status: 'passed',
              details: {
                robustness: { passed: true },
                promotion: { score: 0.8 },
              },
            }
          : {
              source: where.source,
              processedAt: new Date(),
              status: 'completed',
            },
    },
    botRuntimeStatus: {
      findUnique: async () => ({ id: 'live', state: 'running', lastHeartbeatAt: new Date() }),
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
  const venueHealthLearningStore = {
    getCurrentMetrics: async () => ({
      venueId: 'polymarket',
      updatedAt: new Date().toISOString(),
      latencyDistribution: {
        sampleCount: 8,
        averageMs: 180,
        p50Ms: 160,
        p90Ms: 240,
        p99Ms: 320,
        maxMs: 340,
      },
      requestFailures: {
        totalRequests: 20,
        failedRequests: 0,
        failureRate: 0,
        failuresByCategory: {},
      },
      staleDataIntervals: {
        sampleCount: 6,
        averageMs: 400,
        p90Ms: 620,
        maxMs: 700,
      },
      openOrderVisibilityLag: {
        sampleCount: 4,
        averageMs: 140,
        p90Ms: 220,
        maxMs: 240,
      },
      tradeVisibilityLag: {
        sampleCount: 4,
        averageMs: 130,
        p90Ms: 200,
        maxMs: 220,
      },
      cancelAcknowledgmentLag: {
        sampleCount: 4,
        averageMs: 160,
        p90Ms: 260,
        maxMs: 280,
      },
      activeMode: 'normal',
      uncertaintyLabel: 'healthy',
    }),
    setOperationalAssessment: async () => null,
  };

  const job = new EvaluateTradeOpportunitiesJob(
    prisma as never,
    runtimeControl as never,
    deploymentRegistry,
    learningStateStore,
    versionLineageRegistry,
    venueHealthLearningStore as never,
    tradeQualityHistoryStore,
    noTradeReasonStore,
  );
  const result = await job.run({
    maxOpenPositions: 2,
    maxDailyLossPct: 5,
    maxPerTradeRiskPct: 1,
    maxKellyFraction: 0.05,
    maxConsecutiveLosses: 2,
    noTradeWindowSeconds: 30,
    evaluationIntervalMs: 1_000,
    orderReconcileIntervalMs: 2_000,
    portfolioRefreshIntervalMs: 5_000,
  });
  const decisionEvent = auditEvents.find(
    (event) => event.eventType === 'signal.execution_decision',
  );
  const metadata =
    decisionEvent && typeof decisionEvent.metadata === 'object'
      ? (decisionEvent.metadata as Record<string, unknown>)
      : null;
  const noTradeSummary = await noTradeReasonStore.summarizeRecent();

  assert.strictEqual(result.approved + result.rejected, 1);
  assert.strictEqual(createdDecisions.length, 1);
  assert.ok(metadata?.noTradeDecision);
  assert.ok(metadata?.noTradeReasonCodes);
  assert.strictEqual(metadata?.regimeLabel, 'spike_and_revert');
  assert.strictEqual(typeof metadata?.regimeConfidence, 'number');
  assert.strictEqual(typeof metadata?.regimeTransitionRisk, 'number');
  assert.ok(metadata?.finalGateDecision);
  assert.strictEqual(noTradeSummary.totalCount >= 1, true);
}

function buildBtcReference() {
  return {
    symbol: 'BTCUSD',
    spotPrice: 105_000,
    candles: buildBtcCandleSeries(),
    observedAt: new Date().toISOString(),
  };
}

function buildBtcCandleSeries() {
  const start = Date.now() - 11 * 300_000;
  return Array.from({ length: 12 }, (_, index) => {
    const base = 104_700 + index * 12;
    return {
      timestamp: new Date(start + index * 300_000).toISOString(),
      open: base,
      high: base + 22,
      low: base - 18,
      close: base + (index % 2 === 0 ? 16 : -4),
      volume: 120 + index * 4,
    };
  });
}

export const phaseFourNoTradeAuthorityTests = [
  {
    name: 'phase4 no-trade classifier emits explicit reason codes',
    fn: testNoTradeClassifierEmitsExplicitReasonCodes,
  },
  {
    name: 'phase4 no-trade reason store writes reads and summarizes',
    fn: testNoTradeReasonStoreWritesReadsAndSummarizes,
  },
  {
    name: 'phase4 trade admission gate enforces regime confidence and evidence quality',
    fn: testTradeAdmissionGateRejectsLowConfidenceAndInsufficientEvidence,
  },
  {
    name: 'phase4 build signals attaches regime and no-trade context',
    fn: testBuildSignalsAttachesRegimeAndNoTradeContext,
  },
  {
    name: 'phase4 evaluate trade opportunities persists no-trade and regime evidence',
    fn: testEvaluateTradeOpportunitiesPersistsNoTradeAndRegimeEvidence,
  },
];
