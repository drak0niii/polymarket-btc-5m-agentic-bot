import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  BenchmarkRelativeSizing,
  BetSizing,
  EvidenceQualitySizer,
  LiveTrustScore,
  TradeQualityHistoryStore,
} from '@polymarket-btc-5m-agentic-bot/risk-engine';
import type { ResolvedTradeRecord } from '@polymarket-btc-5m-agentic-bot/domain';
import {
  buildStrategyVariantId,
  createDefaultLearningState,
  createDefaultStrategyVariantState,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { NoTradeReasonStore } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { EvaluateTradeOpportunitiesJob } from '../jobs/evaluateTradeOpportunities.job';
import { formatCapitalGrowthMetricsOutput } from '../commands/print-capital-growth-metrics.command';
import { LearningStateStore } from '../runtime/learning-state-store';
import { ResolvedTradeLedger } from '../runtime/resolved-trade-ledger';
import { StrategyDeploymentRegistry } from '../runtime/strategy-deployment-registry';
import { VersionLineageRegistry } from '../runtime/version-lineage-registry';

async function testLiveTrustScoreBreakdownIsBounded(): Promise<void> {
  const trust = new LiveTrustScore().evaluate({
    strategyVariantId: 'variant:strategy-live-1',
    regime: 'trend_burst',
    resolvedTrades: buildResolvedTrades({
      count: 10,
      strategyVariantId: 'variant:strategy-live-1',
      regime: 'trend_burst',
      realizedNetEdgeBps: 72,
      expectedNetEdgeBps: 60,
      benchmarkState: 'outperforming',
      lifecycleState: 'economically_resolved_with_portfolio_truth',
    }),
  });

  assert.strictEqual(trust.sampleCount, 10);
  assert.strictEqual(trust.trustScore >= 0 && trust.trustScore <= 1, true);
  assert.strictEqual(trust.componentBreakdown.sampleSufficiency >= 0, true);
  assert.strictEqual(trust.componentBreakdown.netExpectancyAfterCosts > 0.5, true);
  assert.strictEqual(trust.componentBreakdown.benchmarkOutperformance >= 0.5, true);
}

async function testEvidenceQualitySizerMapsBandsDeterministically(): Promise<void> {
  const sizer = new EvidenceQualitySizer();

  const shadowOnly = sizer.evaluate({
    trust: buildTrustDecision({
      trustScore: 0.2,
      sampleCount: 2,
      benchmarkOutperformance: 0.2,
      reconciliationCleanliness: 0.4,
    }),
  });
  const halfSize = sizer.evaluate({
    trust: buildTrustDecision({
      trustScore: 0.55,
      sampleCount: 10,
      benchmarkOutperformance: 0.7,
      reconciliationCleanliness: 0.8,
    }),
  });
  const fullSize = sizer.evaluate({
    trust: buildTrustDecision({
      trustScore: 0.86,
      sampleCount: 16,
      benchmarkOutperformance: 0.85,
      reconciliationCleanliness: 0.92,
    }),
  });

  assert.strictEqual(shadowOnly.evidenceFactor, 0);
  assert.strictEqual(shadowOnly.recentEvidenceBand, 'shadow_only');
  assert.strictEqual(halfSize.evidenceFactor, 0.5);
  assert.strictEqual(halfSize.recentEvidenceBand, 'half_size');
  assert.strictEqual(fullSize.evidenceFactor, 1);
  assert.strictEqual(fullSize.recentEvidenceBand, 'full_size');
}

async function testBetSizingShowsEvidenceFactorDecomposition(): Promise<void> {
  const result = new BetSizing().calculate({
    bankroll: 1_000,
    availableCapital: 500,
    cappedKellyFraction: 0.05,
    maxPerTradeRiskPct: 1,
    baseRiskOverride: 12,
    edgeFactor: 0.9,
    regimeFactor: 0.8,
    evidenceFactor: 0.5,
    deploymentTierFactor: 0.4,
    killSwitchFactor: 1,
  });

  assert.strictEqual(result.baseRisk, 10);
  assert.strictEqual(result.edgeFactor, 0.9);
  assert.strictEqual(result.evidenceFactor, 0.5);
  assert.strictEqual(Math.abs(result.finalMultiplier - 0.144) < 1e-12, true);
  assert.strictEqual(Math.abs(result.suggestedSize - 1.44) < 1e-12, true);
}

async function testBenchmarkRelativeClampBehaviorExposesClampAmount(): Promise<void> {
  const decision = new BenchmarkRelativeSizing().evaluate({
    regime: 'illiquid_noisy_book',
    overallUnderperformedBenchmarkIds: ['btc_follow_baseline', 'momentum_baseline'],
    overallOutperformedBenchmarkIds: [],
    strategyRegimeBreakdown: [
      {
        regime: 'illiquid_noisy_book',
        sampleCount: 12,
        tradeCount: 6,
        expectedEv: 0.006,
        realizedEv: -0.002,
        realizedVsExpected: -0.33,
      },
    ],
    benchmarks: [
      {
        benchmarkId: 'btc_follow_baseline',
        benchmarkName: 'BTC Follow',
        regimeBreakdown: [
          {
            regime: 'illiquid_noisy_book',
            sampleCount: 12,
            tradeCount: 6,
            expectedEv: 0.009,
            realizedEv: 0.004,
            realizedVsExpected: 0.44,
          },
        ],
      },
      {
        benchmarkId: 'momentum_baseline',
        benchmarkName: 'Momentum',
        regimeBreakdown: [
          {
            regime: 'illiquid_noisy_book',
            sampleCount: 12,
            tradeCount: 6,
            expectedEv: 0.008,
            realizedEv: 0.003,
            realizedVsExpected: 0.38,
          },
        ],
      },
    ],
  });

  assert.strictEqual(decision.benchmarkComparisonState, 'underperforming');
  assert.strictEqual(decision.baselinePenaltyMultiplier < 1, true);
  assert.strictEqual(decision.clampAmount > 0, true);
  assert.strictEqual(decision.rationale.length > 0, true);
}

async function testEvaluateTradeOpportunitiesPersistsEvidenceWeightedSizing(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-evidence-sizing-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const versionLineageRegistry = new VersionLineageRegistry(path.join(rootDir, 'lineage'));
  const deploymentRegistry = new StrategyDeploymentRegistry(path.join(rootDir, 'deployment'));
  const tradeQualityHistoryStore = new TradeQualityHistoryStore(path.join(rootDir, 'quality'));
  const noTradeReasonStore = new NoTradeReasonStore(path.join(rootDir, 'no-trade'));
  const resolvedTradeLedger = new ResolvedTradeLedger(rootDir);
  const strategyVariantId = buildStrategyVariantId('strategy-live-1');
  const regime = 'trend_burst';
  const learningState = createDefaultLearningState(new Date('2026-03-27T00:00:00.000Z'));
  learningState.strategyVariants[strategyVariantId] = {
    ...createDefaultStrategyVariantState(strategyVariantId),
    health: 'healthy',
    regimeSnapshots: {
      [`regime:${regime}`]: {
        key: `regime:${regime}`,
        regime,
        liquidityBucket: 'balanced',
        spreadBucket: 'normal',
        timeToExpiryBucket: 'under_15m',
        entryTimingBucket: 'early',
        executionStyle: 'hybrid',
        side: 'buy',
        strategyVariantId,
        sampleCount: 20,
        winRate: 0.61,
        expectedEvSum: 0.32,
        realizedEvSum: 0.27,
        avgExpectedEv: 0.016,
        avgRealizedEv: 0.0135,
        realizedVsExpected: 0.84,
        avgFillRate: 0.83,
        avgSlippage: 0.0022,
        health: 'healthy',
        lastObservedAt: '2026-03-27T00:00:00.000Z',
      },
    },
  };
  learningState.lastCycleSummary = {
    cycleId: 'cycle-1',
    startedAt: '2026-03-27T00:00:00.000Z',
    completedAt: '2026-03-27T00:10:00.000Z',
    status: 'completed',
    analyzedWindow: {
      from: '2026-03-27T00:00:00.000Z',
      to: '2026-03-27T00:10:00.000Z',
    },
    realizedOutcomeCount: 10,
    attributionSliceCount: 10,
    calibrationUpdates: 0,
    shrinkageActions: 0,
    degradedContexts: [],
    warnings: [],
    errors: [],
    reviewOutputs: {
      baselineBenchmarks: buildBaselineComparisonReport(regime),
    },
  };
  await learningStateStore.save(learningState);

  for (const record of buildResolvedTrades({
    count: 10,
    strategyVariantId,
    regime,
    realizedNetEdgeBps: 78,
    expectedNetEdgeBps: 64,
    benchmarkState: 'outperforming',
    lifecycleState: 'economically_resolved_with_portfolio_truth',
  })) {
    await resolvedTradeLedger.append(record);
  }

  await versionLineageRegistry.recordDecision({
    decisionId: 'build-signal-1',
    decisionType: 'signal_build',
    signalId: 'signal-1',
    marketId: 'm1',
    strategyVariantId,
    summary: 'seed upstream evidence',
    lineage: {
      strategyVersion: null,
      featureSetVersion: null,
      calibrationVersion: null,
      executionPolicyVersion: null,
      riskPolicyVersion: null,
      allocationPolicyVersion: null,
    },
    replay: {
      marketState: null,
      runtimeState: null,
      learningState: null,
      lineageState: null,
      activeParameterBundle: {
        phaseTwoContext: {
          marketArchetype: 'trend_follow_through',
        },
        noTradePrecheck: {
          allowTrade: true,
          reasonCodes: [],
          conditions: {
            regimeLabel: regime,
            regimeConfidence: 0.86,
            regimeTransitionRisk: 0.18,
          },
        },
      },
      venueMode: null,
      venueUncertainty: null,
    },
    tags: ['signal-build'],
    recordedAt: new Date('2026-03-27T00:00:01.000Z').toISOString(),
  });

  const createdDecisions: Array<Record<string, unknown>> = [];
  const auditEvents: Array<Record<string, unknown>> = [];
  const prisma = {
    signal: {
      findMany: async () => [
        {
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
          edge: 0.036,
          expectedEv: 0.055,
          regime,
          status: 'approved',
          observedAt: new Date(Date.now() - 4_000),
        },
      ],
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
          expiresAt: new Date(Date.now() + 300_000),
        },
      ],
    },
    orderbook: {
      findFirst: async () => ({
        bestBid: 0.54,
        bestAsk: 0.55,
        spread: 0.01,
        bidLevels: [
          { price: 0.54, size: 24 },
          { price: 0.53, size: 18 },
        ],
        askLevels: [
          { price: 0.55, size: 24 },
          { price: 0.56, size: 18 },
        ],
        tickSize: 0.01,
        minOrderSize: 1,
        negRisk: false,
        observedAt: new Date(),
      }),
    },
    marketSnapshot: {
      findFirst: async () => ({
        observedAt: new Date(),
        expiresAt: new Date(Date.now() + 300_000),
        volume: 500,
        marketPrice: 0.55,
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
                promotion: { score: 0.82 },
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
      updatedAt: new Date('2026-03-27T00:00:00.000Z').toISOString(),
      latencyDistribution: {
        sampleCount: 10,
        averageMs: 220,
        p50Ms: 200,
        p90Ms: 320,
        p99Ms: 450,
        maxMs: 500,
      },
      requestFailures: {
        totalRequests: 20,
        failedRequests: 0,
        failureRate: 0,
        failuresByCategory: {},
      },
      staleDataIntervals: {
        sampleCount: 5,
        averageMs: 500,
        p90Ms: 900,
        maxMs: 1_000,
      },
      openOrderVisibilityLag: {
        sampleCount: 5,
        averageMs: 200,
        p90Ms: 300,
        maxMs: 320,
      },
      tradeVisibilityLag: {
        sampleCount: 5,
        averageMs: 180,
        p90Ms: 260,
        maxMs: 280,
      },
      cancelAcknowledgmentLag: {
        sampleCount: 5,
        averageMs: 240,
        p90Ms: 350,
        maxMs: 400,
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
    resolvedTradeLedger,
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
  const sizeDecomposition =
    metadata?.sizeDecomposition && typeof metadata.sizeDecomposition === 'object'
      ? (metadata.sizeDecomposition as Record<string, unknown>)
      : null;
  const trustScoreSummary =
    metadata?.trustScoreSummary && typeof metadata.trustScoreSummary === 'object'
      ? (metadata.trustScoreSummary as Record<string, unknown>)
      : null;

  assert.strictEqual(result.approved + result.rejected, 1);
  assert.ok(
    createdDecisions.find(
      (decision) =>
        decision.verdict === 'approved' || decision.verdict === 'rejected',
    ),
  );
  assert.ok(sizeDecomposition);
  assert.strictEqual(typeof sizeDecomposition?.baseRisk, 'number');
  assert.strictEqual(typeof sizeDecomposition?.edgeFactor, 'number');
  assert.strictEqual(typeof sizeDecomposition?.regimeFactor, 'number');
  assert.strictEqual(typeof sizeDecomposition?.evidenceFactor, 'number');
  assert.strictEqual(typeof sizeDecomposition?.deploymentTierFactor, 'number');
  assert.strictEqual(typeof sizeDecomposition?.killSwitchFactor, 'number');
  assert.strictEqual(typeof sizeDecomposition?.benchmarkClampAmount, 'number');
  assert.ok(trustScoreSummary);
  assert.strictEqual(typeof trustScoreSummary?.trustScore, 'number');
  assert.strictEqual(
    metadata?.evidenceThresholdsUsed && typeof metadata.evidenceThresholdsUsed === 'object',
    true,
  );
}

async function testPrintCapitalGrowthMetricsShowsTrustEvidenceStatus(): Promise<void> {
  const resolvedTrades = buildResolvedTrades({
    count: 8,
    strategyVariantId: 'variant:strategy-live-1',
    regime: 'trend_burst',
    realizedNetEdgeBps: 70,
    expectedNetEdgeBps: 58,
    benchmarkState: 'outperforming',
    lifecycleState: 'economically_resolved_with_portfolio_truth',
  });
  const output = formatCapitalGrowthMetricsOutput({
    report: {
      generatedAt: '2026-03-27T00:00:00.000Z',
      window: {
        from: '2026-03-26T00:00:00.000Z',
        to: '2026-03-27T00:00:00.000Z',
      },
      variants: [
        {
          strategyVariantId: 'variant:strategy-live-1',
          metrics: {
            stabilityAdjustedCapitalGrowthScore: 0.82,
          },
        },
      ],
      compoundingEfficient: [],
      profitableButUnstable: [],
      shouldScale: [],
      shouldReduce: [],
      baselineComparison: null,
      rollingBenchmarkScorecard: null,
      retentionReport: null,
      regimePerformanceReport: null,
      liveProofScorecard: {
        promotableEvidence: true,
      },
    } as never,
    resolvedTrades,
  });

  assert.ok(output.overallTrustScore);
  assert.strictEqual(typeof output.recentEvidenceBand, 'string');
  assert.strictEqual(Array.isArray(output.sizeClampReasons), true);
  assert.strictEqual(typeof output.benchmarkRelativeClampStatus, 'string');
  assert.ok(output.capitalRampEligibility);
  assert.strictEqual(Array.isArray(output.trustByStrategyRegime), true);
  assert.strictEqual(output.trustByStrategyRegime.length > 0, true);
}

function buildTrustDecision(input: {
  trustScore: number;
  sampleCount: number;
  benchmarkOutperformance: number;
  reconciliationCleanliness: number;
}) {
  return {
    strategyVariantId: 'variant:strategy-live-1',
    regime: 'trend_burst',
    trustScore: input.trustScore,
    sampleCount: input.sampleCount,
    componentBreakdown: {
      liveTradeCount: input.sampleCount,
      sampleSufficiency: input.sampleCount >= 10 ? 0.8 : 0.3,
      netExpectancyAfterCosts: input.trustScore,
      drawdownStability: 0.8,
      executionVariance: 0.75,
      reconciliationCleanliness: input.reconciliationCleanliness,
      benchmarkOutperformance: input.benchmarkOutperformance,
    },
    reasonCodes: [],
    evidence: {},
    capturedAt: new Date().toISOString(),
  };
}

function buildResolvedTrades(input: {
  count: number;
  strategyVariantId: string;
  regime: string;
  realizedNetEdgeBps: number;
  expectedNetEdgeBps: number;
  benchmarkState: 'outperforming' | 'neutral' | 'underperforming' | 'context_missing';
  lifecycleState:
    | 'economically_resolved'
    | 'economically_resolved_with_portfolio_truth';
}): ResolvedTradeRecord[] {
  return Array.from({ length: input.count }, (_, index) =>
    createResolvedTradeRecord({
      tradeId: `trade-${index + 1}`,
      orderId: `order-${index + 1}`,
      strategyVariantId: input.strategyVariantId,
      strategyVersion: input.strategyVariantId.replace('variant:', ''),
      regime: input.regime,
      archetype: 'trend_follow_through',
      expectedNetEdgeBps: input.expectedNetEdgeBps,
      realizedNetEdgeBps: input.realizedNetEdgeBps - index,
      benchmarkContext: {
        benchmarkComparisonState: input.benchmarkState,
        baselinePenaltyMultiplier: input.benchmarkState === 'outperforming' ? 1 : 0.8,
        regimeBenchmarkGateState: input.benchmarkState === 'outperforming' ? 'passed' : 'blocked',
        underperformedBenchmarkIds:
          input.benchmarkState === 'underperforming' ? ['btc_follow_baseline'] : [],
        outperformedBenchmarkIds:
          input.benchmarkState === 'outperforming' ? ['btc_follow_baseline'] : [],
        reasonCodes: ['fixture'],
      },
      lifecycleState: input.lifecycleState,
      finalizedTimestamp: new Date(Date.UTC(2026, 2, 27, 0, index)).toISOString(),
    }),
  );
}

function createResolvedTradeRecord(
  overrides: Partial<ResolvedTradeRecord>,
): ResolvedTradeRecord {
  return {
    tradeId: overrides.tradeId ?? 'trade-default',
    orderId: overrides.orderId ?? 'order-default',
    venueOrderId: overrides.venueOrderId ?? 'venue-order-default',
    marketId: overrides.marketId ?? 'market-btc',
    tokenId: overrides.tokenId ?? 'token-up',
    strategyVariantId: overrides.strategyVariantId ?? 'variant:strategy-live-1',
    strategyVersion: overrides.strategyVersion ?? 'strategy-live-1',
    regime: overrides.regime ?? 'trend_burst',
    archetype: overrides.archetype ?? 'trend_follow_through',
    decisionTimestamp: overrides.decisionTimestamp ?? '2026-03-27T00:00:00.000Z',
    submissionTimestamp: overrides.submissionTimestamp ?? '2026-03-27T00:00:01.000Z',
    firstFillTimestamp: overrides.firstFillTimestamp ?? '2026-03-27T00:00:02.000Z',
    finalizedTimestamp: overrides.finalizedTimestamp ?? '2026-03-27T00:00:10.000Z',
    side: overrides.side ?? 'BUY',
    intendedPrice: overrides.intendedPrice ?? 0.51,
    averageFillPrice: overrides.averageFillPrice ?? 0.512,
    size: overrides.size ?? 20,
    notional: overrides.notional ?? 10.24,
    estimatedFeeAtDecision: overrides.estimatedFeeAtDecision ?? 0.05,
    realizedFee: overrides.realizedFee ?? 0.051,
    estimatedSlippageBps: overrides.estimatedSlippageBps ?? 14,
    realizedSlippageBps: overrides.realizedSlippageBps ?? 16,
    queueDelayMs: overrides.queueDelayMs ?? 4_000,
    fillFraction: overrides.fillFraction ?? 1,
    expectedNetEdgeBps: overrides.expectedNetEdgeBps ?? 58,
    realizedNetEdgeBps: overrides.realizedNetEdgeBps ?? 70,
    maxFavorableExcursionBps: overrides.maxFavorableExcursionBps ?? 105,
    maxAdverseExcursionBps: overrides.maxAdverseExcursionBps ?? -22,
    toxicityScoreAtDecision: overrides.toxicityScoreAtDecision ?? 0.16,
    benchmarkContext: overrides.benchmarkContext ?? null,
    lossAttributionCategory: overrides.lossAttributionCategory ?? 'mixed',
    executionAttributionCategory: overrides.executionAttributionCategory ?? 'queue_decay',
    lifecycleState: overrides.lifecycleState ?? 'economically_resolved_with_portfolio_truth',
    attribution: overrides.attribution ?? {
      benchmarkContext: overrides.benchmarkContext ?? null,
      lossAttributionCategory: 'mixed',
      executionAttributionCategory: 'queue_decay',
      primaryLeakageDriver: 'queue_delay',
      secondaryLeakageDrivers: ['slippage'],
      reasonCodes: ['fixture'],
    },
    executionQuality: overrides.executionQuality ?? {
      intendedPrice: 0.51,
      averageFillPrice: 0.512,
      size: 20,
      notional: 10.24,
      estimatedFeeAtDecision: 0.05,
      realizedFee: 0.051,
      estimatedSlippageBps: 14,
      realizedSlippageBps: 16,
      queueDelayMs: 4_000,
      fillFraction: 1,
    },
    netOutcome: overrides.netOutcome ?? {
      expectedNetEdgeBps: overrides.expectedNetEdgeBps ?? 58,
      realizedNetEdgeBps: overrides.realizedNetEdgeBps ?? 70,
      maxFavorableExcursionBps: 105,
      maxAdverseExcursionBps: -22,
      realizedPnl: 0.9,
    },
    capturedAt: overrides.capturedAt ?? overrides.finalizedTimestamp ?? '2026-03-27T00:00:10.000Z',
  };
}

function buildBaselineComparisonReport(regime: string) {
  return {
    generatedAt: '2026-03-27T00:00:00.000Z',
    strategy: {
      benchmarkId: 'strategy',
      benchmarkName: 'Primary Strategy',
      sampleCount: 12,
      tradeCount: 6,
      expectedEv: 0.016,
      realizedEv: 0.012,
      realizedVsExpected: 0.92,
      regimeBreakdown: [
        {
          regime,
          sampleCount: 12,
          tradeCount: 6,
          expectedEv: 0.016,
          realizedEv: 0.012,
          realizedVsExpected: 0.92,
        },
      ],
    },
    benchmarks: [
      {
        benchmarkId: 'btc_follow_baseline',
        benchmarkName: 'BTC Follow Baseline',
        regimeBreakdown: [
          {
            regime,
            sampleCount: 12,
            tradeCount: 6,
            expectedEv: 0.012,
            realizedEv: 0.01,
            realizedVsExpected: 0.79,
          },
        ],
      },
      {
        benchmarkId: 'momentum_baseline',
        benchmarkName: 'Momentum Baseline',
        regimeBreakdown: [
          {
            regime,
            sampleCount: 12,
            tradeCount: 6,
            expectedEv: 0.011,
            realizedEv: 0.009,
            realizedVsExpected: 0.8,
          },
        ],
      },
    ],
    comparisons: [],
    outperformedBenchmarkIds: ['btc_follow_baseline', 'momentum_baseline'],
    underperformedBenchmarkIds: [],
  };
}

export const phaseFiveEvidenceWeightedSizingTests = [
  {
    name: 'phase5 live trust score exposes bounded component breakdown',
    fn: testLiveTrustScoreBreakdownIsBounded,
  },
  {
    name: 'phase5 evidence quality sizer maps trust bands deterministically',
    fn: testEvidenceQualitySizerMapsBandsDeterministically,
  },
  {
    name: 'phase5 bet sizing exposes evidence-factor decomposition',
    fn: testBetSizingShowsEvidenceFactorDecomposition,
  },
  {
    name: 'phase5 benchmark-relative sizing exposes clamp behavior',
    fn: testBenchmarkRelativeClampBehaviorExposesClampAmount,
  },
  {
    name: 'phase5 evaluateTradeOpportunities persists full evidence-weighted size decomposition',
    fn: testEvaluateTradeOpportunitiesPersistsEvidenceWeightedSizing,
  },
  {
    name: 'phase5 capital growth metrics command shows trust and evidence sizing status',
    fn: testPrintCapitalGrowthMetricsShowsTrustEvidenceStatus,
  },
];
