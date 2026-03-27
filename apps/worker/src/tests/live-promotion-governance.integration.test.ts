import assert from 'assert';
import {
  type ResolvedTradeRecord,
  createDefaultStrategyDeploymentRegistryState,
  createStrategyVariantRecord,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { LiveTrustScore } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import {
  LiveDemotionGate,
  LivePromotionGate,
  buildLivePromotionEvidencePacket,
} from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { formatPromotionDecisionOutput } from '../commands/print-promotion-decision.command';
import { StrategyRolloutController } from '../runtime/strategy-rollout-controller';

async function testLivePromotionGateRequiresAllMandatoryLiveCriteria(): Promise<void> {
  const gate = new LivePromotionGate();
  const passingPacket = buildPacket({
    strategyVariantId: 'variant:strategy-pass',
    resolvedTrades: buildResolvedTrades({
      count: 10,
      strategyVariantId: 'variant:strategy-pass',
      strategyVersion: 'strategy-pass',
      regime: 'trend_burst',
      realizedNetEdgeBps: 82,
      expectedNetEdgeBps: 64,
      benchmarkState: 'outperforming',
      lifecycleState: 'economically_resolved_with_portfolio_truth',
    }),
  });
  const failingPacket = buildPacket({
    strategyVariantId: 'variant:strategy-fail',
    resolvedTrades: buildResolvedTrades({
      count: 4,
      strategyVariantId: 'variant:strategy-fail',
      strategyVersion: 'strategy-fail',
      regime: 'trend_burst',
      realizedNetEdgeBps: -28,
      expectedNetEdgeBps: 20,
      benchmarkState: 'underperforming',
      lifecycleState: 'economically_resolved',
      toxicityScoreAtDecision: 0.82,
    }),
  });

  const passingDecision = gate.evaluate({
    evidencePacket: passingPacket,
    now: new Date('2026-03-27T00:00:00.000Z'),
  });
  const failingDecision = gate.evaluate({
    evidencePacket: failingPacket,
    now: new Date('2026-03-27T00:00:00.000Z'),
  });

  assert.strictEqual(passingDecision.passed, true);
  assert.strictEqual(failingDecision.passed, false);
  assert.strictEqual(
    failingDecision.reasonCodes.includes('minimum_live_trade_count_not_met'),
    true,
  );
  assert.strictEqual(
    failingDecision.reasonCodes.includes('realized_net_edge_non_positive'),
    true,
  );
  assert.strictEqual(
    failingDecision.reasonCodes.includes('benchmark_outperformance_not_met'),
    true,
  );
  assert.strictEqual(
    failingDecision.reasonCodes.includes('reconciliation_anomalies_present'),
    true,
  );
}

async function testLiveDemotionGateEscalatesOnPoorLiveTruth(): Promise<void> {
  const packet = buildPacket({
    strategyVariantId: 'variant:strategy-demote',
    resolvedTrades: buildResolvedTrades({
      count: 10,
      strategyVariantId: 'variant:strategy-demote',
      strategyVersion: 'strategy-demote',
      regime: 'illiquid_noisy_book',
      realizedNetEdgeBps: -52,
      expectedNetEdgeBps: 28,
      benchmarkState: 'underperforming',
      lifecycleState: 'economically_resolved_with_portfolio_truth',
      toxicityScoreAtDecision: 0.92,
    }),
    regimeSnapshots: [
      { regime: 'illiquid_noisy_book', health: 'degraded', realizedVsExpected: -1.1 },
      { regime: 'trend_burst', health: 'quarantine_candidate', realizedVsExpected: -0.8 },
    ],
  });

  const decision = new LiveDemotionGate().evaluate({
    evidencePacket: packet,
    now: new Date('2026-03-27T00:00:00.000Z'),
  });

  assert.strictEqual(decision.action, 'quarantine');
  assert.strictEqual(
    decision.reasonCodes.includes('large_realized_vs_expected_edge_gap'),
    true,
  );
  assert.strictEqual(
    decision.reasonCodes.includes('benchmark_underperformance'),
    true,
  );
  assert.strictEqual(
    decision.reasonCodes.includes('high_regime_instability'),
    true,
  );
  assert.strictEqual(
    decision.reasonCodes.includes('repeated_adverse_selection_spikes'),
    true,
  );
  assert.strictEqual(typeof decision.quarantineUntil === 'string', true);
}

async function testRolloutControllerRefusesTierSkips(): Promise<void> {
  const now = new Date('2026-03-27T00:00:00.000Z');
  const registry = createDefaultStrategyDeploymentRegistryState(now);
  const incumbent = createStrategyVariantRecord({
    strategyVersionId: 'strategy-live-1',
    status: 'incumbent',
    evaluationMode: 'full',
    rolloutStage: 'scaled_live',
    capitalAllocationPct: 1,
    now,
    createdReason: 'fixture',
  });
  const challenger = createStrategyVariantRecord({
    strategyVersionId: 'strategy-challenger-2',
    status: 'shadow',
    evaluationMode: 'shadow_only',
    rolloutStage: 'shadow_only',
    capitalAllocationPct: 0,
    now,
    createdReason: 'fixture',
  });
  registry.incumbentVariantId = incumbent.variantId;
  registry.variants[incumbent.variantId] = incumbent;
  registry.variants[challenger.variantId] = challenger;

  const mutation = new StrategyRolloutController().applyPromotionDecision({
    registry,
    decision: {
      verdict: 'promote',
      candidateVariantId: challenger.variantId,
      incumbentVariantId: incumbent.variantId,
      targetRolloutStage: 'scaled_live',
      reasons: ['live_gate_passed'],
      evidence: {
        sampleCount: 12,
        calibrationHealth: 'healthy',
        executionHealth: 'healthy',
        realizedVsExpected: 1.1,
        realizedPnl: 1,
        improvementVsIncumbent: 0.08,
      },
      rollbackCriteria: [
        'realized_ev_collapse',
        'calibration_collapse',
        'execution_deterioration',
        'unexplained_drawdown',
        'quarantine_escalation',
      ],
      decidedAt: now.toISOString(),
    },
    cycleId: 'cycle-1',
    now,
  });

  assert.strictEqual(mutation.registry.activeRollout?.stage, 'paper');
  assert.strictEqual(
    mutation.registry.variants[challenger.variantId]?.rolloutStage,
    'paper',
  );
}

async function testPrintPromotionDecisionShowsLiveEvidencePacketAndStatus(): Promise<void> {
  const now = new Date('2026-03-27T00:00:00.000Z');
  const registry = createDefaultStrategyDeploymentRegistryState(now);
  const variant = createStrategyVariantRecord({
    strategyVersionId: 'strategy-live-1',
    status: 'probation',
    evaluationMode: 'canary',
    rolloutStage: 'canary',
    capitalAllocationPct: 0.05,
    now,
    createdReason: 'fixture',
  });
  registry.incumbentVariantId = variant.variantId;
  registry.variants[variant.variantId] = {
    ...variant,
    liveTrustScore: 0.62,
    evidenceWindowStart: '2026-03-20T00:00:00.000Z',
    evidenceWindowEnd: '2026-03-27T00:00:00.000Z',
    demotionReasonCodes: ['benchmark_underperformance'],
    quarantineUntil: '2026-03-28T00:00:00.000Z',
  };
  registry.lastPromotionDecision = {
    verdict: 'rollback',
    candidateVariantId: variant.variantId,
    incumbentVariantId: variant.variantId,
    targetRolloutStage: 'paper',
    reasons: ['benchmark_underperformance'],
    evidence: {
      sampleCount: 12,
      calibrationHealth: 'healthy',
      executionHealth: 'degraded',
      realizedVsExpected: 0.68,
      realizedPnl: -0.5,
      improvementVsIncumbent: -0.04,
      livePromotionGate: { passed: false, reasonCodes: ['benchmark_outperformance_not_met'] },
      liveDemotionGate: { action: 'probation', reasonCodes: ['benchmark_underperformance'] },
      liveEvidencePacket: {
        tradeCount: 12,
        evidenceWindowStart: '2026-03-20T00:00:00.000Z',
        evidenceWindowEnd: '2026-03-27T00:00:00.000Z',
      },
      promotionOrDemotionDecision: 'rollback',
      reasonCodes: ['benchmark_underperformance'],
    },
    rollbackCriteria: [
      'realized_ev_collapse',
      'calibration_collapse',
      'execution_deterioration',
      'unexplained_drawdown',
      'quarantine_escalation',
    ],
    decidedAt: now.toISOString(),
  };

  const output = formatPromotionDecisionOutput({
    variantId: variant.variantId,
    registryState: registry,
  });

  assert.strictEqual(output.currentDeploymentTier, 'canary');
  assert.strictEqual(output.currentStatus, 'probation');
  assert.strictEqual(output.liveTrustScore, 0.62);
  assert.deepStrictEqual(output.explicitReasonCodes, ['benchmark_underperformance']);
  assert.ok(output.livePromotionGate);
  assert.ok(output.liveDemotionGate);
  assert.ok(output.liveEvidencePacket);
  assert.deepStrictEqual(output.quarantineOrProbationStatus, {
    status: 'probation',
    quarantineUntil: '2026-03-28T00:00:00.000Z',
    demotionReasonCodes: ['benchmark_underperformance'],
  });
}

function buildPacket(input: {
  strategyVariantId: string;
  resolvedTrades: ResolvedTradeRecord[];
  regimeSnapshots?: Array<{
    regime: string;
    health: 'healthy' | 'watch' | 'degraded' | 'quarantine_candidate';
    realizedVsExpected?: number | null;
  }>;
}) {
  const trust = new LiveTrustScore().evaluate({
    strategyVariantId: input.strategyVariantId,
    regime: null,
    resolvedTrades: input.resolvedTrades,
  });
  return buildLivePromotionEvidencePacket({
    strategyVariantId: input.strategyVariantId,
    evidenceWindowStart: '2026-03-20T00:00:00.000Z',
    evidenceWindowEnd: '2026-03-27T00:00:00.000Z',
    resolvedTrades: input.resolvedTrades,
    liveTrustScoreSummary: {
      trustScore: trust.trustScore,
      sampleCount: trust.sampleCount,
      componentBreakdown: trust.componentBreakdown,
      reasonCodes: trust.reasonCodes,
    },
    regimeSnapshots: input.regimeSnapshots,
    now: new Date('2026-03-27T00:00:00.000Z'),
  });
}

function buildResolvedTrades(input: {
  count: number;
  strategyVariantId: string;
  strategyVersion: string;
  regime: string;
  realizedNetEdgeBps: number;
  expectedNetEdgeBps: number;
  benchmarkState: 'outperforming' | 'neutral' | 'underperforming' | 'context_missing';
  lifecycleState:
    | 'economically_resolved'
    | 'economically_resolved_with_portfolio_truth';
  toxicityScoreAtDecision?: number;
}): ResolvedTradeRecord[] {
  return Array.from({ length: input.count }, (_, index) => {
    const realizedNetEdgeBps = input.realizedNetEdgeBps - index * 2;
    return {
      tradeId: `${input.strategyVariantId}:trade:${index + 1}`,
      orderId: `${input.strategyVariantId}:order:${index + 1}`,
      venueOrderId: `${input.strategyVariantId}:venue:${index + 1}`,
      marketId: 'market-btc',
      tokenId: 'token-up',
      strategyVariantId: input.strategyVariantId,
      strategyVersion: input.strategyVersion,
      regime: input.regime,
      archetype: 'trend_follow_through',
      decisionTimestamp: new Date(Date.UTC(2026, 2, 20, 0, index)).toISOString(),
      submissionTimestamp: new Date(Date.UTC(2026, 2, 20, 0, index, 1)).toISOString(),
      firstFillTimestamp: new Date(Date.UTC(2026, 2, 20, 0, index, 2)).toISOString(),
      finalizedTimestamp: new Date(Date.UTC(2026, 2, 20, 0, index, 10)).toISOString(),
      side: 'BUY',
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
      expectedNetEdgeBps: input.expectedNetEdgeBps,
      realizedNetEdgeBps,
      maxFavorableExcursionBps: 105,
      maxAdverseExcursionBps: -22,
      toxicityScoreAtDecision: input.toxicityScoreAtDecision ?? 0.18,
      benchmarkContext: {
        benchmarkComparisonState: input.benchmarkState,
        baselinePenaltyMultiplier: input.benchmarkState === 'outperforming' ? 1 : 0.75,
        regimeBenchmarkGateState: input.benchmarkState === 'outperforming' ? 'passed' : 'blocked',
        underperformedBenchmarkIds:
          input.benchmarkState === 'underperforming' ? ['btc_follow_baseline'] : [],
        outperformedBenchmarkIds:
          input.benchmarkState === 'outperforming' ? ['btc_follow_baseline'] : [],
        reasonCodes: ['fixture'],
      },
      lossAttributionCategory:
        (input.toxicityScoreAtDecision ?? 0) >= 0.75 ? 'toxicity_damage' : 'mixed',
      executionAttributionCategory:
        (input.toxicityScoreAtDecision ?? 0) >= 0.75
          ? 'adverse_selection_spike'
          : 'queue_decay',
      lifecycleState: input.lifecycleState,
      attribution: {
        benchmarkContext: {
          benchmarkComparisonState: input.benchmarkState,
          baselinePenaltyMultiplier: input.benchmarkState === 'outperforming' ? 1 : 0.75,
          regimeBenchmarkGateState:
            input.benchmarkState === 'outperforming' ? 'passed' : 'blocked',
          underperformedBenchmarkIds:
            input.benchmarkState === 'underperforming' ? ['btc_follow_baseline'] : [],
          outperformedBenchmarkIds:
            input.benchmarkState === 'outperforming' ? ['btc_follow_baseline'] : [],
          reasonCodes: ['fixture'],
        },
        lossAttributionCategory:
          (input.toxicityScoreAtDecision ?? 0) >= 0.75 ? 'toxicity_damage' : 'mixed',
        executionAttributionCategory:
          (input.toxicityScoreAtDecision ?? 0) >= 0.75
            ? 'adverse_selection_spike'
            : 'queue_decay',
        primaryLeakageDriver: 'queue_delay',
        secondaryLeakageDrivers: ['slippage'],
        reasonCodes: ['fixture'],
      },
      executionQuality: {
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
      netOutcome: {
        expectedNetEdgeBps: input.expectedNetEdgeBps,
        realizedNetEdgeBps,
        maxFavorableExcursionBps: 105,
        maxAdverseExcursionBps: -22,
        realizedPnl: realizedNetEdgeBps / 100,
      },
      capturedAt: new Date(Date.UTC(2026, 2, 20, 0, index, 10)).toISOString(),
    };
  });
}

export const phaseSixPromotionGovernanceTests = [
  {
    name: 'phase6 live promotion gate requires all mandatory live criteria',
    fn: testLivePromotionGateRequiresAllMandatoryLiveCriteria,
  },
  {
    name: 'phase6 live demotion gate escalates on poor live truth',
    fn: testLiveDemotionGateEscalatesOnPoorLiveTruth,
  },
  {
    name: 'phase6 rollout controller refuses rollout tier skips',
    fn: testRolloutControllerRefusesTierSkips,
  },
  {
    name: 'phase6 print promotion decision shows live evidence packet and status',
    fn: testPrintPromotionDecisionShowsLiveEvidencePacketAndStatus,
  },
];
