import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { generateKeyPairSync } from 'crypto';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { BuildSignalsJob } from '../jobs/buildSignals.job';
import { ExecuteOrdersJob } from '../jobs/executeOrders.job';
import { ManageOpenOrdersJob } from '../jobs/manageOpenOrders.job';
import { ReconcileFillsJob } from '../jobs/reconcileFills.job';
import { CapitalLeakReviewJob } from '../jobs/capitalLeakReview.job';
import { EvaluateTradeOpportunitiesJob } from '../jobs/evaluateTradeOpportunities.job';
import { MarketAnalysisAgent } from '../agents/market-analysis.agent';
import { RiskVerificationAgent } from '../agents/risk-verification.agent';
import { ExecutionPortfolioAgent } from '../agents/execution-portfolio.agent';
import { BotStateStore } from '../runtime/bot-state';
import { RuntimeControlRepository } from '../runtime/runtime-control.repository';
import { StartStopManager } from '../runtime/start-stop-manager';
import { StartupGateService } from '../runtime/startup-gate.service';
import {
  normalizePersistedRuntimeState,
  permissionsForRuntimeState,
} from '../runtime/runtime-state-machine';
import {
  UserStreamTradeProjection,
  UserWebSocketStateService,
} from '../runtime/user-websocket-state.service';
import { VenueOpenOrderHeartbeatService } from '../runtime/venue-open-order-heartbeat.service';
import {
  ExternalPortfolioService,
  ExternalPortfolioSnapshot,
} from '../portfolio/external-portfolio.service';
import { CancelReplacePolicy } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { DuplicateExposureGuard } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { AdaptiveMakerTakerPolicy } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { buildExecutionLearningContextKey } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { EntryTimingEfficiencyScorer } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { ExecutionCostCalibrator } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { ExecutionSemanticsPolicy } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { ExecutionLearningStore } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { ExecutionPolicyUpdater } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { ExecutionPolicyVersionStore } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { FeeAccountingService } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { FillStateService } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { MakerQualityPolicy } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { NegativeRiskPolicy } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { OrderIntentService } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { RealizedCostModel } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { SizeVsLiquidityPolicy } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { VenueOrderValidator } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { VenueFeeModel } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { ServerSigner, SignerHealth } from '@polymarket-btc-5m-agentic-bot/signing-engine';
import { InventoryLiquidationPolicy } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { PreTradeFundingValidator } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { CapitalRampPolicyService } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { CapitalLeakAttribution } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { DeploymentTierPolicyService } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { ExecutionQualityKillSwitches } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { LossAttributionModel } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { MarginalEdgeCooldownPolicy } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { MaxLossPerOpportunityPolicy } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { MultiDimensionalPositionLimits } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { OpportunitySaturationDetector } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { ProductionReadinessDashboardService } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { RegimeCapitalPolicy } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { RegimeDisablePolicy } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { RegimeProfitabilityRanker } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { SafetyStateMachine } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { SizePenaltyEngine } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { TradeFrequencyGovernor } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { TradeAttributionService } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { TradeQualityHistoryStore } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { UncertaintyWeightedSizing } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { VenueOperationalPolicyService } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { TradeIntentResolver } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import {
  OfficialPolymarketTradingClient,
  VenueOpenOrder,
  VenueTradeRecord,
} from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';
import { PolymarketVenueAwareness } from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';
import {
  VenueParseError,
  parseBalanceAllowancePayload,
  parseGammaMarket,
  parseOpenOrdersPayload,
  parseOrderbookPayload,
  parseTradesPayload,
} from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';
import { BtcFiveMinuteTradeableUniverse } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { EdgeDefinitionService } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { EdgeHalfLifePolicy } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { EventMicrostructureModel } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { ExecutableEvModel } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { FeatureBuilder } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { MarketEligibilityService } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { MultiObjectivePromotionScore } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { NetEdgeEstimator } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { NetEdgeThresholdPolicy } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { NoTradeZonePolicy } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { PriorModel } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { PosteriorUpdate } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { RegimeClassifier } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { RegimeConditionedEdgeModel } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { ResearchGovernancePolicy } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { RobustnessSuite } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { TradeAdmissionGate } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { WalkForwardValidator } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { parsePolymarketSmokeEnv } from '../smoke/polymarket-auth-smoke';
import {
  createForcedDisconnectWebSocketFactory,
  probeCombinedStreamFreshness,
  probeMarketStreamReadiness,
  probeReconnectRecovery,
  probeStreamReconciliation,
  probeUserStreamLifecycleVisibility,
  probeUserStreamReadiness,
  runProductionReadiness,
} from '../smoke/production-readiness';
import {
  buildEmpiricalWalkForwardSamples,
  evaluateExecutableEdgeOnHistoricalCases,
  evaluateRegimeHoldouts,
  loadHistoricalValidationDataset,
  runP23Validation,
} from '../validation/p23-validation';
import {
  type LifecycleValidationSuiteResult,
  runLiveOrderLifecycleScenario,
  runLiveOrderLifecycleValidationSuite,
} from '../validation/live-order-lifecycle-validation';
import { buildDatasetQualityReport } from '../validation/dataset-quality';
import {
  loadWorkerEnvironment,
  resolveSecrets,
} from '../config/secret-provider';
import { MarketWebSocketStateService } from '@polymarket-btc-5m-agentic-bot/market-data';
import { buildCapitalExposureValidationReport } from '../runtime/capital-exposure-validation';
import { ChaosHarness } from '../runtime/chaos-harness';
import { evaluateReadinessObserver } from '../runtime/readiness-observer';
import { ReplayEngine } from '../runtime/replay-engine';
import { DailyReviewJob } from '../jobs/dailyReview.job';
import { LearningEventLog } from '../runtime/learning-event-log';
import { LearningStateStore } from '../runtime/learning-state-store';
import { ResolvedTradeLedger } from '../runtime/resolved-trade-ledger';
import { StrategyDeploymentRegistry } from '../runtime/strategy-deployment-registry';
import {
  buildStrategyVariantId,
  createDefaultLearningState,
  createDefaultExecutionLearningState,
  createDefaultStrategyVariantState,
  createDefaultStrategyDeploymentRegistryState,
  type ResolvedTradeRecord,
  type TradeQualityLabel,
  type TradeQualityScore,
} from '@polymarket-btc-5m-agentic-bot/domain';
import {
  buildBalanceAllowancePayloadFixture,
  buildGammaMarketFixture,
  buildOpenOrderPayloadFixture,
  buildOrderbookPayloadFixture,
  buildTradePayloadFixture,
} from '../fixtures/polymarket-venue-fixtures';
import { WebSocketServer, WebSocket } from 'ws';
import { ConfidenceShrinkagePolicy } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { waveFiveChampionChallengerIntegrationTests } from './champion-challenger.integration.test';
import { waveFiveExecutionLearningIntegrationTests } from './execution-learning.integration.test';
import { waveFiveLearningCycleIntegrationTests } from './learning-cycle.integration.test';
import { waveFiveQuarantineIntegrationTests } from './quarantine-policy.integration.test';
import { waveFiveVersionLineageIntegrationTests } from './version-lineage.integration.test';
import { phaseOneAlphaAttributionTests } from './alpha-attribution.integration.test';
import { phaseOneResolvedTradeLedgerTests } from './resolved-trade-ledger.integration.test';
import { phaseTwoNetEdgeTruthPathTests } from './net-edge-truth-path.integration.test';
import { phaseTenNetEdgeRealismTests } from './net-edge-realism.integration.test';
import { phaseThreeFillRealismTests } from './fill-realism.integration.test';
import { phaseTenFillRealismFeedbackTests } from './fill-realism-feedback.integration.test';
import { phaseTwoFeatureEnrichmentTests } from './phase2-feature-enrichment.integration.test';
import { phaseThreeToxicityTests } from './phase3-toxicity.integration.test';
import { phaseFourNoTradeAuthorityTests } from './no-trade-classifier.integration.test';
import { phaseFourLiveSizingFeedbackTests } from './phase4-live-sizing-feedback.integration.test';
import { phaseFiveBaselineBenchmarkingTests } from './phase5-baseline-benchmarking.integration.test';
import { phaseFiveEvidenceWeightedSizingTests } from './evidence-weighted-sizing.integration.test';
import { phaseTenEvidenceQualitySizingTests } from './evidence-quality-sizing.integration.test';
import { phaseSixPromotionGovernanceTests } from './live-promotion-governance.integration.test';
import { phaseTenLivePromotionGateTests } from './live-promotion-gate.integration.test';
import { phaseSixLiveProofTests } from './phase6-live-proof.integration.test';
import { phaseSevenLivePathWiringTests } from './phase7-live-path-wiring.integration.test';
import { phaseSevenExecutionStateHardeningTests } from './execution-state-hardening.integration.test';
import { phaseTenExecutionWatchdogTests } from './execution-watchdog.integration.test';
import { phaseEightDailyDecisionQualityTests } from './daily-decision-quality.integration.test';
import { phaseNineReadinessEnforcementTests } from './phase9-readiness-enforcement.integration.test';
import { phaseElevenLearningStateTypeTests } from './phase11-learning-state-types.integration.test';
import { phaseElevenLearningEventLogTests } from './phase11-learning-event-log.integration.test';
import { phaseElevenLearningCycleJobTests } from './phase11-learning-cycle-job.integration.test';
import { phaseElevenLearningCycleRunnerTests } from './phase11-learning-cycle-runner.integration.test';
import { itemOneLossAttributionClassifierTests } from './loss-attribution-classifier.integration.test';
import { itemTwoRetentionContextTests } from './retention-context-report.integration.test';
import { itemTwelveCalibrationDriftAlertTests } from './calibration-drift-alerts.integration.test';
import { itemSixRegimeLocalSizingTests } from './regime-local-sizing.integration.test';
import { itemSevenBenchmarkRelativeSizingTests } from './benchmark-relative-sizing.integration.test';
import { itemEightRollingBenchmarkScorecardTests } from './rolling-benchmark-scorecard.integration.test';
import { waveTwelveAntiOvertradingIntegrationTests } from './anti-overtrading.integration.test';
import { waveTwelveCapitalLeakAttributionIntegrationTests } from './capital-leak-attribution.integration.test';
import { waveTwelveNetEdgeGatingIntegrationTests } from './net-edge-gating.integration.test';
import { waveTwelveRegimeProfitabilityIntegrationTests } from './regime-profitability.integration.test';
import { waveTwelveUncertaintySizingIntegrationTests } from './uncertainty-sizing.integration.test';

const repoRoot = path.resolve(__dirname, '../../../..');

function createRuntimeConfig() {
  return {
    maxOpenPositions: 1,
    maxDailyLossPct: 5,
    maxPerTradeRiskPct: 1,
    maxKellyFraction: 0.05,
    maxConsecutiveLosses: 2,
    noTradeWindowSeconds: 30,
    evaluationIntervalMs: 1000,
    orderReconcileIntervalMs: 2000,
    portfolioRefreshIntervalMs: 5000,
  };
}

function createLifecycleValidationSuite(
  input?: Partial<LifecycleValidationSuiteResult>,
): LifecycleValidationSuiteResult {
  const executedAt = new Date().toISOString();

  return {
    success: true,
    executedAt,
    validationMode: 'venue_runtime',
    scenarioCoverage: ['duplicate_or_delayed_fill_events'],
    scenarios: [
      {
        scenario: 'duplicate_or_delayed_fill_events',
        validationMode: 'venue_runtime',
        passed: true,
        intentId: 'intent-test',
        submitAttempts: [],
        botBelief: [],
        venueTruth: [],
        restTruth: [],
        streamEvents: [],
        reconciliation: [],
        finalTruth: {},
        noDuplicateExposure: true,
        runtimeSafetyStayedFailClosed: true,
        ambiguityDetected: false,
        ambiguityReasonCodes: [],
        timing: {
          startedAt: executedAt,
          completedAt: executedAt,
          durationMs: 0,
          botSnapshotCount: 0,
          restSnapshotCount: 0,
          reconciliationStepCount: 0,
          streamEventCount: 0,
        },
        assertions: [],
      },
    ],
    soak: {
      enabled: false,
      iterations: 1,
      passedIterations: 1,
      failedIterations: 0,
      averageDurationMs: 0,
      maxDurationMs: 0,
      results: [],
    },
    evidencePath: path.join(repoRoot, 'artifacts/test-lifecycle.json'),
    ...input,
  };
}

function createExecutionSignal(input?: Partial<Record<string, unknown>>) {
  return {
    id: 's1',
    marketId: 'm1',
    side: 'BUY',
    tokenId: 'yes1',
    outcome: 'YES',
    action: 'ENTER',
    intent: 'ENTER',
    regime: 'momentum_continuation',
    expectedEv: 0.1,
    edge: 0.03,
    posteriorProbability: 0.62,
    marketImpliedProb: 0.5,
    strategyVersionId: 'strategy-live-1',
    observedAt: new Date(),
    ...input,
  };
}

function createMarket() {
  return {
    id: 'm1',
    slug: 'btc-5m-higher',
    title: 'Will BTC be higher in 5 minutes?',
    tokenIdYes: 'yes1',
    tokenIdNo: 'no1',
    expiresAt: new Date(Date.now() + 120_000),
  };
}

function createFreshOrderbook(input?: Partial<Record<string, unknown>>) {
  return {
    bestBid: 0.5,
    bestAsk: 0.52,
    bidLevels: [{ price: 0.5, size: 100 }],
    askLevels: [{ price: 0.52, size: 100 }],
    tickSize: 0.01,
    minOrderSize: 1,
    negRisk: false,
    observedAt: new Date(),
    ...input,
  };
}

function createFreshSnapshot() {
  return {
    observedAt: new Date(),
    expiresAt: new Date(Date.now() + 120_000),
    volume: 750,
  };
}

function createFreshPortfolioSnapshot() {
  return {
    capturedAt: new Date(),
  };
}

function createFreshReconciliationCheckpoint(source: string) {
  return {
    source,
    status: 'completed',
    processedAt: new Date(),
    details: {
      snapshot: {
        tradingPermissions: {
          allowNewEntries: true,
        },
      },
    },
  };
}

function createTradeQualityScoreFixture(
  input?: Partial<Record<string, unknown>> & { label?: string; overallScore?: number },
): TradeQualityScore {
  const overallScore = input?.overallScore ?? 0.5;
  const label: TradeQualityLabel =
    input?.label === 'excellent' ||
    input?.label === 'good' ||
    input?.label === 'mixed' ||
    input?.label === 'poor' ||
    input?.label === 'destructive'
      ? input.label
      : 'mixed';
  return {
    tradeId: String(input?.tradeId ?? 'trade-fixture'),
    orderId: String(input?.orderId ?? 'order-fixture'),
    signalId: String(input?.signalId ?? 'signal-fixture'),
    marketId: String(input?.marketId ?? 'm1'),
    strategyVariantId: String(input?.strategyVariantId ?? 'variant:strategy-live-1'),
    regime: String(input?.regime ?? 'momentum_continuation'),
    marketContext: String(input?.marketContext ?? 'btc-5m-higher:YES'),
    executionStyle: String(input?.executionStyle ?? 'hybrid'),
    evaluatedAt: String(input?.evaluatedAt ?? '2026-03-24T00:00:00.000Z'),
    label,
    breakdown: {
      forecastQuality: {
        score: overallScore,
        label,
        reasons: [],
        evidence: {},
      },
      calibrationQuality: {
        score: overallScore,
        label,
        reasons: [],
        evidence: {},
      },
      executionQuality: {
        score: overallScore,
        label,
        reasons: [],
        evidence: {},
      },
      timingQuality: {
        score: overallScore,
        label,
        reasons: [],
        evidence: {},
      },
      policyCompliance: {
        score: overallScore,
        label,
        reasons: [],
        evidence: {},
      },
      realizedOutcomeQuality: {
        score: overallScore,
        label,
        reasons: [],
        evidence: {
          realizedEv: overallScore - 0.5,
        },
      },
      overallScore,
      reasons: [],
    },
  };
}

function createExternalPortfolioSnapshot(
  input?: Partial<ExternalPortfolioSnapshot>,
): ExternalPortfolioSnapshot {
  const inventory = createExternalInventorySnapshot();

  return {
    source: 'polymarket_authenticated_external_truth',
    snapshotId: 'ps-1',
    capturedAt: new Date().toISOString(),
    freshnessState: 'fresh',
    freshnessVerdict: 'healthy',
    reconciliationHealth: 'healthy',
    tradingPermissions: {
      allowNewEntries: true,
      allowPositionManagement: true,
      reasonCodes: [],
    },
    cashBalance: 100,
    cashAllowance: 100,
    reservedCash: 0,
    freeCashBeforeAllowance: 100,
    freeCashAfterAllowance: 100,
    tradableBuyHeadroom: 100,
    availableCapital: 100,
    bankroll: 100,
    openExposure: 0,
    openOrderExposure: 0,
    realizedFees: 0,
    workingOpenOrders: 0,
    cash: {
      grossBalance: 100,
      grossAllowance: 100,
      reservedForBuys: 0,
      freeCashBeforeAllowance: 100,
      freeCashAfterAllowance: 100,
      tradableBuyHeadroom: 100,
    },
    positions: {
      current: [
        {
          tokenId: 'yes1',
          marketId: 'm1',
          conditionId: null,
          size: 10,
          avgPrice: 0.5,
          initialValue: 5,
          currentValue: 5.1,
          cashPnl: 0.1,
          realizedPnl: 0,
          currentPrice: 0.51,
          outcome: 'YES',
          oppositeTokenId: 'no1',
          endDate: null,
          negativeRisk: false,
          raw: {},
        },
      ],
      closed: [],
      totalCurrentValue: 5.1,
      realizedPnlFromClosedPositions: 0,
    },
    trades: {
      authenticated: [],
      dataApi: [],
    },
    openOrders: [],
    freshness: {
      overallVerdict: 'healthy',
      confidence: 'high',
      allowNewEntries: true,
      allowPositionManagement: true,
      components: {
        balances: {
          component: 'balances',
          fetchedAt: new Date().toISOString(),
          sourceTimestamp: null,
          ageMs: 0,
          verdict: 'healthy',
          confidence: 'high',
          maxHealthyAgeMs: 15000,
          maxWarningAgeMs: 15000,
          maxDegradedAgeMs: 30000,
        },
        allowances: {
          component: 'allowances',
          fetchedAt: new Date().toISOString(),
          sourceTimestamp: null,
          ageMs: 0,
          verdict: 'healthy',
          confidence: 'high',
          maxHealthyAgeMs: 15000,
          maxWarningAgeMs: 15000,
          maxDegradedAgeMs: 30000,
        },
        openOrders: {
          component: 'openOrders',
          fetchedAt: new Date().toISOString(),
          sourceTimestamp: null,
          ageMs: 0,
          verdict: 'healthy',
          confidence: 'high',
          maxHealthyAgeMs: 10000,
          maxWarningAgeMs: 10000,
          maxDegradedAgeMs: 20000,
        },
        clobTrades: {
          component: 'clobTrades',
          fetchedAt: new Date().toISOString(),
          sourceTimestamp: null,
          ageMs: 0,
          verdict: 'healthy',
          confidence: 'high',
          maxHealthyAgeMs: 20000,
          maxWarningAgeMs: 20000,
          maxDegradedAgeMs: 40000,
        },
        dataApiTrades: {
          component: 'dataApiTrades',
          fetchedAt: new Date().toISOString(),
          sourceTimestamp: null,
          ageMs: 0,
          verdict: 'healthy',
          confidence: 'high',
          maxHealthyAgeMs: 30000,
          maxWarningAgeMs: 30000,
          maxDegradedAgeMs: 60000,
        },
        currentPositions: {
          component: 'currentPositions',
          fetchedAt: new Date().toISOString(),
          sourceTimestamp: null,
          ageMs: 0,
          verdict: 'healthy',
          confidence: 'high',
          maxHealthyAgeMs: 30000,
          maxWarningAgeMs: 30000,
          maxDegradedAgeMs: 60000,
        },
        closedPositions: {
          component: 'closedPositions',
          fetchedAt: new Date().toISOString(),
          sourceTimestamp: null,
          ageMs: 0,
          verdict: 'healthy',
          confidence: 'high',
          maxHealthyAgeMs: 300000,
          maxWarningAgeMs: 300000,
          maxDegradedAgeMs: 600000,
        },
      },
    },
    divergence: {
      status: 'none',
      classes: [],
      details: [],
    },
    recovery: {
      mode: 'none',
      entriesBlocked: false,
      positionManagementBlocked: false,
      reasonCodes: [],
    },
    inventories: [inventory],
    ...input,
  };
}

function createHealthyBtcReference() {
  const candles: Array<{
    timestamp: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }> = [];
  let price = 100;

  for (let index = 0; index < 32; index += 1) {
    const open = price;
    const drift = 0.75 + index * 0.03;
    const close = open + drift;
    candles.push({
      timestamp: new Date(Date.now() - (32 - index) * 5 * 60_000).toISOString(),
      open,
      high: close + 0.18,
      low: open - 0.08,
      close,
      volume: 80 + index * 3,
    });
    price = close;
  }

  return {
    symbol: 'BTCUSD',
    spotPrice: candles[candles.length - 1]?.close ?? 100_000,
    candles,
    observedAt: new Date().toISOString(),
  };
}

function createExternalInventorySnapshot(
  input?: Partial<ExternalPortfolioSnapshot['inventories'][number]>,
) {
  return {
    tokenId: 'yes1',
    marketId: 'm1',
    outcome: 'YES' as const,
    balance: 10,
    allowance: 10,
    reservedQuantity: 0,
    freeQuantityBeforeAllowance: 10,
    freeQuantityAfterAllowance: 10,
    tradableSellHeadroom: 10,
    availableQuantity: 10,
    positionQuantity: 10,
    markPrice: 0.51,
    markedValue: 5.1,
    ...input,
  };
}

function createFreshRuntimeStatus() {
  return {
    id: 'live',
    lastHeartbeatAt: new Date(),
  };
}

function stubExternalPortfolioService(
  job: unknown,
  snapshot = createExternalPortfolioSnapshot(),
) {
  (job as any).externalPortfolioService = {
    capture: async () => snapshot,
  };
  (job as any).accountStateService = {
    capture: async () => ({
      deployableRiskNow: snapshot.availableCapital,
    }),
  };
  (job as any).marketEligibility = {
    evaluate: () => ({
      eligible: true,
      reasonCode: 'passed',
      reasonMessage: null,
    }),
  };
  (job as any).orderIntentRepository = {
    loadLatest: async () => null,
    record: async () => null,
  };
}

async function testExecutionVetoBlocksSubmit(): Promise<void> {
  let orderCreateCalls = 0;

  const prisma = {
    signal: {
      findMany: async () => [createExecutionSignal()],
      findFirst: async () => null,
      update: async () => null,
    },
    signalDecision: {
      findFirst: async () => ({ positionSize: 5, verdict: 'approved' }),
      create: async () => null,
    },
    market: {
      findUnique: async () => createMarket(),
    },
    orderbook: {
      findFirst: async () => createFreshOrderbook({ spread: 0.02 }),
    },
    marketSnapshot: {
      findFirst: async () => createFreshSnapshot(),
    },
    order: {
      findFirst: async () => null,
      create: async () => {
        orderCreateCalls += 1;
      },
    },
    auditEvent: {
      create: async () => null,
    },
    portfolioSnapshot: {
      findFirst: async () => createFreshPortfolioSnapshot(),
    },
    reconciliationCheckpoint: {
      findFirst: async ({ where }: { where: { source: string } }) =>
        createFreshReconciliationCheckpoint(where.source),
    },
    botRuntimeStatus: {
      findUnique: async () => createFreshRuntimeStatus(),
    },
    liveConfig: {
      findUnique: async () => ({ id: 'live', noTradeWindowSeconds: 30 }),
    },
  };

  const job = new ExecuteOrdersJob(prisma as never);
  stubExternalPortfolioService(
    job,
    createExternalPortfolioSnapshot({
      inventories: [
        createExternalInventorySnapshot({
          tokenId: 'yes1',
          marketId: 'm1',
          outcome: 'YES',
          balance: 25,
          allowance: 25,
          reservedQuantity: 0,
          freeQuantityBeforeAllowance: 25,
          freeQuantityAfterAllowance: 25,
          tradableSellHeadroom: 25,
          availableQuantity: 25,
          positionQuantity: 25,
          markPrice: 0.51,
          markedValue: 12.75,
        }),
      ],
    }),
  );
  const result = await job.run({ canSubmit: () => false });

  assert.strictEqual(result.submitted, 0);
  assert.strictEqual(result.rejected, 0);
  assert.strictEqual(orderCreateCalls, 0);
}

async function testExecutionRejectsSignalWithoutStrategyVersion(): Promise<void> {
  let orderCreateCalls = 0;
  let rejectionReason: string | null = null;

  const prisma = {
    signal: {
      findMany: async () => [
        createExecutionSignal({
          strategyVersionId: null,
        }),
      ],
      update: async () => null,
    },
    signalDecision: {
      findFirst: async () => ({ positionSize: 100, verdict: 'approved' }),
      create: async ({ data }: { data: { reasonCode: string } }) => {
        rejectionReason = data.reasonCode;
      },
    },
    order: {
      findFirst: async () => null,
      create: async () => {
        orderCreateCalls += 1;
      },
    },
    liveConfig: {
      findUnique: async () => ({ id: 'live', noTradeWindowSeconds: 30 }),
    },
    market: {
      findUnique: async () => createMarket(),
    },
    orderbook: {
      findFirst: async () => createFreshOrderbook({ spread: 0.02 }),
    },
    marketSnapshot: {
      findFirst: async () => createFreshSnapshot(),
    },
    auditEvent: {
      create: async () => null,
    },
    portfolioSnapshot: {
      findFirst: async () => createFreshPortfolioSnapshot(),
    },
    reconciliationCheckpoint: {
      findFirst: async ({ where }: { where: { source: string } }) =>
        createFreshReconciliationCheckpoint(where.source),
    },
    botRuntimeStatus: {
      findUnique: async () => createFreshRuntimeStatus(),
    },
  };

  const job = new ExecuteOrdersJob(prisma as never);
  stubExternalPortfolioService(
    job,
    createExternalPortfolioSnapshot({
      inventories: [
        createExternalInventorySnapshot({
          tokenId: 'no1',
          marketId: 'm1',
          outcome: 'NO',
          balance: 25,
          allowance: 25,
          reservedQuantity: 0,
          freeQuantityBeforeAllowance: 25,
          freeQuantityAfterAllowance: 25,
          tradableSellHeadroom: 25,
          availableQuantity: 25,
          positionQuantity: 25,
          markPrice: 0.49,
          markedValue: 12.25,
        }),
      ],
    }),
  );
  (job as any).tradingClient = {
    postOrder: async () => ({
      success: true,
      orderId: 'venue-o1',
      status: 'acknowledged',
    }),
  };
  const result = await job.run({ canSubmit: () => true });

  assert.strictEqual(result.submitted, 0);
  assert.strictEqual(result.rejected, 1);
  assert.strictEqual(orderCreateCalls, 0);
  assert.strictEqual(rejectionReason, 'strategy_version_missing');
}

async function testBuildSignalsRequiresActiveStrategy(): Promise<void> {
  let signalCreateCalls = 0;

  const prisma = {
    strategyVersion: {
      findFirst: async () => null,
    },
    market: {
      findMany: async () => [],
    },
    signal: {
      create: async () => {
        signalCreateCalls += 1;
      },
    },
  };

  const job = new BuildSignalsJob(prisma as never);
  const result = await job.run(createHealthyBtcReference());

  assert.strictEqual(result.created, 0);
  assert.strictEqual(signalCreateCalls, 0);
}

async function testBuildSignalsPersistsActiveStrategyVersion(): Promise<void> {
  let createdStrategyVersionId: string | null = null;

  const prisma = {
    strategyVersion: {
      findFirst: async () => ({ id: 'strategy-live-1' }),
    },
    market: {
      findMany: async () => [
        {
          id: 'm1',
          slug: 'btc-5m-higher',
          title: 'Will BTC be higher in 5 minutes?',
          status: 'active',
          tokenIdYes: 'yes1',
          tokenIdNo: 'no1',
          expiresAt: new Date(Date.now() + 120_000),
          updatedAt: new Date(),
        },
      ],
    },
    orderbook: {
      findFirst: async () => ({
        bidLevels: [{ price: 0.48, size: 120 }],
        askLevels: [{ price: 0.49, size: 120 }],
        bestBid: 0.48,
        bestAsk: 0.49,
        spread: 0.01,
        tickSize: 0.01,
        minOrderSize: 1,
        negRisk: false,
        observedAt: new Date(),
      }),
    },
    marketSnapshot: {
      findFirst: async () => createFreshSnapshot(),
    },
    signal: {
      findFirst: async () => null,
      create: async ({ data }: { data: { strategyVersionId: string } }) => {
        createdStrategyVersionId = data.strategyVersionId;
      },
    },
  };

  const job = new BuildSignalsJob(prisma as never);
  const result = await job.run(createHealthyBtcReference());

  assert.strictEqual(result.created >= 0, true);
  assert.strictEqual(createdStrategyVersionId, 'strategy-live-1');
}

async function testBuildSignalsUsesDeploymentRegistryAssignment(): Promise<void> {
  let createdStrategyVersionId: string | null = null;
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strategy-build-assignment-'));
  const registry = new StrategyDeploymentRegistry(rootDir);
  const state = createDefaultStrategyDeploymentRegistryState(
    new Date('2026-03-24T00:00:00.000Z'),
  );
  state.incumbentVariantId = 'variant:strategy-challenger-2';
  state.variants['variant:strategy-live-1'] = {
    variantId: 'variant:strategy-live-1',
    strategyVersionId: 'strategy-live-1',
    status: 'shadow',
    evaluationMode: 'shadow_only',
    rolloutStage: 'shadow_only',
    health: 'healthy',
    lineage: {
      variantId: 'variant:strategy-live-1',
      strategyVersionId: 'strategy-live-1',
      parentVariantId: null,
      createdAt: '2026-03-20T00:00:00.000Z',
      createdReason: 'test',
    },
    capitalAllocationPct: 0,
    lastShadowEvaluatedAt: null,
    createdAt: '2026-03-20T00:00:00.000Z',
    updatedAt: '2026-03-20T00:00:00.000Z',
  };
  state.variants['variant:strategy-challenger-2'] = {
    variantId: 'variant:strategy-challenger-2',
    strategyVersionId: 'strategy-challenger-2',
    status: 'incumbent',
    evaluationMode: 'full',
    rolloutStage: 'full',
    health: 'healthy',
    lineage: {
      variantId: 'variant:strategy-challenger-2',
      strategyVersionId: 'strategy-challenger-2',
      parentVariantId: 'variant:strategy-live-1',
      createdAt: '2026-03-20T00:00:00.000Z',
      createdReason: 'test',
    },
    capitalAllocationPct: 1,
    lastShadowEvaluatedAt: null,
    createdAt: '2026-03-20T00:00:00.000Z',
    updatedAt: '2026-03-20T00:00:00.000Z',
  };
  state.activeRollout = {
    incumbentVariantId: 'variant:strategy-live-1',
    challengerVariantId: 'variant:strategy-challenger-2',
    stage: 'full',
    challengerAllocationPct: 1,
    rolloutSalt: 'salt',
    appliedReason: 'test',
    appliedAt: '2026-03-24T00:00:00.000Z',
  };
  await registry.save(state);

  const prisma = {
    strategyVersion: {
      findMany: async () => [
        {
          id: 'strategy-live-1',
          isActive: true,
          updatedAt: new Date('2026-03-24T00:00:00.000Z'),
        },
        {
          id: 'strategy-challenger-2',
          isActive: false,
          updatedAt: new Date('2026-03-24T00:01:00.000Z'),
        },
      ],
    },
    market: {
      findMany: async () => [
        {
          id: 'm1',
          slug: 'btc-5m-higher',
          title: 'Will BTC be higher in 5 minutes?',
          status: 'active',
          tokenIdYes: 'yes1',
          tokenIdNo: 'no1',
          expiresAt: new Date(Date.now() + 120_000),
          updatedAt: new Date(),
        },
      ],
    },
    orderbook: {
      findFirst: async () => ({
        bidLevels: [{ price: 0.48, size: 120 }],
        askLevels: [{ price: 0.49, size: 120 }],
        bestBid: 0.48,
        bestAsk: 0.49,
        spread: 0.01,
        tickSize: 0.01,
        minOrderSize: 1,
        negRisk: false,
        observedAt: new Date(),
      }),
    },
    marketSnapshot: {
      findFirst: async () => createFreshSnapshot(),
    },
    signal: {
      findFirst: async () => null,
      create: async ({ data }: { data: { strategyVersionId: string } }) => {
        createdStrategyVersionId = data.strategyVersionId;
      },
    },
  };

  const job = new BuildSignalsJob(prisma as never, registry);
  const result = await job.run(createHealthyBtcReference());

  assert.strictEqual(result.created >= 0, true);
  assert.strictEqual(createdStrategyVersionId, 'strategy-challenger-2');
}

async function testBtcFiveMinuteUniverseAdmissionAndRejection(): Promise<void> {
  const universe = new BtcFiveMinuteTradeableUniverse();

  const admitted = universe.assessDiscovery({
    id: 'btc-1',
    slug: 'btc-5m-up-or-down',
    title: 'Bitcoin 5 minute market',
    question: 'Will BTC be higher in 5 minutes?',
    active: true,
    closed: false,
    tradable: true,
    tokenIdYes: 'yes1',
    tokenIdNo: 'no1',
    durationSeconds: 300,
    expiresAt: new Date(Date.now() + 180_000).toISOString(),
    negativeRisk: false,
  });

  const rejected = universe.assessDiscovery({
    id: 'eth-1',
    slug: 'btc-or-eth-5m',
    title: 'BTC vs ETH 5 minute market',
    question: 'Will ETH outperform BTC in 5 minutes?',
    active: true,
    closed: false,
    tradable: true,
    tokenIdYes: 'yes1',
    tokenIdNo: null,
    durationSeconds: 300,
    expiresAt: new Date(Date.now() + 180_000).toISOString(),
    negativeRisk: false,
  });

  assert.strictEqual(admitted.admitted, true);
  assert.strictEqual(rejected.admitted, false);
  assert.strictEqual(rejected.reasonCode, 'ambiguous_market_identity');
}

async function testRegimeClassificationAcrossRepresentativeScenarios(): Promise<void> {
  const classifier = new RegimeClassifier();

  const drift = classifier.classify({
    lastReturnPct: 0.0003,
    rollingReturnPct: 0.001,
    realizedVolatility: 0.0008,
    realizedRangePct: 0.001,
    spread: 0.01,
    spreadToDepthRatio: 0.0001,
    topLevelImbalance: 0.05,
    bidDepth: 140,
    askDepth: 135,
    combinedDepth: 275,
    topLevelDepth: 60,
    depthConcentration: 0.22,
    midpointPrice: 0.51,
    midpointDriftPct: 0.0004,
    micropriceBias: 0.03,
    volumeTrend: 0.2,
    orderbookNoiseScore: 0.1,
    flowImbalanceProxy: 0.18,
    flowIntensity: 0.22,
    bookUpdateStress: 0.16,
    btcMoveTransmission: 0.2,
    btcLinkageConfidence: 0.58,
    laggedBtcMoveTransmission: 0.24,
    nonlinearBtcMoveSensitivity: 0.41,
    btcPathDivergence: 0.12,
    transmissionConsistency: 0.72,
    imbalancePersistence: 0.74,
    imbalanceReversalProbability: 0.18,
    quoteInstabilityBeforeMove: 0.14,
    depthDepletionAsymmetry: 0.12,
    signalDecayPressure: 0.18,
    marketStateTransition: 'range_balance',
    marketStateTransitionStrength: 0.24,
    marketArchetype: 'balanced_rotation',
    marketArchetypeConfidence: 0.52,
    sampleCount: 32,
    timeToExpirySeconds: 180,
    capturedAt: new Date().toISOString(),
  });

  const spike = classifier.classify({
    lastReturnPct: -0.0042,
    rollingReturnPct: 0.001,
    realizedVolatility: 0.0021,
    realizedRangePct: 0.003,
    spread: 0.015,
    spreadToDepthRatio: 0.0002,
    topLevelImbalance: -0.08,
    bidDepth: 120,
    askDepth: 122,
    combinedDepth: 242,
    topLevelDepth: 52,
    depthConcentration: 0.21,
    midpointPrice: 0.5,
    midpointDriftPct: -0.0012,
    micropriceBias: -0.04,
    volumeTrend: 0.35,
    orderbookNoiseScore: 0.18,
    flowImbalanceProxy: -0.28,
    flowIntensity: 0.4,
    bookUpdateStress: 0.24,
    btcMoveTransmission: -0.22,
    btcLinkageConfidence: 0.54,
    laggedBtcMoveTransmission: -0.29,
    nonlinearBtcMoveSensitivity: 0.78,
    btcPathDivergence: 0.27,
    transmissionConsistency: 0.48,
    imbalancePersistence: 0.29,
    imbalanceReversalProbability: 0.68,
    quoteInstabilityBeforeMove: 0.36,
    depthDepletionAsymmetry: -0.11,
    signalDecayPressure: 0.28,
    marketStateTransition: 'mean_reversion',
    marketStateTransitionStrength: 0.46,
    marketArchetype: 'mean_reversion_trap',
    marketArchetypeConfidence: 0.61,
    sampleCount: 32,
    timeToExpirySeconds: 180,
    capturedAt: new Date().toISOString(),
  });

  const noisy = classifier.classify({
    lastReturnPct: 0.0004,
    rollingReturnPct: 0.0007,
    realizedVolatility: 0.0011,
    realizedRangePct: 0.0015,
    spread: 0.045,
    spreadToDepthRatio: 0.002,
    topLevelImbalance: 0.4,
    bidDepth: 8,
    askDepth: 7,
    combinedDepth: 15,
    topLevelDepth: 9,
    depthConcentration: 0.7,
    midpointPrice: 0.5,
    midpointDriftPct: 0.0001,
    micropriceBias: 0.1,
    volumeTrend: -0.4,
    orderbookNoiseScore: 0.9,
    flowImbalanceProxy: 0.06,
    flowIntensity: 0.35,
    bookUpdateStress: 0.94,
    btcMoveTransmission: 0.04,
    btcLinkageConfidence: 0.31,
    laggedBtcMoveTransmission: 0.02,
    nonlinearBtcMoveSensitivity: 0.63,
    btcPathDivergence: 0.88,
    transmissionConsistency: 0.14,
    imbalancePersistence: 0.19,
    imbalanceReversalProbability: 0.81,
    quoteInstabilityBeforeMove: 0.92,
    depthDepletionAsymmetry: 0.47,
    signalDecayPressure: 0.68,
    marketStateTransition: 'stress_transition',
    marketStateTransitionStrength: 0.74,
    marketArchetype: 'stressed_microstructure',
    marketArchetypeConfidence: 0.79,
    sampleCount: 20,
    timeToExpirySeconds: 180,
    capturedAt: new Date().toISOString(),
  });

  const nearResolution = classifier.classify({
    ...{
      lastReturnPct: 0.0008,
      rollingReturnPct: 0.0025,
      realizedVolatility: 0.0015,
      realizedRangePct: 0.002,
      spread: 0.014,
      spreadToDepthRatio: 0.0003,
      topLevelImbalance: 0.07,
      bidDepth: 100,
      askDepth: 102,
      combinedDepth: 202,
      topLevelDepth: 44,
      depthConcentration: 0.22,
      midpointPrice: 0.51,
      midpointDriftPct: 0.0006,
      micropriceBias: 0.02,
      volumeTrend: 0.1,
      orderbookNoiseScore: 0.12,
      flowImbalanceProxy: 0.14,
      flowIntensity: 0.2,
      bookUpdateStress: 0.2,
      btcMoveTransmission: 0.1,
      btcLinkageConfidence: 0.46,
      laggedBtcMoveTransmission: 0.07,
      nonlinearBtcMoveSensitivity: 0.52,
      btcPathDivergence: 0.33,
      transmissionConsistency: 0.39,
      imbalancePersistence: 0.31,
      imbalanceReversalProbability: 0.57,
      quoteInstabilityBeforeMove: 0.29,
      depthDepletionAsymmetry: -0.04,
      signalDecayPressure: 0.82,
      marketStateTransition: 'range_balance',
      marketStateTransitionStrength: 0.25,
      marketArchetype: 'expiry_pressure',
      marketArchetypeConfidence: 0.72,
      sampleCount: 26,
      capturedAt: new Date().toISOString(),
    },
    timeToExpirySeconds: 25,
  });

  assert.strictEqual(drift.label, 'low_volatility_drift');
  assert.strictEqual(spike.label, 'spike_and_revert');
  assert.strictEqual(noisy.label, 'illiquid_noisy_book');
  assert.strictEqual(noisy.tradingAllowed, false);
  assert.strictEqual(nearResolution.label, 'near_resolution_microstructure_chaos');
  assert.strictEqual(nearResolution.tradingAllowed, false);
}

async function testWalkForwardValidationPreventsLeakage(): Promise<void> {
  const validator = new WalkForwardValidator();
  const samples = Array.from({ length: 30 }, (_, index) => ({
    observedAt: new Date(Date.now() - (30 - index) * 60_000).toISOString(),
    expectedEdge: 0.015 + index * 0.0005,
    executableEv: 0.008 + index * 0.0002,
    regime: index % 2 === 0 ? 'momentum_continuation' : 'low_volatility_drift',
    realizedReturn: 0.006 + index * 0.0001,
    fillRate: 0.7,
  }));

  const result = validator.validate({
    samples,
    minimumSamples: 24,
    trainWindowSize: 12,
    testWindowSize: 6,
    stepSize: 6,
  });

  assert.strictEqual(result.sufficientSamples, true);
  assert.strictEqual(result.leakagePrevented, true);
  assert.strictEqual(result.windows.length > 0, true);
  assert.strictEqual(result.windows.every((window) => window.testStartIndex > window.trainEndIndex), true);
}

async function testExecutableEvDecompositionAndNegativeEvRejection(): Promise<void> {
  const featureBuilder = new FeatureBuilder();
  const priorModel = new PriorModel();
  const posteriorUpdate = new PosteriorUpdate();
  const regimeClassifier = new RegimeClassifier();
  const edgeModel = new RegimeConditionedEdgeModel();
  const executableEvModel = new ExecutableEvModel();
  const admissionGate = new TradeAdmissionGate();
  const btcReference = createHealthyBtcReference();
  const orderbook = createFreshOrderbook({
    bidLevels: [{ price: 0.47, size: 14 }],
    askLevels: [{ price: 0.53, size: 12 }],
    bestBid: 0.47,
    bestAsk: 0.53,
    spread: 0.06,
  });
  const features = featureBuilder.build({
    candles: {
      symbol: btcReference.symbol,
      timeframe: '5m',
      candles: btcReference.candles.slice(-12),
    },
    orderbook: orderbook as any,
    expiresAt: new Date(Date.now() + 180_000).toISOString(),
  });
  const regime = regimeClassifier.classify(features);
  const prior = priorModel.evaluate(features, regime);
  const posterior = posteriorUpdate.apply({
    priorProbability: prior.probabilityUp,
    features,
    regime,
  });
  const edge = edgeModel.evaluate({
    priorProbability: prior.probabilityUp,
    posteriorProbability: posterior.posteriorProbability,
    marketImpliedProbability: 0.5,
    features,
    regime,
  });
  const executableEv = executableEvModel.calculate({
    directionalEdge: Math.max(0.02, Math.abs(edge.edge)),
    rawDirectionalEdge: Math.max(0.02, Math.abs(edge.rawEdge)),
    marketImpliedProbability: 0.5,
    features,
    regime,
    feeRate: 0.01,
  });
  const gate = admissionGate.evaluate({
    edgeDefinitionVersion: 'btc-5m-polymarket-edge-v1',
    signalPresent: true,
    directionalEdge: Math.max(0.02, Math.abs(edge.edge)),
    executableEv: -0.001,
    signalConfidence: executableEv.confidence,
    walkForwardConfidence: 0.8,
    liquidityHealthy: true,
    freshnessHealthy: true,
    venueHealthy: true,
    reconciliationHealthy: true,
    riskHealthy: true,
    regimeAllowed: true,
    executableEdge: {
      edgeDefinitionVersion: 'btc-5m-polymarket-edge-v1',
      executionStyle: 'hybrid',
      rawModelEdge: Math.max(0.02, Math.abs(edge.rawEdge)),
      spreadAdjustedEdge: 0.01,
      slippageAdjustedEdge: 0.005,
      feeAdjustedEdge: 0.001,
      timeoutAdjustedEdge: -0.001,
      staleSignalAdjustedEdge: -0.001,
      inventoryAdjustedEdge: -0.001,
      finalNetEdge: -0.001,
      threshold: 0.0025,
      missingInputs: [],
      staleInputs: [],
      paperEdgeBlocked: true,
      confidence: executableEv.confidence,
    },
  });

  assert.strictEqual(typeof executableEv.decomposition.expectedSlippage, 'number');
  assert.strictEqual(typeof executableEv.decomposition.expectedCancellationCost, 'number');
  assert.strictEqual(executableEv.expectedEv <= 0, true);
  assert.strictEqual(gate.admitted, false);
  assert.strictEqual(gate.reasonCode, 'positive_direction_but_negative_ev');
}

async function testTradeAdmissionDefaultsToNoTradeWhenGateMissing(): Promise<void> {
  let rejectedReason: string | null = null;

  const prisma = {
    signal: {
      findMany: async () =>
        [
          createExecutionSignal({
            posteriorProbability: 0.8,
            edge: 0.2,
            expectedEv: 0.12,
          }),
        ],
      update: async () => null,
    },
    portfolioSnapshot: {
      findFirst: async () => ({
        bankroll: 1000,
        availableCapital: 1000,
        realizedPnlDay: 0,
        consecutiveLosses: 0,
        capturedAt: new Date(),
      }),
    },
    position: {
      count: async () => 0,
    },
    order: {
      findMany: async () => [],
    },
    signalDecision: {
      findFirst: async () => null,
      create: async ({ data }: { data: { reasonCode: string } }) => {
        rejectedReason = data.reasonCode;
      },
    },
    market: {
      findMany: async () => [createMarket()],
    },
    orderbook: {
      findFirst: async () => createFreshOrderbook({ spread: 0.02 }),
    },
    marketSnapshot: {
      findFirst: async () => createFreshSnapshot(),
    },
    reconciliationCheckpoint: {
      findFirst: async ({ where }: { where: { source: string } }) =>
        where.source === 'open_orders_reconcile_cycle'
          ? null
          : createFreshReconciliationCheckpoint(where.source),
    },
    botRuntimeStatus: {
      findUnique: async () => createFreshRuntimeStatus(),
    },
  };

  const job = new EvaluateTradeOpportunitiesJob(prisma as never);
  const result = await job.run(createRuntimeConfig());

  assert.strictEqual(result.approved, 0);
  assert.strictEqual(result.rejected, 1);
  assert.strictEqual(rejectedReason === 'passed', false);
}

async function testOpenOrderSyncFailureDoesNotMutateFilled(): Promise<void> {
  let updates = 0;

  const prisma = {
    order: {
      findMany: async () => [
        {
          id: 'o1',
          venueOrderId: 'v1',
          status: 'submitted',
          createdAt: new Date(),
        },
      ],
      update: async () => {
        updates += 1;
      },
    },
  };

  const job = new ManageOpenOrdersJob(prisma as never);
  (job as any).fetchVenueOpenOrders = async () => ({ ok: false, orders: [] });

  const result = await job.run();
  assert.strictEqual(result.syncFailed, true);
  assert.strictEqual(result.canceled, 0);
  assert.strictEqual(updates, 0);
}

async function testReconcileReplayIsIdempotent(): Promise<void> {
  let fillCreateCalls = 0;
  let orderUpdateCalls = 0;

  const prisma = {
    fill: {
      findUnique: async () => ({ id: 't1' }),
      create: async () => {
        fillCreateCalls += 1;
      },
    },
    order: {
      findFirst: async () => ({
        id: 'o1',
        marketId: 'm1',
        tokenId: 'yes1',
        size: 10,
        filledSize: 0,
        avgFillPrice: null,
        acknowledgedAt: null,
      }),
      findMany: async () => [],
      update: async () => {
        orderUpdateCalls += 1;
      },
    },
  };

  const runtimeControl = {
    recordReconciliationCheckpoint: async () => null,
  };

  const job = new ReconcileFillsJob(prisma as never, runtimeControl as never);
  (job as any).fetchVenueTrades = async () => [
    {
      id: 't1',
      orderId: 'o1',
      price: 0.5,
      size: 2,
      fee: 0,
      filledAt: new Date().toISOString(),
    },
  ];

  const result = await job.run();
  assert.strictEqual(result.fillsInserted, 0);
  assert.strictEqual(fillCreateCalls, 0);
  assert.strictEqual(orderUpdateCalls, 0);
}

async function testNoTradeNearExpiryRejected(): Promise<void> {
  let rejected = 0;

  const prisma = {
    signal: {
      findMany: async () => [
        createExecutionSignal({
          observedAt: new Date(),
        }),
      ],
      update: async ({ data }: { data: { status: string } }) => {
        if (data.status === 'rejected') {
          rejected += 1;
        }
      },
    },
    portfolioSnapshot: {
      findFirst: async () => ({
        bankroll: 1000,
        availableCapital: 1000,
        realizedPnlDay: 0,
        consecutiveLosses: 0,
        capturedAt: new Date(),
      }),
    },
    position: {
      count: async () => 0,
    },
    order: {
      findMany: async () => [],
    },
    signalDecision: {
      findFirst: async () => null,
      create: async () => null,
    },
    market: {
      findMany: async () => [createMarket()],
    },
    orderbook: {
      findFirst: async () => createFreshOrderbook(),
    },
    marketSnapshot: {
      findFirst: async () => ({
        expiresAt: new Date(Date.now() + 10_000),
        observedAt: new Date(),
      }),
    },
  };

  const job = new EvaluateTradeOpportunitiesJob(prisma as never);
  const result = await job.run(createRuntimeConfig());

  assert.strictEqual(result.approved, 0);
  assert.strictEqual(rejected, 1);
}

async function testStaleSignalRejected(): Promise<void> {
  let rejected = 0;

  const prisma = {
    signal: {
      findMany: async () => [
        createExecutionSignal({
          observedAt: new Date(Date.now() - 120_000),
        }),
      ],
      update: async ({ data }: { data: { status: string } }) => {
        if (data.status === 'rejected') {
          rejected += 1;
        }
      },
    },
    portfolioSnapshot: {
      findFirst: async () => ({
        bankroll: 1000,
        availableCapital: 1000,
        realizedPnlDay: 0,
        consecutiveLosses: 0,
        capturedAt: new Date(),
      }),
    },
    position: {
      count: async () => 0,
    },
    order: {
      findMany: async () => [],
    },
    signalDecision: {
      findFirst: async () => null,
      create: async () => null,
    },
    market: {
      findMany: async () => [createMarket()],
    },
    orderbook: {
      findFirst: async () => createFreshOrderbook(),
    },
    marketSnapshot: {
      findFirst: async () => ({ expiresAt: null, observedAt: new Date() }),
    },
  };

  const job = new EvaluateTradeOpportunitiesJob(prisma as never);
  const result = await job.run(createRuntimeConfig());

  assert.strictEqual(result.approved, 0);
  assert.strictEqual(rejected, 1);
}

async function testPortfolioSnapshotRequiredForRiskApproval(): Promise<void> {
  const prisma = {
    signal: {
      findMany: async () => [createExecutionSignal()],
    },
    portfolioSnapshot: {
      findFirst: async () => null,
    },
    position: {
      count: async () => 0,
    },
    order: {
      findMany: async () => [],
    },
    market: {
      findMany: async () => [createMarket()],
    },
  };

  const job = new EvaluateTradeOpportunitiesJob(prisma as never);
  const result = await job.run(createRuntimeConfig());

  assert.strictEqual(result.killSwitchTriggered, true);
  assert.strictEqual(result.killSwitchReason, 'portfolio_snapshot_missing');
}

async function testPortfolioSnapshotFreshnessRequiredForRiskApproval(): Promise<void> {
  const prisma = {
    signal: {
      findMany: async () => [createExecutionSignal()],
    },
    portfolioSnapshot: {
      findFirst: async () => ({
        bankroll: 1000,
        availableCapital: 1000,
        realizedPnlDay: 0,
        consecutiveLosses: 0,
        capturedAt: new Date(Date.now() - 30_000),
      }),
    },
    position: {
      count: async () => 0,
    },
    order: {
      findMany: async () => [],
    },
    market: {
      findMany: async () => [createMarket()],
    },
  };

  const job = new EvaluateTradeOpportunitiesJob(prisma as never);
  const result = await job.run(createRuntimeConfig());

  assert.strictEqual(result.killSwitchTriggered, true);
  assert.strictEqual(result.killSwitchReason, 'portfolio_snapshot_stale');
}

async function testExecutionAuthorityVetoBlocksSubmit(): Promise<void> {
  let executed = false;

  const executionPortfolioAgent = new ExecutionPortfolioAgent(
    {
      run: async () => {
        executed = true;
        return { submitted: 1, rejected: 0 };
      },
    } as never,
    { run: async () => ({ canceled: 0, observed: 0, syncFailed: false }) } as never,
    { run: async () => ({ fillsInserted: 0 }) } as never,
    { run: async () => ({ snapshotId: null }) } as never,
  );

  const result = await executionPortfolioAgent.runExecution({
    canSubmit: () => true,
    authority: {
      marketAuthorityPassed: true,
      riskAuthorityPassed: false,
      riskAuthorityReason: 'risk_final_veto_test',
    },
  });

  assert.strictEqual(result.submitted, 0);
  assert.strictEqual(result.rejected, 0);
  assert.strictEqual(result.blockedByAuthority, true);
  assert.strictEqual(result.blockReason, 'risk_final_veto_test');
  assert.strictEqual(executed, false);
}

async function testRiskVerificationFinalVetoRejectsApprovedSignal(): Promise<void> {
  let signalStatus: 'approved' | 'rejected' = 'approved';
  const signal = createExecutionSignal();

  const prisma = {
    signal: {
      findMany: async () => (signalStatus === 'approved' ? [signal] : []),
      update: async ({ data }: { data: { status: 'approved' | 'rejected' } }) => {
        signalStatus = data.status;
      },
    },
    signalDecision: {
      findFirst: async () => ({ positionSize: 10 }),
      create: async () => null,
    },
    market: {
      findUnique: async () => createMarket(),
    },
    orderbook: {
      findFirst: async () =>
        createFreshOrderbook({
          observedAt: new Date(Date.now() - 120_000),
        }),
    },
    marketSnapshot: {
      findFirst: async () => ({
        observedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    },
    order: {
      findFirst: async () => null,
    },
    position: {
      findFirst: async () => null,
    },
  };

  const riskAgent = new RiskVerificationAgent(
    {
      run: async () => ({
        approved: 1,
        rejected: 0,
        killSwitchTriggered: false,
        killSwitchReason: null,
      }),
    } as never,
    prisma as never,
  );

  const result = await riskAgent.run(createRuntimeConfig());

  assert.strictEqual(result.allowEntries, false);
  assert.strictEqual(result.finalVetoTriggered, true);
  assert.strictEqual((result.vetoedSignals ?? 0) > 0, true);
  assert.strictEqual(signalStatus, 'rejected');
}

async function testAgentE2EOrchestrationSmoke(): Promise<void> {
  let executed = false;

  const marketAnalysisAgent = new MarketAnalysisAgent(
    { run: async () => ({ discovered: 1 }) } as never,
    { run: async () => ({ symbol: 'BTCUSD', spotPrice: 1, candles: [], observedAt: new Date().toISOString() }) } as never,
    { run: async () => ({ synced: 1 }) } as never,
    { run: async () => ({ created: 1 }) } as never,
  );

  const riskVerificationAgent = new RiskVerificationAgent({
    run: async () => ({
      approved: 1,
      rejected: 0,
      killSwitchTriggered: false,
      killSwitchReason: null,
    }),
  } as never);

  const executionPortfolioAgent = new ExecutionPortfolioAgent(
    {
      run: async () => {
        executed = true;
        return { submitted: 1, rejected: 0 };
      },
    } as never,
    { run: async () => ({ canceled: 0, observed: 0, syncFailed: false }) } as never,
    { run: async () => ({ fillsInserted: 0 }) } as never,
    { run: async () => ({ snapshotId: null }) } as never,
  );

  await marketAnalysisAgent.run();
  await riskVerificationAgent.run(createRuntimeConfig());
  await executionPortfolioAgent.runExecution({
    canSubmit: () => true,
  });

  assert.strictEqual(executed, true);
}

async function testCanonicalEdgeDefinitionBlocksMissingDefinition(): Promise<void> {
  const edgeDefinition = new EdgeDefinitionService().getDefinition();
  assert.strictEqual(edgeDefinition.version.length > 0, true);
  assert.strictEqual(edgeDefinition.executableBenchmark.includesFees, true);

  const gate = new TradeAdmissionGate();
  const result = gate.evaluate({
    edgeDefinitionVersion: null,
    signalPresent: true,
    directionalEdge: 0.03,
    executableEv: 0.01,
    signalConfidence: 0.8,
    walkForwardConfidence: 0.8,
    liquidityHealthy: true,
    freshnessHealthy: true,
    venueHealthy: true,
    reconciliationHealthy: true,
    riskHealthy: true,
    regimeAllowed: true,
    executableEdge: {
      edgeDefinitionVersion: null,
      executionStyle: 'hybrid',
      rawModelEdge: 0.03,
      spreadAdjustedEdge: 0.02,
      slippageAdjustedEdge: 0.015,
      feeAdjustedEdge: 0.01,
      timeoutAdjustedEdge: 0.009,
      staleSignalAdjustedEdge: 0.008,
      inventoryAdjustedEdge: 0.007,
      finalNetEdge: 0.007,
      threshold: 0.0025,
      missingInputs: [],
      staleInputs: [],
      paperEdgeBlocked: false,
      confidence: 0.8,
    },
  });

  assert.strictEqual(result.reasonCode, 'edge_definition_missing');
}

async function testResearchGovernanceAndPromotionRequireRobustEvidence(): Promise<void> {
  const validator = new WalkForwardValidator();
  const governancePolicy = new ResearchGovernancePolicy();
  const robustnessSuite = new RobustnessSuite();
  const promotionScore = new MultiObjectivePromotionScore();

  const samples = Array.from({ length: 30 }, (_, index) => ({
    observedAt: new Date(Date.now() - (30 - index) * 300_000).toISOString(),
    expectedEdge: 0.01,
    executableEv: 0.004,
    costAdjustedEv: 0.004,
    regime: 'momentum_continuation',
    realizedReturn: index % 2 === 0 ? 0.004 : -0.01,
    fillRate: 0.6,
    predictedProbability: 0.7,
    realizedOutcome: index % 2,
    eventType: 'binary_event_contract',
    liquidityBucket: 'deep',
    timeBucket: 'us',
    marketStructureBucket: 'balanced',
  }));

  const validation = validator.validate({ samples });
  const governance = governancePolicy.evaluate({
    strategyVersionId: 'strategy',
    edgeDefinitionVersion: 'btc-5m-polymarket-edge-v1',
    validation,
  });
  const robustness = robustnessSuite.evaluate({
    realizedVsExpected: validation.aggregate.realizedVsExpected,
    worstWindowEv: validation.aggregate.worstWindowEv,
    calibrationGap: validation.maxCalibrationGap,
    segmentCoverage: validation.segmentCoverage,
  });
  const promotion = promotionScore.evaluate({
    governanceConfidence: governance.confidence,
    robustnessScore: robustness.score,
    realizedVsExpected: validation.aggregate.realizedVsExpected,
    calibrationGap: validation.maxCalibrationGap,
    auditCoverage: 0.4,
  });

  assert.strictEqual(governance.promotionEligible, false);
  assert.strictEqual(robustness.passed, false);
  assert.strictEqual(promotion.promoted, false);
}

async function testNoTradeZonesHalfLifeAndSetupAwareAttribution(): Promise<void> {
  const featureBuilder = new FeatureBuilder();
  const microstructureModel = new EventMicrostructureModel();
  const noTradeZonePolicy = new NoTradeZonePolicy();
  const halfLifePolicy = new EdgeHalfLifePolicy();
  const attribution = new TradeAttributionService();

  const features = featureBuilder.build({
    candles: {
      symbol: 'BTCUSD',
      timeframe: '5m',
      candles: createHealthyBtcReference().candles.slice(-8),
    },
    orderbook: createFreshOrderbook({ spread: 0.055 }) as any,
    expiresAt: new Date(Date.now() + 20_000).toISOString(),
  });
  const microstructure = microstructureModel.derive({
    features,
    posteriorProbability: 0.61,
    marketImpliedProbability: 0.5,
  });
  const halfLife = halfLifePolicy.evaluate({
    rawEdge: 0.03,
    signalAgeMs: 90_000,
    timeToExpirySeconds: 20,
    microstructure,
  });
  const noTrade = noTradeZonePolicy.evaluate({
    timeToExpirySeconds: 20,
    noTradeWindowSeconds: 30,
    btcFresh: true,
    orderbookFresh: true,
    spread: features.spread,
    topLevelDepth: features.topLevelDepth,
    microstructure,
    governanceHealthy: true,
    edgeHalfLifeHealthy: !halfLife.expired,
  });
  const record = attribution.attribute({
    signal: {
      expectedEdge: 0.03,
      expectedEv: 0.01,
      marketEligible: true,
      signalAgeMs: 90_000,
    },
    execution: {
      expectedEntryPrice: 0.5,
      actualEntryPrice: 0.53,
      realizedSlippage: 0.03,
      expectedSlippage: 0.01,
      fillDelayMs: 90_000,
      fees: 0.01,
      grossPnl: -0.01,
      netPnl: -0.02,
    },
    staleData: false,
    inventoryManagedExit: false,
    setup: {
      strategyFamily: 'expiry_window_behavior',
      edgeDefinitionVersion: 'btc-5m-polymarket-edge-v1',
      admissibleNetEdge: -0.001,
      halfLifeExpired: halfLife.expired,
      noTradeZones: noTrade.reasons,
    },
  });

  assert.strictEqual(noTrade.blocked, true);
  assert.strictEqual(halfLife.expired, true);
  assert.strictEqual(record.bucket, 'bad_setup_fit');
}

async function testNetEdgePoliciesRejectLowMarginOpportunity(): Promise<void> {
  const featureBuilder = new FeatureBuilder();
  const microstructureModel = new EventMicrostructureModel();
  const estimator = new NetEdgeEstimator();
  const thresholdPolicy = new NetEdgeThresholdPolicy();
  const noTradeZonePolicy = new NoTradeZonePolicy();

  const features = featureBuilder.build({
    candles: {
      symbol: 'BTCUSD',
      timeframe: '5m',
      candles: createHealthyBtcReference().candles.slice(-8),
    },
    orderbook: createFreshOrderbook({ spread: 0.032 }) as any,
    expiresAt: new Date(Date.now() + 180_000).toISOString(),
  });
  const microstructure = microstructureModel.derive({
    features,
    posteriorProbability: 0.68,
    marketImpliedProbability: 0.5,
  });
  const netEdge = estimator.estimate({
    grossForecastEdge: 0.02,
    expectedEv: 0.012,
    feeRate: 0.005,
    spread: features.spread,
    signalAgeMs: 45_000,
    halfLifeMultiplier: 0.82,
    topLevelDepth: features.topLevelDepth,
    estimatedOrderSizeUnits: 40,
    executionStyle: 'hybrid',
    calibrationHealth: 'degraded',
    calibrationShrinkageFactor: 0.74,
    calibrationSampleCount: 12,
    regimeHealth: 'degraded',
    venueUncertaintyLabel: 'degraded',
    venueMode: 'size-reduced',
  });
  const threshold = thresholdPolicy.evaluate({
    baseMinimumNetEdge: 0.0025,
    netEdge: netEdge.breakdown,
    regimeHealth: 'degraded',
    venueUncertaintyLabel: 'degraded',
  });
  const noTrade = noTradeZonePolicy.evaluate({
    timeToExpirySeconds: features.timeToExpirySeconds,
    noTradeWindowSeconds: 30,
    btcFresh: true,
    orderbookFresh: true,
    spread: features.spread,
    topLevelDepth: features.topLevelDepth,
    microstructure,
    governanceHealthy: true,
    edgeHalfLifeHealthy: true,
    netEdge: netEdge.breakdown,
    thresholdDecision: threshold,
    calibrationHealth: 'degraded',
    regimeHealth: 'degraded',
    executionContextHealthy: true,
    venueUncertaintyLabel: 'degraded',
  });

  assert.strictEqual(netEdge.breakdown.finalNetEdge <= threshold.minimumNetEdge, true);
  assert.strictEqual(threshold.passed, false);
  assert.strictEqual(noTrade.blocked, true);
  assert.strictEqual(noTrade.reasons.includes('weak_net_edge'), true);
  assert.strictEqual(noTrade.reasons.includes('poor_calibration'), true);
  assert.strictEqual(noTrade.reasons.includes('poor_regime_health'), true);
}

async function testRegimeProfitabilityPoliciesReduceDestructiveRegime(): Promise<void> {
  const ranker = new RegimeProfitabilityRanker();
  const capitalPolicy = new RegimeCapitalPolicy();
  const disablePolicy = new RegimeDisablePolicy();
  const recentTradeQualityScores = [
    createTradeQualityScoreFixture({ label: 'destructive', overallScore: 0.22 }),
    createTradeQualityScoreFixture({ label: 'poor', overallScore: 0.34 }),
    createTradeQualityScoreFixture({ label: 'destructive', overallScore: 0.18 }),
  ];

  const assessment = ranker.rank({
    strategyVariantId: 'variant:strategy-live-1',
    regime: 'momentum_continuation',
    regimeSnapshot: {
      key: 'regime:momentum_continuation',
      regime: 'momentum_continuation',
      liquidityBucket: 'balanced',
      spreadBucket: 'normal',
      timeToExpiryBucket: 'under_15m',
      entryTimingBucket: 'early',
      executionStyle: 'hybrid',
      side: 'buy',
      strategyVariantId: 'variant:strategy-live-1',
      sampleCount: 9,
      winRate: 0.33,
      expectedEvSum: 0.18,
      realizedEvSum: -0.09,
      avgExpectedEv: 0.02,
      avgRealizedEv: -0.01,
      realizedVsExpected: -0.5,
      avgFillRate: 0.62,
      avgSlippage: 0.005,
      health: 'degraded',
      lastObservedAt: '2026-03-27T00:00:00.000Z',
    },
    calibrationHealth: 'degraded',
    executionContext: {
      contextKey: 'execution:variant:strategy-live-1|regime:momentum_continuation',
      strategyVariantId: 'variant:strategy-live-1',
      regime: 'momentum_continuation',
      sampleCount: 9,
      makerSampleCount: 4,
      takerSampleCount: 5,
      makerFillRate: 0.4,
      takerFillRate: 0.68,
      averageFillDelayMs: 45_000,
      averageSlippage: 0.005,
      adverseSelectionScore: 0.6,
      cancelSuccessRate: 0.7,
      partialFillRate: 0.22,
      makerPunished: true,
      health: 'degraded',
      notes: ['destructive_regime_fixture'],
      activePolicyVersionId: null,
      lastUpdatedAt: '2026-03-27T00:00:00.000Z',
    },
    recentTradeQualityScores,
    currentDrawdownPct: 0.07,
    maxDrawdownPct: 0.1,
    recentLeakShare: 0.42,
  });
  const capitalDecision = capitalPolicy.decide({
    assessment,
    portfolioAllocationMultiplier: 0.8,
  });
  const disableDecision = disablePolicy.evaluate({
    assessment,
    recentTradeQualityScores,
    recentLeakShare: 0.42,
    recentLeakDominantCategory: 'overtrading',
  });

  assert.strictEqual(assessment.rank, 'avoid_regime');
  assert.strictEqual(capitalDecision.blockNewTrades, true);
  assert.strictEqual(disableDecision.status, 'disabled');
  assert.strictEqual(disableDecision.blockNewTrades, true);
}

async function testWaveThreeGovernorsPreferReducedActivityOverMarginalActivity(): Promise<void> {
  const frequencyGovernor = new TradeFrequencyGovernor();
  const cooldownPolicy = new MarginalEdgeCooldownPolicy();
  const saturationDetector = new OpportunitySaturationDetector();

  const frequency = frequencyGovernor.evaluate({
    regime: 'momentum_continuation',
    regimeRank: 'marginal_regime',
    opportunityClass: 'marginal_edge',
    recentTradeCount: 1,
    recentTradeQualityScore: 0.44,
    recentCapitalLeakageShare: 0.34,
    currentDrawdownPct: 0.05,
  });
  const cooldown = cooldownPolicy.evaluate({
    opportunityClass: 'marginal_edge',
    marginAboveThreshold: 0.0008,
    recentMarginalApprovalCount: 2,
    recentMarginalAttemptCount: 5,
    recentLowQualityTradeShare: 0.4,
  });
  const saturation = saturationDetector.evaluate({
    recentApprovedCount: 4,
    recentStrongApprovalCount: 1,
    recentMarginalApprovalCount: 3,
    recentWeakRejectCount: 4,
    recentAverageMarginAboveThreshold: 0.001,
    recentTradeQualityScore: 0.48,
    recentCapitalLeakageShare: 0.33,
  });

  assert.strictEqual(frequency.blockTrade, true);
  assert.strictEqual(cooldown.blockTrade, true);
  assert.strictEqual(saturation.label, 'saturated');
  assert.strictEqual(saturation.blockTrade, true);
}

async function testEvaluateTradeOpportunitiesAppliesWaveThreeRegimeDiscipline(): Promise<void> {
  let rejectedReason: string | null = null;
  let rejectedMessage: string | null = null;
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase12-wave3-'));
  const deploymentRegistry = new StrategyDeploymentRegistry(rootDir);
  const learningStateStore = new LearningStateStore(rootDir);
  const tradeQualityHistoryStore = new TradeQualityHistoryStore(
    path.join(rootDir, 'trade-quality'),
  );
  const registryState = createDefaultStrategyDeploymentRegistryState(
    new Date('2026-03-24T00:00:00.000Z'),
  );
  registryState.incumbentVariantId = 'variant:strategy-live-1';
  registryState.variants['variant:strategy-live-1'] = {
    variantId: 'variant:strategy-live-1',
    strategyVersionId: 'strategy-live-1',
    status: 'incumbent',
    evaluationMode: 'full',
    rolloutStage: 'full',
    health: 'degraded',
    lineage: {
      variantId: 'variant:strategy-live-1',
      strategyVersionId: 'strategy-live-1',
      parentVariantId: null,
      createdAt: '2026-03-20T00:00:00.000Z',
      createdReason: 'test',
    },
    capitalAllocationPct: 1,
    lastShadowEvaluatedAt: null,
    createdAt: '2026-03-20T00:00:00.000Z',
    updatedAt: '2026-03-20T00:00:00.000Z',
  };
  await deploymentRegistry.save(registryState);

  const learningState = createDefaultLearningState(
    new Date('2026-03-24T00:00:00.000Z'),
  );
  learningState.strategyVariants['variant:strategy-live-1'] = {
    ...createDefaultStrategyVariantState('variant:strategy-live-1'),
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
        strategyVariantId: 'variant:strategy-live-1',
        sampleCount: 10,
        winRate: 0.3,
        expectedEvSum: 0.2,
        realizedEvSum: -0.08,
        avgExpectedEv: 0.02,
        avgRealizedEv: -0.008,
        realizedVsExpected: -0.4,
        avgFillRate: 0.58,
        avgSlippage: 0.005,
        health: 'degraded',
        lastObservedAt: '2026-03-24T00:00:00.000Z',
      },
    },
    executionLearning: {
      ...createDefaultExecutionLearningState(),
      contexts: {
        'execution:variant:strategy-live-1|regime:momentum_continuation': {
          contextKey: 'execution:variant:strategy-live-1|regime:momentum_continuation',
          strategyVariantId: 'variant:strategy-live-1',
          regime: 'momentum_continuation',
          sampleCount: 10,
          makerSampleCount: 4,
          takerSampleCount: 6,
          makerFillRate: 0.42,
          takerFillRate: 0.7,
          averageFillDelayMs: 50_000,
          averageSlippage: 0.0048,
          adverseSelectionScore: 0.55,
          cancelSuccessRate: 0.7,
          partialFillRate: 0.24,
          makerPunished: true,
          health: 'degraded',
          notes: ['wave3_fixture'],
          activePolicyVersionId: null,
          lastUpdatedAt: '2026-03-24T00:00:00.000Z',
        },
      },
    },
    lastCapitalAllocationDecision: {
      status: 'hold',
      targetMultiplier: 1,
      reasons: ['fixture'],
      decidedAt: '2026-03-24T00:00:00.000Z',
    },
  };
  learningState.portfolioLearning.allocationDecisions['variant:strategy-live-1'] = {
    decisionKey: 'allocation:variant:strategy-live-1',
    strategyVariantId: 'variant:strategy-live-1',
    targetMultiplier: 1,
    status: 'hold',
    reasons: ['fixture'],
    evidence: {
      currentDrawdown: 0.07,
      maxDrawdown: 0.1,
    },
    decidedAt: '2026-03-24T00:00:00.000Z',
  };
  learningState.calibration['variant:strategy-live-1|regime:momentum_continuation'] = {
    contextKey: 'variant:strategy-live-1|regime:momentum_continuation',
    strategyVariantId: 'variant:strategy-live-1',
    regime: 'momentum_continuation',
    sampleCount: 10,
    brierScore: 0.3,
    logLoss: 0.85,
    shrinkageFactor: 0.75,
    overconfidenceScore: 0.22,
    health: 'degraded',
    version: 2,
    driftSignals: ['wave3_fixture'],
    lastUpdatedAt: '2026-03-24T00:00:00.000Z',
  };
  await learningStateStore.save(learningState);

  await tradeQualityHistoryStore.append([
    createTradeQualityScoreFixture({
      tradeId: 'trade-1',
      orderId: 'order-1',
      signalId: 'old-1',
      strategyVariantId: 'variant:strategy-live-1',
      regime: 'momentum_continuation',
      label: 'destructive',
      overallScore: 0.2,
    }),
    createTradeQualityScoreFixture({
      tradeId: 'trade-2',
      orderId: 'order-2',
      signalId: 'old-2',
      strategyVariantId: 'variant:strategy-live-1',
      regime: 'momentum_continuation',
      label: 'poor',
      overallScore: 0.34,
    }),
    createTradeQualityScoreFixture({
      tradeId: 'trade-3',
      orderId: 'order-3',
      signalId: 'old-3',
      strategyVariantId: 'variant:strategy-live-1',
      regime: 'momentum_continuation',
      label: 'destructive',
      overallScore: 0.18,
    }),
  ]);

  const prisma = {
    signal: {
      findMany: async () => [
        createExecutionSignal({
          observedAt: new Date(),
          edge: 0.05,
          expectedEv: 0.04,
          regime: 'momentum_continuation',
        }),
      ],
      update: async () => null,
    },
    portfolioSnapshot: {
      findFirst: async () => ({
        bankroll: 1000,
        availableCapital: 1000,
        deployableRiskNow: 1000,
        workingBuyNotional: 0,
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
      findMany: async () => [
        { signalId: 'old-1', verdict: 'approved', decisionAt: new Date('2026-03-24T00:02:00.000Z') },
        { signalId: 'old-2', verdict: 'approved', decisionAt: new Date('2026-03-24T00:03:00.000Z') },
        { signalId: 'old-3', verdict: 'rejected', decisionAt: new Date('2026-03-24T00:04:00.000Z') },
      ],
      create: async ({ data }: { data: { reasonCode: string; reasonMessage?: string | null } }) => {
        rejectedReason = data.reasonCode;
        rejectedMessage = data.reasonMessage ?? null;
      },
    },
    market: {
      findMany: async () => [createMarket()],
    },
    orderbook: {
      findFirst: async () => createFreshOrderbook({ spread: 0.02 }),
    },
    marketSnapshot: {
      findFirst: async () => createFreshSnapshot(),
    },
    reconciliationCheckpoint: {
      findFirst: async ({ where }: { where: { source: string } }) =>
        createFreshReconciliationCheckpoint(where.source),
    },
    botRuntimeStatus: {
      findUnique: async () => createFreshRuntimeStatus(),
    },
    executionDiagnostic: {
      findMany: async () => [],
    },
    auditEvent: {
      findMany: async () => [
        {
          signalId: 'old-1',
          eventType: 'signal.execution_decision',
          message: 'Execution admission approved for signal old-1.',
          createdAt: new Date('2026-03-24T00:02:00.000Z'),
          metadata: {
            opportunityClass: 'marginal_edge',
            netEdgeThreshold: { minimumNetEdge: 0.004, marginAboveThreshold: 0.0008 },
            netEdgeDecision: { breakdown: { finalNetEdge: 0.0048 } },
          },
        },
        {
          signalId: 'old-2',
          eventType: 'signal.execution_decision',
          message: 'Execution admission approved for signal old-2.',
          createdAt: new Date('2026-03-24T00:03:00.000Z'),
          metadata: {
            opportunityClass: 'marginal_edge',
            netEdgeThreshold: { minimumNetEdge: 0.004, marginAboveThreshold: 0.001 },
            netEdgeDecision: { breakdown: { finalNetEdge: 0.005 } },
          },
        },
        {
          signalId: 'old-3',
          eventType: 'signal.execution_decision',
          message: 'Execution admission rejected for signal old-3.',
          createdAt: new Date('2026-03-24T00:04:00.000Z'),
          metadata: {
            reasons: ['weak_net_edge'],
            opportunityClass: 'weak_edge',
            netEdgeThreshold: { minimumNetEdge: 0.004, marginAboveThreshold: -0.001 },
            netEdgeDecision: { breakdown: { finalNetEdge: 0.003 } },
          },
        },
        {
          eventType: 'capital.leak_review',
          message: 'Capital leak review computed.',
          createdAt: new Date('2026-03-24T00:01:00.000Z'),
          metadata: {
            report: {
              generatedAt: '2026-03-24T00:01:00.000Z',
              window: {
                from: '2026-03-23T00:00:00.000Z',
                to: '2026-03-24T00:00:00.000Z',
              },
              tradeCount: 3,
              totalLeak: 0.12,
              categoryTotals: { overtrading: 0.05 },
              dominantCategory: 'overtrading',
              dominantShare: 0.42,
              byStrategyVariant: [],
              byRegime: [
                {
                  groupKey: 'momentum_continuation',
                  tradeCount: 3,
                  totalLeak: 0.1,
                  categoryTotals: { overtrading: 0.05 },
                  dominantCategory: 'overtrading',
                  dominantShare: 0.5,
                },
              ],
              byMarketContext: [],
              byExecutionStyle: [],
              byTimeWindow: [],
            },
          },
        },
      ],
      create: async () => null,
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
    undefined,
    undefined,
    tradeQualityHistoryStore,
  );
  const result = await job.run(createRuntimeConfig());

  assert.strictEqual(result.approved, 0);
  assert.strictEqual(result.rejected, 1);
  assert.strictEqual(
    [
      'regime_capital_policy_blocked_capital',
      'regime_disable_policy_disabled',
      'trade_frequency_governor_blocked',
      'marginal_edge_cooldown_active',
      'opportunity_saturation_detected',
    ].some(
      (reason) => rejectedReason === reason || (rejectedMessage ?? '').includes(reason),
    ),
    true,
  );
}

async function testWaveFourCostModelCalibratesExecutionReality(): Promise<void> {
  const calibrator = new ExecutionCostCalibrator();
  const costModel = new RealizedCostModel();
  const timingScorer = new EntryTimingEfficiencyScorer();
  const calibration = calibrator.calibrate({
    activePolicyVersion: {
      versionId: 'execution-policy:test:v2',
      contextKey: 'execution:variant:strategy-live-1|regime:momentum_continuation',
      strategyVariantId: 'variant:strategy-live-1',
      regime: 'momentum_continuation',
      mode: 'taker_preferred',
      recommendedRoute: 'taker',
      recommendedExecutionStyle: 'cross',
      sampleCount: 8,
      makerFillRateAssumption: 0.4,
      takerFillRateAssumption: 0.7,
      expectedFillDelayMs: 25_000,
      expectedSlippage: 0.006,
      adverseSelectionScore: 0.01,
      cancelSuccessRate: 0.65,
      partialFillRate: 0.2,
      health: 'degraded',
      rationale: ['fixture'],
      sourceCycleId: 'cycle-wave4',
      supersedesVersionId: null,
      createdAt: '2026-03-24T00:00:00.000Z',
    },
    executionContext: {
      contextKey: 'execution:variant:strategy-live-1|regime:momentum_continuation',
      strategyVariantId: 'variant:strategy-live-1',
      regime: 'momentum_continuation',
      sampleCount: 8,
      makerSampleCount: 3,
      takerSampleCount: 5,
      makerFillRate: 0.42,
      takerFillRate: 0.72,
      averageFillDelayMs: 28_000,
      averageSlippage: 0.007,
      adverseSelectionScore: 0.012,
      cancelSuccessRate: 0.62,
      partialFillRate: 0.25,
      makerPunished: true,
      health: 'degraded',
      notes: ['fixture'],
      activePolicyVersionId: 'execution-policy:test:v2',
      lastUpdatedAt: '2026-03-24T00:00:00.000Z',
    },
    recentObservations: [
      {
        expectedFee: 0.001,
        realizedFee: 0.0012,
        expectedSlippage: 0.004,
        realizedSlippage: 0.009,
        edgeAtSignal: 0.03,
        edgeAtFill: 0.019,
        fillRate: 0.7,
        staleOrder: false,
        capturedAt: '2026-03-24T00:00:00.000Z',
      },
      {
        expectedFee: 0.001,
        realizedFee: 0.0011,
        expectedSlippage: 0.0045,
        realizedSlippage: 0.0085,
        edgeAtSignal: 0.029,
        edgeAtFill: 0.018,
        fillRate: 0.68,
        staleOrder: false,
        capturedAt: '2026-03-24T00:05:00.000Z',
      },
    ],
    cancelFailureRate: 0.3,
    venueUncertaintyLabel: 'degraded',
  });
  const timing = timingScorer.score({
    signalAgeMs: 18_000,
    timeToExpirySeconds: 75,
    halfLifeMultiplier: 0.62,
    halfLifeExpired: false,
    expectedFillDelayMs: calibration.expectedFillDelayMs,
    microstructureDecayPressure: 0.78,
  });
  const cost = costModel.evaluate({
    grossEdge: 0.02,
    feeCost: calibration.feeCost,
    slippageCost: calibration.slippageCost,
    adverseSelectionCost: calibration.adverseSelectionCost,
    fillDelayMs: 40_000,
    expectedFillDelayMs: calibration.expectedFillDelayMs,
    cancelReplaceOverheadCost: calibration.cancelReplaceOverheadCost,
    missedOpportunityCost: calibration.missedOpportunityCost,
  });

  assert.strictEqual(calibration.slippageCost > 0.006, true);
  assert.strictEqual(calibration.adverseSelectionCost > 0.005, true);
  assert.strictEqual(timing.label, 'late');
  assert.strictEqual((cost.retainedEdge ?? 1) < 0.02, true);
  assert.strictEqual(cost.reasons.includes('cost_adjusted_edge_non_positive'), true);
}

async function testWaveFourSizingPoliciesReduceExposure(): Promise<void> {
  const uncertaintySizing = new UncertaintyWeightedSizing();
  const sizePenaltyEngine = new SizePenaltyEngine();
  const liquidityPolicy = new SizeVsLiquidityPolicy();
  const maxLossPolicy = new MaxLossPerOpportunityPolicy();

  const penalty = sizePenaltyEngine.evaluate({
    calibrationHealth: 'degraded',
    executionHealth: 'degraded',
    regimeHealth: 'watch',
    venueUncertaintyLabel: 'degraded',
    concentrationPenaltyMultiplier: 0.8,
    correlationPenaltyMultiplier: 0.9,
  });
  const uncertainty = uncertaintySizing.evaluate({
    basePositionSize: 100,
    netEdge: 0.0045,
    netEdgeThreshold: 0.0035,
    calibrationHealth: 'degraded',
    executionHealth: 'degraded',
    regimeHealth: 'watch',
    venueHealth: 'degraded',
    currentDrawdownPct: 0.05,
    sampleCount: 4,
  });
  const liquidity = liquidityPolicy.evaluate({
    desiredNotional: uncertainty.adjustedPositionSize * penalty.multiplier,
    desiredSizeUnits: 160,
    price: 0.5,
    topLevelDepth: 80,
    spread: 0.03,
    expectedSlippage: 0.011,
    route: 'taker',
  });
  const lossCap = maxLossPolicy.evaluate({
    candidatePositionSize: liquidity.allowedNotional,
    bankroll: 1000,
    availableCapital: 100,
    maxPerTradeRiskPct: 1,
    opportunityClass: 'marginal_edge',
    signalConfidence: 0.55,
  });

  assert.strictEqual(penalty.multiplier < 1, true);
  assert.strictEqual(uncertainty.adjustedPositionSize < 100, true);
  assert.strictEqual(liquidity.allowedNotional < uncertainty.adjustedPositionSize * penalty.multiplier, true);
  assert.strictEqual(lossCap.maxAllowedPositionSize < liquidity.allowedNotional, true);
}

async function testEvaluateTradeOpportunitiesAppliesWaveFourExecutionRealism(): Promise<void> {
  let rejectedReason: string | null = null;
  let rejectedMessage: string | null = null;
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase12-wave4-eval-'));
  const deploymentRegistry = new StrategyDeploymentRegistry(rootDir);
  const learningStateStore = new LearningStateStore(rootDir);
  const registryState = createDefaultStrategyDeploymentRegistryState(
    new Date('2026-03-24T00:00:00.000Z'),
  );
  registryState.incumbentVariantId = 'variant:strategy-live-1';
  registryState.variants['variant:strategy-live-1'] = {
    variantId: 'variant:strategy-live-1',
    strategyVersionId: 'strategy-live-1',
    status: 'incumbent',
    evaluationMode: 'full',
    rolloutStage: 'full',
    health: 'watch',
    lineage: {
      variantId: 'variant:strategy-live-1',
      strategyVersionId: 'strategy-live-1',
      parentVariantId: null,
      createdAt: '2026-03-20T00:00:00.000Z',
      createdReason: 'test',
    },
    capitalAllocationPct: 1,
    lastShadowEvaluatedAt: null,
    createdAt: '2026-03-20T00:00:00.000Z',
    updatedAt: '2026-03-20T00:00:00.000Z',
  };
  await deploymentRegistry.save(registryState);

  const learningState = createDefaultLearningState(new Date('2026-03-24T00:00:00.000Z'));
  learningState.strategyVariants['variant:strategy-live-1'] = {
    ...createDefaultStrategyVariantState('variant:strategy-live-1'),
    health: 'watch',
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
        strategyVariantId: 'variant:strategy-live-1',
        sampleCount: 4,
        winRate: 0.55,
        expectedEvSum: 0.18,
        realizedEvSum: 0.12,
        avgExpectedEv: 0.022,
        avgRealizedEv: 0.015,
        realizedVsExpected: 0.67,
        avgFillRate: 0.7,
        avgSlippage: 0.006,
        health: 'watch',
        lastObservedAt: '2026-03-24T00:00:00.000Z',
      },
    },
    executionLearning: {
      ...createDefaultExecutionLearningState(),
      contexts: {
        'execution:strategy:variant:strategy-live-1|regime:momentum_continuation': {
          contextKey: 'execution:strategy:variant:strategy-live-1|regime:momentum_continuation',
          strategyVariantId: 'variant:strategy-live-1',
          regime: 'momentum_continuation',
          sampleCount: 8,
          makerSampleCount: 3,
          takerSampleCount: 5,
          makerFillRate: 0.45,
          takerFillRate: 0.68,
          averageFillDelayMs: 30_000,
          averageSlippage: 0.007,
          adverseSelectionScore: 0.012,
          cancelSuccessRate: 0.6,
          partialFillRate: 0.2,
          makerPunished: true,
          health: 'degraded',
          notes: ['wave4_fixture'],
          activePolicyVersionId: 'execution-policy:wave4:v1',
          lastUpdatedAt: '2026-03-24T00:00:00.000Z',
        },
      },
      policyVersions: {
        'execution-policy:wave4:v1': {
          versionId: 'execution-policy:wave4:v1',
          contextKey: 'execution:strategy:variant:strategy-live-1|regime:momentum_continuation',
          strategyVariantId: 'variant:strategy-live-1',
          regime: 'momentum_continuation',
          mode: 'taker_preferred',
          recommendedRoute: 'taker',
          recommendedExecutionStyle: 'cross',
          sampleCount: 8,
          makerFillRateAssumption: 0.45,
          takerFillRateAssumption: 0.68,
          expectedFillDelayMs: 30_000,
          expectedSlippage: 0.008,
          adverseSelectionScore: 0.012,
          cancelSuccessRate: 0.6,
          partialFillRate: 0.2,
          health: 'degraded',
          rationale: ['wave4_fixture'],
          sourceCycleId: 'cycle-wave4',
          supersedesVersionId: null,
          createdAt: '2026-03-24T00:00:00.000Z',
        },
      },
      activePolicyVersionIds: {
        'execution:strategy:variant:strategy-live-1|regime:momentum_continuation':
          'execution-policy:wave4:v1',
      },
    },
  };
  learningState.calibration['variant:strategy-live-1|regime:momentum_continuation'] = {
    contextKey: 'variant:strategy-live-1|regime:momentum_continuation',
    strategyVariantId: 'variant:strategy-live-1',
    regime: 'momentum_continuation',
    sampleCount: 8,
    brierScore: 0.22,
    logLoss: 0.6,
    shrinkageFactor: 0.85,
    overconfidenceScore: 0.12,
    health: 'watch',
    version: 2,
    driftSignals: [],
    lastUpdatedAt: '2026-03-24T00:00:00.000Z',
  };
  await learningStateStore.save(learningState);

  const prisma = {
    signal: {
      findMany: async () => [
        createExecutionSignal({
          observedAt: new Date(Date.now() - 10_000),
          expectedEv: 0.015,
          edge: 0.04,
          regime: 'momentum_continuation',
        }),
      ],
      update: async () => null,
    },
    portfolioSnapshot: {
      findFirst: async () => ({
        bankroll: 1000,
        availableCapital: 1000,
        deployableRiskNow: 1000,
        workingBuyNotional: 0,
        realizedPnlDay: 0,
        consecutiveLosses: 0,
        capturedAt: new Date(),
      }),
    },
    position: { findMany: async () => [] },
    order: { findMany: async () => [] },
    signalDecision: {
      findFirst: async () => null,
      findMany: async () => [],
      create: async ({ data }: { data: { reasonCode: string; reasonMessage: string } }) => {
        rejectedReason = data.reasonCode;
        rejectedMessage = data.reasonMessage;
      },
    },
    market: { findMany: async () => [createMarket()] },
    orderbook: {
      findFirst: async () =>
        createFreshOrderbook({
          bestBid: 0.5,
          bestAsk: 0.52,
          spread: 0.02,
          bidLevels: [{ price: 0.5, size: 60 }],
          askLevels: [{ price: 0.52, size: 60 }],
        }),
    },
    marketSnapshot: { findFirst: async () => createFreshSnapshot() },
    reconciliationCheckpoint: {
      findFirst: async ({ where }: { where: { source: string } }) =>
        createFreshReconciliationCheckpoint(where.source),
    },
    botRuntimeStatus: { findUnique: async () => createFreshRuntimeStatus() },
    executionDiagnostic: {
      findMany: async () => [
        {
          strategyVersionId: 'strategy-live-1',
          regime: 'momentum_continuation',
          expectedFee: 0.001,
          realizedFee: 0.0013,
          expectedSlippage: 0.004,
          realizedSlippage: 0.009,
          edgeAtSignal: 0.03,
          edgeAtFill: 0.017,
          fillRate: 0.68,
          staleOrder: false,
          capturedAt: new Date(),
        },
      ],
    },
    auditEvent: { findMany: async () => [] },
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
  );
  const result = await job.run(createRuntimeConfig());

  assert.strictEqual(result.approved, 0);
  assert.strictEqual(result.rejected, 1);
  assert.strictEqual(
    ['execution_cost_adjusted_edge_non_positive', 'entry_timing_blocks_opportunity'].some(
      (reason) => rejectedReason === reason || (rejectedMessage ?? '').includes(reason),
    ),
    true,
  );
}

async function testExecuteOrdersAppliesWaveFourExecutionCostReality(): Promise<void> {
  let rejectionReason: string | null = null;
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase12-wave4-exec-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const contextKey = buildExecutionLearningContextKey(
    'variant:strategy-live-1',
    'momentum_continuation',
  );
  const learningState = createDefaultLearningState(new Date('2026-03-25T00:00:00.000Z'));
  learningState.executionLearning = {
    ...createDefaultExecutionLearningState(),
    updatedAt: '2026-03-25T00:00:00.000Z',
    contexts: {
      [contextKey]: {
        contextKey,
        strategyVariantId: 'variant:strategy-live-1',
        regime: 'momentum_continuation',
        sampleCount: 6,
        makerSampleCount: 2,
        takerSampleCount: 4,
        makerFillRate: 0.45,
        takerFillRate: 0.7,
        averageFillDelayMs: 28_000,
        averageSlippage: 0.007,
        adverseSelectionScore: 0.012,
        cancelSuccessRate: 0.62,
        partialFillRate: 0.2,
        makerPunished: true,
        health: 'degraded',
        notes: ['wave4_fixture'],
        activePolicyVersionId: 'execution-policy:wave4:v1',
        lastUpdatedAt: '2026-03-25T00:00:00.000Z',
      },
    },
    policyVersions: {
      'execution-policy:wave4:v1': {
        versionId: 'execution-policy:wave4:v1',
        contextKey,
        strategyVariantId: 'variant:strategy-live-1',
        regime: 'momentum_continuation',
        mode: 'taker_preferred',
        recommendedRoute: 'taker',
        recommendedExecutionStyle: 'cross',
        sampleCount: 6,
        makerFillRateAssumption: 0.45,
        takerFillRateAssumption: 0.7,
        expectedFillDelayMs: 28_000,
        expectedSlippage: 0.008,
        adverseSelectionScore: 0.012,
        cancelSuccessRate: 0.62,
        partialFillRate: 0.2,
        health: 'degraded',
        rationale: ['wave4_fixture'],
        sourceCycleId: 'cycle-1',
        supersedesVersionId: null,
        createdAt: '2026-03-25T00:00:00.000Z',
      },
    },
    activePolicyVersionIds: {
      [contextKey]: 'execution-policy:wave4:v1',
    },
  };
  await learningStateStore.save(learningState);

  const prisma = {
    signal: {
      findMany: async () => [
        createExecutionSignal({
          expectedEv: 0.012,
          edge: 0.03,
          observedAt: new Date(Date.now() - 5_000),
        }),
      ],
      update: async () => null,
    },
    signalDecision: {
      findFirst: async () => ({ positionSize: 10, verdict: 'approved' }),
      create: async ({ data }: { data: { reasonCode: string } }) => {
        rejectionReason = data.reasonCode;
      },
    },
    market: { findUnique: async () => createMarket() },
    marketSnapshot: { findFirst: async () => createFreshSnapshot() },
    orderbook: { findFirst: async () => createFreshOrderbook({ spread: 0.02, minOrderSize: 0.1 }) },
    order: { findFirst: async () => null, create: async () => null },
    auditEvent: { create: async () => null },
    portfolioSnapshot: { findFirst: async () => createFreshPortfolioSnapshot() },
    reconciliationCheckpoint: {
      findFirst: async ({ where }: { where: { source: string } }) =>
        createFreshReconciliationCheckpoint(where.source),
    },
    botRuntimeStatus: { findUnique: async () => createFreshRuntimeStatus() },
    liveConfig: { findUnique: async () => ({ id: 'live', noTradeWindowSeconds: 30 }) },
    executionDiagnostic: {
      findMany: async () => [
        {
          strategyVersionId: 'strategy-live-1',
          regime: 'momentum_continuation',
          expectedFee: 0.001,
          realizedFee: 0.0012,
          expectedSlippage: 0.004,
          realizedSlippage: 0.009,
          edgeAtSignal: 0.028,
          edgeAtFill: 0.016,
          fillRate: 0.65,
          staleOrder: false,
          capturedAt: new Date(),
        },
      ],
    },
  };

  const job = new ExecuteOrdersJob(prisma as never, undefined, learningStateStore);
  stubExternalPortfolioService(job, createExternalPortfolioSnapshot());
  (job as any).tradingClient = {
    postOrder: async () => ({
      success: true,
      orderId: 'venue-o1',
      status: 'acknowledged',
    }),
  };
  const result = await job.run({ canSubmit: () => true });

  assert.strictEqual(result.submitted, 0);
  assert.strictEqual(result.rejected, 1);
  assert.strictEqual(
    [
      'execution_cost_adjusted_edge_non_positive',
      'live_sizing_feedback_threshold_not_met',
    ].includes(rejectionReason ?? ''),
    true,
  );
}

async function testCapitalLeakAttributionDistinguishesLossSources(): Promise<void> {
  const attribution = new CapitalLeakAttribution();
  const result = attribution.attribute({
    tradeId: 'trade-1',
    orderId: 'order-1',
    signalId: 'signal-1',
    marketId: 'm1',
    strategyVariantId: 'variant:strategy-live-1',
    regime: 'momentum_continuation',
    marketContext: 'btc-5m-higher:YES',
    executionStyle: 'taker',
    observedAt: new Date('2026-03-26T00:15:00.000Z').toISOString(),
    expectedEv: 0.06,
    realizedEv: -0.02,
    expectedSlippage: 0.002,
    realizedSlippage: 0.012,
    edgeAtSignal: 0.04,
    edgeAtFill: 0.018,
    fillRate: 0.55,
    allocatedNotional: 140,
    recommendedNotional: 80,
    calibrationHealth: 'degraded',
    regimeHealth: 'degraded',
    venueUncertaintyLabel: 'degraded',
    netEdgeAtDecision: 0.001,
    netEdgeThreshold: 0.003,
    policyBreaches: ['no_trade_zone', 'weak_net_edge'],
  });

  assert.strictEqual(result.totalLeak > 0, true);
  assert.strictEqual(
    result.contributions.some((contribution) => contribution.category === 'slippage'),
    true,
  );
  assert.strictEqual(
    result.contributions.some((contribution) => contribution.category === 'missed_fills'),
    true,
  );
  assert.strictEqual(
    result.contributions.some((contribution) => contribution.category === 'overtrading'),
    true,
  );
  assert.strictEqual(
    result.contributions.some(
      (contribution) => contribution.category === 'degraded_regime_trading',
    ),
    true,
  );
}

async function testCapitalLeakReviewPersistsReportAndTradeQualityHistory(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capital-leak-wave2-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const tradeQualityHistoryStore = new TradeQualityHistoryStore(
    path.join(rootDir, 'trade-quality'),
  );
  const learningState = createDefaultLearningState(new Date('2026-03-26T00:00:00.000Z'));
  const strategyVariantId = buildStrategyVariantId('strategy-live-1');
  learningState.strategyVariants[strategyVariantId] = {
    ...createDefaultStrategyVariantState(strategyVariantId),
    health: 'degraded',
  };
  learningState.calibration[`strategy:${strategyVariantId}|regime:momentum_continuation`] = {
    contextKey: `strategy:${strategyVariantId}|regime:momentum_continuation`,
    strategyVariantId,
    regime: 'momentum_continuation',
    sampleCount: 12,
    brierScore: 0.24,
    logLoss: 0.62,
    shrinkageFactor: 0.72,
    overconfidenceScore: 0.18,
    health: 'degraded',
    version: 1,
    driftSignals: ['overconfidence_detected'],
    lastUpdatedAt: '2026-03-25T00:00:00.000Z',
  };
  await learningStateStore.save(learningState);

  const createdAuditEvents: Array<{ eventType: string; metadata?: Record<string, unknown> }> = [];
  const decisionEvent = {
    signalId: 'signal-1',
    createdAt: new Date('2026-03-26T00:10:10.000Z'),
    metadata: {
      netEdgeDecision: {
        breakdown: {
          finalNetEdge: 0.001,
        },
      },
      netEdgeThreshold: {
        minimumNetEdge: 0.003,
      },
      noTradeZone: {
        reasons: ['weak_net_edge', 'poor_calibration'],
      },
      venueAssessment: {
        label: 'degraded',
      },
      reasons: ['weak_net_edge'],
      rolloutControls: {
        reasonCodes: [],
      },
    },
  };

  const prisma = {
    executionDiagnostic: {
      findMany: async () => [
        {
          orderId: 'order-1',
          strategyVersionId: 'strategy-live-1',
          expectedEv: 0.05,
          realizedEv: -0.02,
          expectedSlippage: 0.002,
          realizedSlippage: 0.01,
          edgeAtSignal: 0.035,
          edgeAtFill: 0.016,
          fillRate: 0.6,
          staleOrder: false,
          regime: 'momentum_continuation',
          capturedAt: new Date('2026-03-26T00:10:30.000Z'),
        },
      ],
    },
    order: {
      findMany: async () => [
        {
          id: 'order-1',
          marketId: 'm1',
          signalId: 'signal-1',
          strategyVersionId: 'strategy-live-1',
          price: 0.52,
          size: 120,
          status: 'filled',
          createdAt: new Date('2026-03-26T00:09:00.000Z'),
          signal: {
            id: 'signal-1',
            marketId: 'm1',
            regime: 'momentum_continuation',
            strategyVersionId: 'strategy-live-1',
            expectedEv: 0.05,
            edge: 0.035,
          },
          market: {
            id: 'm1',
            slug: 'btc-5m-higher',
            title: 'Will BTC be higher in 5 minutes?',
          },
        },
      ],
    },
    auditEvent: {
      findMany: async ({ where }: { where?: { eventType?: string } }) => {
        if (where?.eventType === 'signal.execution_decision') {
          return [decisionEvent];
        }
        return [];
      },
      create: async ({ data }: { data: { eventType: string; metadata?: Record<string, unknown> } }) => {
        createdAuditEvents.push(data);
        return null;
      },
    },
    signalDecision: {
      findMany: async () => [
        {
          signalId: 'signal-1',
          verdict: 'approved',
          positionSize: 62.4,
          decisionAt: new Date('2026-03-26T00:10:00.000Z'),
        },
      ],
    },
  };

  const job = new CapitalLeakReviewJob(
    prisma as never,
    learningStateStore,
    tradeQualityHistoryStore,
    path.join(rootDir, 'capital-leak'),
  );
  const result = await job.run({
    from: new Date('2026-03-26T00:00:00.000Z'),
    to: new Date('2026-03-26T01:00:00.000Z'),
    now: new Date('2026-03-26T01:05:00.000Z'),
  });
  const persistedScores = await tradeQualityHistoryStore.readLatest(10);

  assert.strictEqual(result.report.tradeCount, 1);
  assert.strictEqual(result.report.totalLeak > 0, true);
  assert.strictEqual(fs.existsSync(result.reportPath), true);
  assert.strictEqual(persistedScores.length, 1);
  assert.strictEqual(persistedScores[0]?.label === 'poor' || persistedScores[0]?.label === 'destructive', true);
  assert.strictEqual(
    createdAuditEvents.some((event) => event.eventType === 'capital.leak_review'),
    true,
  );
}

async function testDeploymentTierCapitalRampChaosReplayAndReadiness(): Promise<void> {
  const tierPolicy = new DeploymentTierPolicyService();
  const capitalRampPolicy = new CapitalRampPolicyService();
  const chaosHarness = new ChaosHarness();
  const readinessService = new ProductionReadinessDashboardService();
  const replayEngine = new ReplayEngine({
    signal: {
      findUnique: async () => ({ id: 's1' }),
    },
    signalDecision: {
      findMany: async () => [{ reasonCode: 'ok' }],
    },
    order: {
      findMany: async () => [],
    },
    auditEvent: {
      findMany: async () => [{ eventType: 'signal.admission_decision' }],
    },
    fill: {
      findMany: async () => [],
    },
  } as never);

  const tier = tierPolicy.evaluate({
    tier: 'scaled_live',
    liveExecutionEnabled: true,
    robustnessPassed: false,
    auditCoverageHealthy: false,
    readinessReady: true,
  });
  const capitalRamp = capitalRampPolicy.evaluate({
    tierAllowsScale: tier.allowNewEntries,
    robustnessPassed: false,
    chaosPassed: false,
    auditCoverageHealthy: false,
    attributionCoverage: 0.2,
    promotionScore: 0.4,
    capitalExposureValidated: false,
  });
  const chaos = chaosHarness.run();
  const replay = await replayEngine.replaySignal('s1');
  const readiness = readinessService.evaluate({
    deploymentTier: tier.tier,
    capitalMultiplier: capitalRamp.capitalMultiplier,
    checks: {
      startup: true,
      streams: false,
      observer: false,
      governance: false,
      robustness: false,
      auditability: false,
      replay: replay.reconstructable,
      chaos: chaos.passed,
      tier: tier.reasons.length === 0,
      capitalRamp: capitalRamp.allowScaling,
      capitalEvidence: false,
    },
    reasons: {
      startup: 'healthy',
      streams: 'stale',
      observer: 'observer_discrepancy_detected',
      governance: 'blocked',
      robustness: 'blocked',
      auditability: 'blocked',
      replay: 'available',
      chaos: 'failed',
      tier: tier.reasons.join('|') || 'healthy',
      capitalRamp: capitalRamp.reasons.join('|') || capitalRamp.stage,
      capitalEvidence: 'capital_exposure_validation_missing',
    },
  });

  assert.strictEqual(tier.allowLiveOrders, false);
  assert.strictEqual(capitalRamp.allowScaling, false);
  assert.strictEqual(Array.isArray(chaos.scenarios), true);
  assert.strictEqual(replay.reconstructable, true);
  assert.strictEqual(readiness.status, 'blocked');
}

async function testHistoricalDatasetLoading(): Promise<void> {
  const dataset = loadHistoricalValidationDataset(
    path.join(
      repoRoot,
      'apps/worker/src/validation/datasets/p23-empirical-validation.dataset.json',
    ),
  );

  assert.strictEqual(dataset.datasetType, 'empirical');
  assert.strictEqual(dataset.observations.length >= 24, true);
  assert.strictEqual(dataset.replayFrames.length > 0, true);
}

async function testWalkForwardEvaluationOnRealData(): Promise<void> {
  const payload = await runP23Validation();

  assert.strictEqual(payload.dataset.datasetType, 'empirical');
  assert.strictEqual(payload.validation.windows.length > 0, true);
  assert.strictEqual(payload.validation.aggregate.windowCount > 0, true);
  assert.strictEqual(payload.evidence.empiricalEvidenceUsed, true);
}

async function testDatasetQualityAcceptsRepairedEmpiricalCoverage(): Promise<void> {
  const dataset = loadHistoricalValidationDataset();
  const built = buildEmpiricalWalkForwardSamples(dataset);
  const report = buildDatasetQualityReport({
    dataset,
    datasetPath: path.join(
      repoRoot,
      'apps/worker/src/validation/datasets/p23-empirical-validation.dataset.json',
    ),
    executableCases: built.executableCases,
    reportPath: path.join(repoRoot, 'artifacts/p23-validation/test-dataset-quality.json'),
  });

  assert.strictEqual(report.verdict, 'accepted');
  assert.strictEqual(report.blockingReasons.includes('replay_frame_count_below_threshold'), false);
  assert.strictEqual(report.blockingReasons.includes('regime_coverage_below_threshold'), false);
  assert.strictEqual(report.blockingReasons.includes('liquidity_coverage_below_threshold'), false);
}

async function testReadinessObserverFlagsInternalVsExternalDivergence(): Promise<void> {
  const now = new Date('2026-03-22T19:00:00.000Z');
  const verdict = evaluateReadinessObserver({
    internalSteps: [
      { name: 'market_stream_live_subscription', ok: true },
      { name: 'user_stream_authenticated_subscription', ok: true },
      { name: 'stream_truth_reconciliation', ok: true },
    ],
    marketHealth: {
      lastEventAt: new Date(now.getTime() - 60_000).toISOString(),
      lastTrafficAt: new Date(now.getTime() - 60_000).toISOString(),
    },
    userHealth: {
      lastEventAt: new Date(now.getTime() - 60_000).toISOString(),
      lastTrafficAt: new Date(now.getTime() - 60_000).toISOString(),
      divergenceDetected: true,
    },
    smokeSuccess: false,
    externalFreshness: { overallVerdict: 'stale' },
    lifecycleSuite: createLifecycleValidationSuite({
      success: false,
      executedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000).toISOString(),
    }),
    marketStaleAfterMs: 5_000,
    userStaleAfterMs: 5_000,
    now,
  });

  assert.strictEqual(verdict.internalHealthy, true);
  assert.strictEqual(verdict.observerHealthy, false);
  assert.strictEqual(verdict.materialDiscrepancy, true);
  assert.strictEqual(
    verdict.discrepancyFlags.includes('market_stream_internal_vs_observer_divergence'),
    true,
  );
  assert.strictEqual(
    verdict.discrepancyFlags.includes('user_stream_internal_vs_observer_divergence'),
    true,
  );
}

async function testCapitalExposureValidationGatesShadowMicroAndLimitedModes(): Promise<void> {
  const lifecycleSuite = createLifecycleValidationSuite();
  const sharedInput = {
    lifecycleSuite,
    readinessSuitePassed: true,
    observerHealthy: true,
    divergenceFailures: 0,
  };

  const shadowReport = buildCapitalExposureValidationReport({
    deploymentTier: 'paper',
    validationMode: 'shadow',
    fills: [],
    executionDiagnostics: [
      {
        expectedEv: 0.05,
        realizedEv: 0.045,
        expectedFee: 0.005,
        realizedFee: 0.005,
        expectedSlippage: 0.004,
        realizedSlippage: 0.004,
        regime: 'illiquid_noisy_book',
        fillRate: 0.9,
      },
    ],
    portfolioSnapshots: [
      {
        bankroll: 100,
        availableCapital: 100,
        capturedAt: new Date('2026-03-22T18:00:00.000Z').toISOString(),
      },
    ],
    ...sharedInput,
  });
  const microReport = buildCapitalExposureValidationReport({
    deploymentTier: 'canary',
    validationMode: 'micro_cap_live',
    fills: [
      {
        price: 0.51,
        size: 10,
        fee: 0.01,
        filledAt: new Date('2026-03-22T18:10:00.000Z').toISOString(),
      },
    ],
    executionDiagnostics: [
      {
        expectedEv: 0.05,
        realizedEv: 0.045,
        expectedFee: 0.005,
        realizedFee: 0.005,
        expectedSlippage: 0.004,
        realizedSlippage: 0.004,
        regime: 'illiquid_noisy_book',
        fillRate: 0.85,
      },
    ],
    portfolioSnapshots: [
      {
        bankroll: 100,
        availableCapital: 100,
        capturedAt: new Date('2026-03-22T18:00:00.000Z').toISOString(),
      },
      {
        bankroll: 100,
        availableCapital: 99,
        capturedAt: new Date('2026-03-22T18:15:00.000Z').toISOString(),
      },
    ],
    ...sharedInput,
  });
  const limitedReport = buildCapitalExposureValidationReport({
    deploymentTier: 'scaled_live',
    validationMode: 'limited_cap_live',
    fills: [
      {
        price: 0.51,
        size: 10,
        fee: 0.01,
        filledAt: new Date('2026-03-22T18:10:00.000Z').toISOString(),
      },
      {
        price: 0.505,
        size: 10,
        fee: 0.01,
        filledAt: new Date('2026-03-22T18:20:00.000Z').toISOString(),
      },
      {
        price: 0.5,
        size: 10,
        fee: 0.01,
        filledAt: new Date('2026-03-22T18:30:00.000Z').toISOString(),
      },
    ],
    executionDiagnostics: [
      {
        expectedEv: 0.05,
        realizedEv: 0.048,
        expectedFee: 0.005,
        realizedFee: 0.005,
        expectedSlippage: 0.004,
        realizedSlippage: 0.004,
        regime: 'illiquid_noisy_book',
        fillRate: 0.85,
      },
      {
        expectedEv: 0.045,
        realizedEv: 0.043,
        expectedFee: 0.005,
        realizedFee: 0.005,
        expectedSlippage: 0.004,
        realizedSlippage: 0.004,
        regime: 'illiquid_noisy_book',
        fillRate: 0.82,
      },
      {
        expectedEv: 0.04,
        realizedEv: 0.039,
        expectedFee: 0.005,
        realizedFee: 0.005,
        expectedSlippage: 0.004,
        realizedSlippage: 0.004,
        regime: 'illiquid_noisy_book',
        fillRate: 0.8,
      },
    ],
    portfolioSnapshots: [
      {
        bankroll: 100,
        availableCapital: 100,
        capturedAt: new Date('2026-03-22T18:00:00.000Z').toISOString(),
      },
      {
        bankroll: 100,
        availableCapital: 99,
        capturedAt: new Date('2026-03-22T18:15:00.000Z').toISOString(),
      },
      {
        bankroll: 100,
        availableCapital: 98,
        capturedAt: new Date('2026-03-22T18:30:00.000Z').toISOString(),
      },
    ],
    ...sharedInput,
  });

  assert.strictEqual(shadowReport.stage, 'shadow_validated');
  assert.strictEqual(shadowReport.allowRequestedMode, true);
  assert.strictEqual(microReport.stage, 'micro_cap_validated');
  assert.strictEqual(microReport.allowRequestedMode, true);
  assert.strictEqual(limitedReport.stage, 'limited_cap_validated');
  assert.strictEqual(limitedReport.allowRequestedMode, true);
  assert.strictEqual(limitedReport.allowLiveScale, true);
}

async function testChaosHarnessCoversAdversarialTimingAndSoak(): Promise<void> {
  const result = new ChaosHarness().run({ iterations: 3, now: new Date('2026-03-22T19:00:00.000Z') });

  assert.strictEqual(result.passed, true);
  assert.strictEqual(result.scenarios.length >= 10, true);
  assert.strictEqual(result.soak.enabled, true);
  assert.strictEqual(result.soak.iterations, 3);
  assert.strictEqual(result.soak.passedIterations, 3);
  assert.strictEqual(result.classificationSummary['timing-level'] >= 1, true);
  assert.strictEqual(result.classificationSummary['network-level'] >= 1, true);
  assert.strictEqual(result.classificationSummary['persistence-level'] >= 1, true);
}

async function testRegimeHoldoutBehaviorUsesActualObservations(): Promise<void> {
  const dataset = loadHistoricalValidationDataset();
  const built = buildEmpiricalWalkForwardSamples(dataset);
  const holdouts = evaluateRegimeHoldouts(built.executableCases);

  assert.strictEqual(holdouts.length > 0, true);
  assert.strictEqual(holdouts.every((entry) => entry.sampleCount > 0), true);
}

async function testExecutableEdgeScoringWithRealFrictions(): Promise<void> {
  const dataset = loadHistoricalValidationDataset();
  const built = buildEmpiricalWalkForwardSamples(dataset);
  const executableEdge = evaluateExecutableEdgeOnHistoricalCases(
    built.executableCases,
  );

  assert.strictEqual(executableEdge.caseCount > 0, true);
  assert.strictEqual(executableEdge.scenarios.length >= 4, true);
  assert.strictEqual(
    executableEdge.scenarios.every((scenario) => Number.isFinite(scenario.averageNetEdge)),
    true,
  );
}

async function testCalibrationAgainstRealizedOutcomes(): Promise<void> {
  const payload = await runP23Validation();

  assert.strictEqual(payload.calibrationAudit.bucketCount > 0, true);
  assert.strictEqual(Number.isFinite(payload.calibrationAudit.maxGap), true);
  assert.strictEqual(payload.validation.calibration.length > 0, true);
}

async function testValidationFailsWhenOnlySyntheticEvidenceIsAvailable(): Promise<void> {
  const syntheticDatasetPath = path.join(
    repoRoot,
    'apps/worker/src/validation/datasets/p23-synthetic-only.dataset.json',
  );
  fs.writeFileSync(
    syntheticDatasetPath,
    JSON.stringify(
      {
        datasetType: 'synthetic',
        datasetVersion: 'synthetic-only-test',
        capturedAt: new Date().toISOString(),
        staleAfterHours: 1,
        provenance: {},
        replayFrames: [],
        observations: [],
      },
      null,
      2,
    ),
  );

  let errorMessage = '';
  try {
    await runP23Validation({ datasetPath: syntheticDatasetPath });
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    fs.unlinkSync(syntheticDatasetPath);
  }

  assert.strictEqual(
    errorMessage.startsWith('historical_validation_dataset_not_empirical'),
    true,
  );
}

async function testCanonicalGammaParserAcceptsValidMarket(): Promise<void> {
  const parsed = parseGammaMarket(buildGammaMarketFixture(), 'test_gamma_market');

  assert.strictEqual(parsed.id, 'm1');
  assert.strictEqual(parsed.tokenIdYes, 'yes1');
  assert.strictEqual(parsed.tokenIdNo, 'no1');
  assert.strictEqual(parsed.enableOrderBook, true);
}

async function testCanonicalGammaParserRejectsMalformedMarket(): Promise<void> {
  let error: unknown = null;
  try {
    parseGammaMarket(
      buildGammaMarketFixture({
        tokens: [{ token_id: 'yes1', outcome: 'Yes' }],
        clobTokenIds: ['yes1'],
      }),
      'test_gamma_market_invalid',
    );
  } catch (caught) {
    error = caught;
  }

  assert.strictEqual(error instanceof VenueParseError, true);
}

async function testCanonicalOrderbookParserRejectsMalformedPayload(): Promise<void> {
  let error: unknown = null;
  try {
    parseOrderbookPayload(
      'yes1',
      buildOrderbookPayloadFixture({
        tick_size: null,
      }),
      'test_orderbook_invalid',
    );
  } catch (caught) {
    error = caught;
  }

  assert.strictEqual(error instanceof VenueParseError, true);
}

async function testCanonicalOpenOrdersParserRejectsUnknownStatus(): Promise<void> {
  let error: unknown = null;
  try {
    parseOpenOrdersPayload(
      [buildOpenOrderPayloadFixture({ status: 'mystery_status' })],
      'test_open_orders_invalid',
    );
  } catch (caught) {
    error = caught;
  }

  assert.strictEqual(error instanceof VenueParseError, true);
}

async function testCanonicalTradeAndBalanceParsersRejectMalformedPayloads(): Promise<void> {
  let tradeError: unknown = null;
  let balanceError: unknown = null;

  try {
    parseTradesPayload(
      [buildTradePayloadFixture({ asset_id: null })],
      'test_trades_invalid',
    );
  } catch (caught) {
    tradeError = caught;
  }

  try {
    parseBalanceAllowancePayload(
      buildBalanceAllowancePayloadFixture({ allowance: 'NaN' }),
      'test_balance_invalid',
    );
  } catch (caught) {
    balanceError = caught;
  }

  assert.strictEqual(tradeError instanceof VenueParseError, true);
  assert.strictEqual(balanceError instanceof VenueParseError, true);
}

async function runLifecycleScenarioAssertion(
  scenario: Parameters<typeof runLiveOrderLifecycleScenario>[0],
): Promise<Awaited<ReturnType<typeof runLiveOrderLifecycleScenario>>> {
  const evidence = await runLiveOrderLifecycleScenario(scenario);

  assert.strictEqual(evidence.passed, true);
  assert.strictEqual(evidence.noDuplicateExposure, true);
  assert.strictEqual(evidence.runtimeSafetyStayedFailClosed, true);
  assert.strictEqual(Array.isArray(evidence.submitAttempts), true);
  assert.strictEqual(typeof evidence.finalTruth, 'object');

  return evidence;
}

function lifecycleFinalTruthValue(
  evidence: Awaited<ReturnType<typeof runLiveOrderLifecycleScenario>>,
  key: string,
): unknown {
  return (evidence.finalTruth as Record<string, unknown>)[key];
}

function lifecycleLocalOrder(
  evidence: Awaited<ReturnType<typeof runLiveOrderLifecycleScenario>>,
  index = 0,
): Record<string, unknown> | undefined {
  return (lifecycleFinalTruthValue(evidence, 'localOrders') as Array<Record<string, unknown>>)[index];
}

function lifecycleLocalFills(
  evidence: Awaited<ReturnType<typeof runLiveOrderLifecycleScenario>>,
): Array<Record<string, unknown>> {
  return lifecycleFinalTruthValue(evidence, 'localFills') as Array<Record<string, unknown>>;
}

function lifecycleReplay(
  evidence: Awaited<ReturnType<typeof runLiveOrderLifecycleScenario>>,
): Record<string, unknown> {
  return lifecycleFinalTruthValue(evidence, 'replay') as Record<string, unknown>;
}

async function testLifecycleSubmitTimeoutUncertainVenueState(): Promise<void> {
  const evidence = await runLifecycleScenarioAssertion(
    'submit_timeout_uncertain_venue_state',
  );

  assert.strictEqual(evidence.submitAttempts.length, 1);
  assert.strictEqual(
    (lifecycleFinalTruthValue(evidence, 'localOrders') as unknown[]).length,
    0,
  );
  assert.strictEqual(
    (evidence.reconciliation[0]?.result as { reasonCode?: string } | undefined)?.reasonCode,
    'ghost_exposure_detected',
  );
}

async function testLifecyclePartialFillReconnect(): Promise<void> {
  const evidence = await runLifecycleScenarioAssertion(
    'partial_fill_followed_by_reconnect',
  );

  assert.strictEqual(lifecycleLocalOrder(evidence)?.status, 'partially_filled');
  assert.strictEqual(lifecycleLocalFills(evidence).length, 1);
}

async function testLifecycleCancelAcknowledgedLate(): Promise<void> {
  const evidence = await runLifecycleScenarioAssertion('cancel_acknowledged_late');
  const afterCancelRequest = evidence.botBelief.find(
    (snapshot) => snapshot.stage === 'after_cancel_request',
  );
  const orderAfterCancelRequest = afterCancelRequest?.localOrders[0] as
    | Record<string, unknown>
    | undefined;

  assert.strictEqual(orderAfterCancelRequest?.status, 'acknowledged');
  assert.strictEqual(orderAfterCancelRequest?.lastVenueStatus, 'cancel_requested');
  assert.strictEqual(lifecycleLocalOrder(evidence)?.status, 'canceled');
}

async function testLifecycleGhostOpenOrderAfterRestart(): Promise<void> {
  const evidence = await runLifecycleScenarioAssertion('ghost_open_order_after_restart');

  assert.strictEqual(
    (evidence.reconciliation[0]?.result as { ghostExposureDetected?: boolean } | undefined)
      ?.ghostExposureDetected,
    true,
  );
  assert.strictEqual(
    (evidence.reconciliation[1]?.result as { ghostExposureDetected?: boolean } | undefined)
      ?.ghostExposureDetected,
    false,
  );
}

async function testLifecycleDuplicateDelayedFillEvents(): Promise<void> {
  const evidence = await runLifecycleScenarioAssertion(
    'duplicate_or_delayed_fill_events',
  );

  assert.strictEqual(lifecycleLocalFills(evidence).length, 1);
  assert.strictEqual(
    (evidence.reconciliation[1]?.result as { fillsInserted?: number } | undefined)?.fillsInserted,
    0,
  );
}

async function testLifecycleOrderVisibilityMismatch(): Promise<void> {
  const evidence = await runLifecycleScenarioAssertion(
    'order_visibility_mismatch_between_rest_and_stream',
  );

  assert.strictEqual(
    evidence.botBelief[0]?.userStream?.divergenceDetected,
    true,
  );
  assert.deepStrictEqual(
    lifecycleFinalTruthValue(evidence, 'userStreamOpenOrders'),
    ['venue-order-1'],
  );
}

async function testLifecycleStaleLocalAssumptionsAfterCrash(): Promise<void> {
  const evidence = await runLifecycleScenarioAssertion(
    'stale_local_assumptions_after_process_crash',
  );

  assert.strictEqual(
    (evidence.reconciliation[0]?.result as { recovered?: boolean } | undefined)?.recovered,
    true,
  );
  assert.strictEqual(
    (evidence.reconciliation[0]?.result as { fillsInserted?: number } | undefined)?.fillsInserted,
    1,
  );
  assert.strictEqual(lifecycleLocalOrder(evidence)?.status, 'filled');
}

async function testLifecycleSuitePersistsEvidenceAndReplayIncludesIt(): Promise<void> {
  const result = await runLiveOrderLifecycleValidationSuite();

  assert.strictEqual(result.success, true);
  assert.strictEqual(fs.existsSync(result.evidencePath), true);
  assert.strictEqual(
    result.scenarios.every((scenario) => {
      const replay = lifecycleReplay(scenario);
      const lifecycleEvidence = replay.lifecycleEvidence as unknown[] | undefined;
      return Array.isArray(lifecycleEvidence) && lifecycleEvidence.length >= 1;
    }),
    true,
  );
}

/**
 * Token-aware execution tests
 */

async function testExecuteBuyYesUsesYesToken(): Promise<void> {
  let createdOrder: Record<string, unknown> | null = null;
  let auditMetadata: Record<string, unknown> | null = null;

  const prisma = {
    signal: {
      findMany: async () => [
        createExecutionSignal({
          tokenId: 'yes1',
          outcome: 'YES',
          action: 'ENTER',
          side: 'BUY',
        }),
      ],
      update: async () => null,
    },
    signalDecision: {
      findFirst: async () => ({ positionSize: 10, verdict: 'approved' }),
      create: async () => null,
    },
    market: {
      findUnique: async () => createMarket(),
    },
    marketSnapshot: {
      findFirst: async () => createFreshSnapshot(),
    },
    orderbook: {
      findFirst: async ({ where }: { where: { tokenId: string } }) => {
        assert.strictEqual(where.tokenId, 'yes1');
        return createFreshOrderbook();
      },
    },
    order: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdOrder = data;
      },
    },
    auditEvent: {
      create: async ({ data }: { data: { metadata: Record<string, unknown> } }) => {
        if ((data as Record<string, unknown>).eventType === 'order.submitted') {
          auditMetadata = data.metadata;
        }
      },
    },
    portfolioSnapshot: {
      findFirst: async () => createFreshPortfolioSnapshot(),
    },
    reconciliationCheckpoint: {
      findFirst: async ({ where }: { where: { source: string } }) =>
        createFreshReconciliationCheckpoint(where.source),
    },
    botRuntimeStatus: {
      findUnique: async () => createFreshRuntimeStatus(),
    },
    liveConfig: {
      findUnique: async () => ({ id: 'live', noTradeWindowSeconds: 30 }),
    },
  };

  const job = new ExecuteOrdersJob(prisma as never);
  stubExternalPortfolioService(
    job,
    createExternalPortfolioSnapshot({
      inventories: [
        createExternalInventorySnapshot({
          tokenId: 'yes1',
          marketId: 'm1',
          outcome: 'YES',
          balance: 100,
          allowance: 100,
          reservedQuantity: 0,
          freeQuantityBeforeAllowance: 100,
          freeQuantityAfterAllowance: 100,
          tradableSellHeadroom: 0,
          availableQuantity: 0,
          positionQuantity: 0,
          markPrice: 0.51,
          markedValue: 51,
        }),
      ],
    }),
  );
  (job as any).tradingClient = {
    postOrder: async () => ({
      success: true,
      orderId: 'venue-o2',
      status: 'acknowledged',
    }),
  };
  const result = await job.run({ canSubmit: () => true });

  assert.strictEqual(result.submitted, 1);
  assert.ok(createdOrder);
  assert.strictEqual(createdOrder?.['tokenId'], 'yes1');
  assert.strictEqual(createdOrder?.['side'], 'BUY');
  assert.strictEqual(auditMetadata?.['tokenId'], 'yes1');
  assert.strictEqual(auditMetadata?.['outcome'], 'YES');
  assert.strictEqual(auditMetadata?.['action'], 'ENTER');
}

async function testExecuteBuyNoUsesNoToken(): Promise<void> {
  let createdOrder: Record<string, unknown> | null = null;
  let orderbookTokenId: string | null = null;

  const prisma = {
    signal: {
      findMany: async () => [
        createExecutionSignal({
          tokenId: 'no1',
          outcome: 'NO',
          action: 'ENTER',
          side: 'BUY',
        }),
      ],
      update: async () => null,
    },
    signalDecision: {
      findFirst: async () => ({ positionSize: 5, verdict: 'approved' }),
      create: async () => null,
    },
    market: {
      findUnique: async () => createMarket(),
    },
    marketSnapshot: {
      findFirst: async () => createFreshSnapshot(),
    },
    orderbook: {
      findFirst: async ({ where }: { where: { tokenId: string } }) => {
        orderbookTokenId = where.tokenId;
        return createFreshOrderbook();
      },
    },
    order: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdOrder = data;
      },
    },
    auditEvent: {
      create: async () => null,
    },
    portfolioSnapshot: {
      findFirst: async () => createFreshPortfolioSnapshot(),
    },
    reconciliationCheckpoint: {
      findFirst: async ({ where }: { where: { source: string } }) =>
        createFreshReconciliationCheckpoint(where.source),
    },
    botRuntimeStatus: {
      findUnique: async () => createFreshRuntimeStatus(),
    },
    liveConfig: {
      findUnique: async () => ({ id: 'live', noTradeWindowSeconds: 30 }),
    },
  };

  const job = new ExecuteOrdersJob(prisma as never);
  stubExternalPortfolioService(
    job,
    createExternalPortfolioSnapshot({
      inventories: [
        createExternalInventorySnapshot({
          tokenId: 'no1',
          marketId: 'm1',
          outcome: 'NO',
          balance: 100,
          allowance: 100,
          reservedQuantity: 0,
          freeQuantityBeforeAllowance: 100,
          freeQuantityAfterAllowance: 100,
          tradableSellHeadroom: 0,
          availableQuantity: 0,
          positionQuantity: 0,
          markPrice: 0.49,
          markedValue: 49,
        }),
      ],
    }),
  );
  (job as any).tradingClient = {
    postOrder: async () => ({
      success: true,
      orderId: 'venue-o3',
      status: 'acknowledged',
    }),
  };
  const result = await job.run({ canSubmit: () => true });

  assert.strictEqual(result.submitted, 1);
  assert.strictEqual(orderbookTokenId, 'no1');
  assert.strictEqual(createdOrder?.['tokenId'], 'no1');
  assert.strictEqual(createdOrder?.['side'], 'BUY');
}

async function testExecuteSellYesInventoryUsesYesToken(): Promise<void> {
  let createdOrder: Record<string, unknown> | null = null;
  let orderbookTokenId: string | null = null;
  let rejectionReason: string | null = null;

  const prisma = {
    signal: {
      findMany: async () => [
        createExecutionSignal({
          tokenId: 'yes1',
          outcome: 'YES',
          action: 'EXIT',
          side: 'SELL',
        }),
      ],
      update: async () => null,
    },
    signalDecision: {
      findFirst: async () => ({ positionSize: 5, verdict: 'approved' }),
      create: async ({ data }: { data: { reasonCode: string } }) => {
        rejectionReason = data.reasonCode;
      },
    },
    market: {
      findUnique: async () => createMarket(),
    },
    marketSnapshot: {
      findFirst: async () => createFreshSnapshot(),
    },
    orderbook: {
      findFirst: async ({ where }: { where: { tokenId: string } }) => {
        orderbookTokenId = where.tokenId;
        return createFreshOrderbook();
      },
    },
    order: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdOrder = data;
      },
    },
    auditEvent: {
      create: async () => null,
    },
    portfolioSnapshot: {
      findFirst: async () => createFreshPortfolioSnapshot(),
    },
    reconciliationCheckpoint: {
      findFirst: async ({ where }: { where: { source: string } }) =>
        createFreshReconciliationCheckpoint(where.source),
    },
    botRuntimeStatus: {
      findUnique: async () => createFreshRuntimeStatus(),
    },
    liveConfig: {
      findUnique: async () => ({ id: 'live', noTradeWindowSeconds: 30 }),
    },
  };

  const job = new ExecuteOrdersJob(prisma as never);
  stubExternalPortfolioService(
    job,
    createExternalPortfolioSnapshot({
      inventories: [
        createExternalInventorySnapshot({
          tokenId: 'yes1',
          marketId: 'm1',
          outcome: 'YES',
          balance: 100,
          allowance: 100,
          reservedQuantity: 0,
          freeQuantityBeforeAllowance: 100,
          freeQuantityAfterAllowance: 100,
          tradableSellHeadroom: 100,
          availableQuantity: 100,
          positionQuantity: 100,
          markPrice: 0.51,
          markedValue: 51,
        }),
      ],
    }),
  );
  (job as any).tradingClient = {
    postOrder: async () => ({
      success: true,
      orderId: 'venue-o4',
      status: 'acknowledged',
    }),
  };
  const result = await job.run({ canSubmit: () => true });

  assert.strictEqual(result.submitted, 1, rejectionReason ?? 'expected submit');
  assert.strictEqual(orderbookTokenId, 'yes1');
  assert.strictEqual(createdOrder?.['tokenId'], 'yes1');
  assert.strictEqual(createdOrder?.['side'], 'SELL');
}

async function testExecuteSellNoInventoryUsesNoToken(): Promise<void> {
  let createdOrder: Record<string, unknown> | null = null;
  let orderbookTokenId: string | null = null;
  let rejectionReason: string | null = null;

  const prisma = {
    signal: {
      findMany: async () => [
        createExecutionSignal({
          tokenId: 'no1',
          outcome: 'NO',
          action: 'EXIT',
          side: 'SELL',
        }),
      ],
      update: async () => null,
    },
    signalDecision: {
      findFirst: async () => ({ positionSize: 5, verdict: 'approved' }),
      create: async ({ data }: { data: { reasonCode: string } }) => {
        rejectionReason = data.reasonCode;
      },
    },
    market: {
      findUnique: async () => createMarket(),
    },
    marketSnapshot: {
      findFirst: async () => createFreshSnapshot(),
    },
    orderbook: {
      findFirst: async ({ where }: { where: { tokenId: string } }) => {
        orderbookTokenId = where.tokenId;
        return createFreshOrderbook();
      },
    },
    order: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdOrder = data;
      },
    },
    auditEvent: {
      create: async () => null,
    },
    portfolioSnapshot: {
      findFirst: async () => createFreshPortfolioSnapshot(),
    },
    reconciliationCheckpoint: {
      findFirst: async ({ where }: { where: { source: string } }) =>
        createFreshReconciliationCheckpoint(where.source),
    },
    botRuntimeStatus: {
      findUnique: async () => createFreshRuntimeStatus(),
    },
    liveConfig: {
      findUnique: async () => ({ id: 'live', noTradeWindowSeconds: 30 }),
    },
  };

  const job = new ExecuteOrdersJob(prisma as never);
  stubExternalPortfolioService(
    job,
    createExternalPortfolioSnapshot({
      inventories: [
        createExternalInventorySnapshot({
          tokenId: 'no1',
          marketId: 'm1',
          outcome: 'NO',
          balance: 100,
          allowance: 100,
          reservedQuantity: 0,
          freeQuantityBeforeAllowance: 100,
          freeQuantityAfterAllowance: 100,
          tradableSellHeadroom: 100,
          availableQuantity: 100,
          positionQuantity: 100,
          markPrice: 0.49,
          markedValue: 49,
        }),
      ],
    }),
  );
  (job as any).tradingClient = {
    postOrder: async () => ({
      success: true,
      orderId: 'venue-o4',
      status: 'acknowledged',
    }),
  };
  const result = await job.run({ canSubmit: () => true });

  assert.strictEqual(result.submitted, 1, rejectionReason ?? 'expected submit');
  assert.strictEqual(orderbookTokenId, 'no1');
  assert.strictEqual(createdOrder?.['tokenId'], 'no1');
  assert.strictEqual(createdOrder?.['side'], 'SELL');
}

async function testRiskRejectsSellWhenNoInventoryExists(): Promise<void> {
  let signalStatus: 'approved' | 'rejected' = 'approved';
  let rejectionReason: string | null = null;

  const signal = createExecutionSignal({
    tokenId: 'yes1',
    outcome: 'YES',
    action: 'EXIT',
    side: 'SELL',
  });

  const prisma = {
    signal: {
      findMany: async () => (signalStatus === 'approved' ? [signal] : []),
      update: async ({ data }: { data: { status: 'approved' | 'rejected' } }) => {
        signalStatus = data.status;
      },
    },
    signalDecision: {
      findFirst: async () => ({ positionSize: 10 }),
      create: async ({ data }: { data: { reasonCode: string } }) => {
        rejectionReason = data.reasonCode;
      },
    },
    market: {
      findUnique: async () => createMarket(),
    },
    orderbook: {
      findFirst: async () => createFreshOrderbook(),
    },
    marketSnapshot: {
      findFirst: async () => ({
        observedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    },
    order: {
      findFirst: async () => null,
    },
    position: {
      findFirst: async () => null,
    },
  };

  const riskAgent = new RiskVerificationAgent(
    {
      run: async () => ({
        approved: 1,
        rejected: 0,
        killSwitchTriggered: false,
        killSwitchReason: null,
      }),
    } as never,
    prisma as never,
  );

  const result = await riskAgent.run(createRuntimeConfig());

  assert.strictEqual(result.allowEntries, false);
  assert.strictEqual(result.finalVetoTriggered, true);
  assert.strictEqual(signalStatus, 'rejected');
  assert.strictEqual(rejectionReason, 'risk_final_veto_position_to_reduce_missing');
}

/**
 * New venue validation tests
 */

async function testExecutionSemanticsPolicySelectsExplicitOrderStyles(): Promise<void> {
  const policy = new ExecutionSemanticsPolicy();

  const passive = policy.evaluate({
    action: 'ENTER',
    urgency: 'low',
    size: 5,
    executableDepth: 10,
    expiryAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    noTradeWindowSeconds: 30,
  });
  const timeBoxed = policy.evaluate({
    action: 'ENTER',
    urgency: 'medium',
    size: 5,
    executableDepth: 10,
    expiryAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    noTradeWindowSeconds: 30,
  });
  const allOrNothing = policy.evaluate({
    action: 'ENTER',
    urgency: 'high',
    size: 5,
    executableDepth: 10,
    expiryAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    noTradeWindowSeconds: 30,
    partialFillTolerance: 'all_or_nothing',
  });
  const partial = policy.evaluate({
    action: 'EXIT',
    urgency: 'high',
    size: 5,
    executableDepth: 2,
    expiryAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    noTradeWindowSeconds: 30,
  });

  assert.strictEqual(passive.orderType, 'GTC');
  assert.strictEqual(timeBoxed.orderType, 'GTD');
  assert.strictEqual(allOrNothing.orderType, 'FOK');
  assert.strictEqual(partial.orderType, 'FAK');
  assert.strictEqual(timeBoxed.timeDiscipline, 'deadline');
  assert.strictEqual(allOrNothing.route, 'taker');
}

async function testAdaptiveMakerTakerPolicyUsesLearnedPolicyVersion(): Promise<void> {
  const policy = new AdaptiveMakerTakerPolicy();
  const decision = policy.decide({
    activePolicyVersion: {
      versionId: 'execution-policy:test:v1',
      contextKey: 'execution:strategy:variant:strategy-live-1|regime:trend_burst',
      strategyVariantId: 'variant:strategy-live-1',
      regime: 'trend_burst',
      mode: 'taker_preferred',
      recommendedRoute: 'taker',
      recommendedExecutionStyle: 'cross',
      sampleCount: 8,
      makerFillRateAssumption: 0.2,
      takerFillRateAssumption: 0.95,
      expectedFillDelayMs: 30_000,
      expectedSlippage: 0.004,
      adverseSelectionScore: 0.7,
      cancelSuccessRate: 0.5,
      partialFillRate: 0.25,
      health: 'degraded',
      rationale: ['maker_adverse_selection_detected'],
      sourceCycleId: 'cycle-1',
      supersedesVersionId: null,
      createdAt: '2026-03-25T00:00:00.000Z',
    },
    marketContext: {
      strategyVariantId: 'variant:strategy-live-1',
      regime: 'trend_burst',
      action: 'ENTER',
      urgency: 'low',
      spread: 0.01,
      topLevelDepth: 50,
    },
  });

  assert.strictEqual(decision.route, 'taker');
  assert.strictEqual(decision.executionStyle, 'cross');
  assert.strictEqual(decision.policyVersionId, 'execution-policy:test:v1');
  assert.strictEqual(
    decision.rationale.includes('learned_taker_preference_active') ||
      decision.rationale.includes('learned_execution_risk_overrides_resting'),
    true,
  );
}

async function testVenueValidationRejectsShortGtdExpiration(): Promise<void> {
  const validator = new VenueOrderValidator();

  const result = validator.validate({
    tokenId: 'yes1',
    side: 'BUY',
    price: 0.5,
    size: 2,
    orderType: 'GTD',
    metadata: {
      tickSize: 0.01,
      minOrderSize: 1,
      negRisk: false,
    },
    executionStyle: 'rest',
    expiration: new Date(Date.now() + 30_000).toISOString(),
    postOnly: false,
  });

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reasonCode, 'gtd_expiration_below_security_threshold');
}

async function testCancelReplacePolicyAbandonsAdverseMove(): Promise<void> {
  const policy = new CancelReplacePolicy();

  const result = policy.evaluate({
    action: 'ENTER',
    route: 'maker',
    signalAgeMs: 5_000,
    maxSignalAgeMs: 45_000,
    ageMs: 6_000,
    waitingBeforeReplaceMs: 3_000,
    maxRestingAgeMs: 20_000,
    repricesUsed: 0,
    maxRepricesPerSignal: 2,
    fillProbability: 0.8,
    minimumFillProbability: 0.3,
    priceDriftBps: 5,
    adverseMoveBps: 25,
    maxAllowedPriceDriftBps: 10,
    maxAllowedAdverseMoveBps: 20,
  });

  assert.strictEqual(result.action, 'cancel');
  assert.strictEqual(result.lifecycleState, 'abandoned');
  assert.strictEqual(result.reasonCode, 'no_chase_after_adverse_move');
}

async function testDuplicateExposureGuardBlocksWorkingOrders(): Promise<void> {
  const guard = new DuplicateExposureGuard();

  const result = guard.evaluate({
    marketId: 'm1',
    tokenId: 'yes1',
    side: 'BUY',
    inventoryEffect: 'INCREASE',
    desiredSize: 5,
    currentPositionSize: 0,
    localWorkingOrders: [],
    venueWorkingOrders: [
      {
        id: 'venue-open-1',
        tokenId: 'yes1',
        side: 'BUY',
        size: 3,
        matchedSize: 0,
      },
    ],
  });

  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reasonCode, 'duplicate_working_order_exposure');
}

async function testVenueFeeModelUsesLiveAndFallbackInputs(): Promise<void> {
  const model = new VenueFeeModel();

  const live = model.evaluate({
    tokenId: 'yes1',
    route: 'taker',
    price: 0.5,
    size: 10,
    venueFeeRateBps: 12,
    venueFeeFetchedAt: new Date().toISOString(),
    source: 'venue_live',
  });
  const fallback = model.evaluate({
    tokenId: 'yes1',
    route: 'maker',
    price: 0.5,
    size: 10,
    venueFeeRateBps: null,
    venueFeeFetchedAt: null,
    fallbackFeeRateBps: 20,
  });

  assert.strictEqual(live.source, 'venue_live');
  assert.strictEqual(live.fresh, true);
  assert.strictEqual(fallback.source, 'fallback');
  assert.strictEqual(fallback.feeRateBps, 20);
}

async function testMakerQualityPolicyModelsRewardsAwarePassiveQuote(): Promise<void> {
  const policy = new MakerQualityPolicy();

  const result = policy.evaluate({
    route: 'maker',
    tokenId: 'yes1',
    side: 'BUY',
    price: 0.5,
    size: 6,
    bestBid: 0.5,
    bestAsk: 0.52,
    tickSize: 0.01,
    rewardsMarkets: [
      {
        conditionId: 'cond-1',
        rewardsMaxSpread: 0.03,
        rewardsMinSize: 5,
        tokens: [{ tokenId: 'yes1', outcome: 'YES', price: 0.5 }],
      },
    ],
  });

  assert.strictEqual(result.applicable, true);
  assert.strictEqual(result.scoringRelevant, true);
  assert.strictEqual(result.eligibleForRewards, true);
  assert.strictEqual(result.makerEfficient, true);
}

async function testNegativeRiskPolicyExcludesNegRiskMarkets(): Promise<void> {
  const policy = new NegativeRiskPolicy();

  const result = policy.evaluate({
    negRisk: true,
  });

  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reasonCode, 'negative_risk_market_excluded');
}

async function testVenueValidationRejectsPriceNotOnTick(): Promise<void> {
  const validator = new VenueOrderValidator();

  const result = validator.validate({
    tokenId: 'yes1',
    side: 'BUY',
    price: 0.505,
    size: 2,
    orderType: 'GTC',
    metadata: {
      tickSize: 0.01,
      minOrderSize: 1,
      negRisk: false,
    },
    executionStyle: 'rest',
    expiration: null,
    postOnly: false,
  });

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reasonCode, 'price_not_on_tick');
}

async function testVenueValidationRejectsSizeBelowMinOrderSize(): Promise<void> {
  const validator = new VenueOrderValidator();

  const result = validator.validate({
    tokenId: 'yes1',
    side: 'BUY',
    price: 0.5,
    size: 0.5,
    orderType: 'GTC',
    metadata: {
      tickSize: 0.01,
      minOrderSize: 1,
      negRisk: false,
    },
    executionStyle: 'rest',
    expiration: null,
    postOnly: false,
  });

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reasonCode, 'size_below_min_order_size');
}

async function testVenueValidationAllowsValidGtc(): Promise<void> {
  const validator = new VenueOrderValidator();

  const result = validator.validate({
    tokenId: 'yes1',
    side: 'BUY',
    price: 0.5,
    size: 2,
    orderType: 'GTC',
    metadata: {
      tickSize: 0.01,
      minOrderSize: 1,
      negRisk: false,
    },
    executionStyle: 'rest',
    expiration: null,
    postOnly: false,
  });

  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.reasonCode, null);
}

async function testVenueValidationAllowsValidGtd(): Promise<void> {
  const validator = new VenueOrderValidator();

  const result = validator.validate({
    tokenId: 'yes1',
    side: 'BUY',
    price: 0.5,
    size: 2,
    orderType: 'GTD',
    metadata: {
      tickSize: 0.01,
      minOrderSize: 1,
      negRisk: false,
    },
    executionStyle: 'rest',
    expiration: new Date(Date.now() + 60_000).toISOString(),
    postOnly: false,
  });

  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.reasonCode, null);
}

async function testVenueValidationAllowsValidFok(): Promise<void> {
  const validator = new VenueOrderValidator();

  const result = validator.validate({
    tokenId: 'yes1',
    side: 'BUY',
    price: 0.5,
    size: 2,
    orderType: 'FOK',
    metadata: {
      tickSize: 0.01,
      minOrderSize: 1,
      negRisk: false,
    },
    executionStyle: 'cross',
    expiration: null,
    postOnly: false,
  });

  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.reasonCode, null);
}

async function testVenueValidationAllowsValidFak(): Promise<void> {
  const validator = new VenueOrderValidator();

  const result = validator.validate({
    tokenId: 'yes1',
    side: 'BUY',
    price: 0.5,
    size: 2,
    orderType: 'FAK',
    metadata: {
      tickSize: 0.01,
      minOrderSize: 1,
      negRisk: false,
    },
    executionStyle: 'cross',
    expiration: null,
    postOnly: false,
  });

  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.reasonCode, null);
}

async function testVenueValidationRejectsUnsupportedOrderType(): Promise<void> {
  const validator = new VenueOrderValidator();

  const result = validator.validate({
    tokenId: 'yes1',
    side: 'BUY',
    price: 0.5,
    size: 2,
    orderType: 'IOC' as never,
    metadata: {
      tickSize: 0.01,
      minOrderSize: 1,
      negRisk: false,
    },
    executionStyle: 'cross',
    expiration: null,
    postOnly: false,
  });

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reasonCode, 'unsupported_order_type');
}

async function testVenueValidationRejectsMissingMetadata(): Promise<void> {
  const validator = new VenueOrderValidator();

  const result = validator.validate({
    tokenId: 'yes1',
    side: 'BUY',
    price: 0.5,
    size: 2,
    orderType: 'GTC',
    metadata: {
      tickSize: null,
      minOrderSize: null,
      negRisk: false,
    },
    executionStyle: 'rest',
    expiration: null,
    postOnly: false,
  });

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reasonCode, 'tick_size_missing');
}

async function testExecutionRejectsStaleOrderbookMetadata(): Promise<void> {
  let rejectedReason: string | null = null;
  let orderCreates = 0;

  const prisma = {
    signal: {
      findMany: async () => [createExecutionSignal()],
      update: async () => null,
    },
    signalDecision: {
      findFirst: async () => ({ positionSize: 10, verdict: 'approved' }),
      create: async ({ data }: { data: { reasonCode: string } }) => {
        rejectedReason = data.reasonCode;
      },
    },
    market: {
      findUnique: async () => createMarket(),
    },
    marketSnapshot: {
      findFirst: async () => createFreshSnapshot(),
    },
    orderbook: {
      findFirst: async () =>
        createFreshOrderbook({
          observedAt: new Date(Date.now() - 10 * 60_000),
        }),
    },
    order: {
      findFirst: async () => null,
      create: async () => {
        orderCreates += 1;
      },
    },
    auditEvent: {
      create: async () => null,
    },
    portfolioSnapshot: {
      findFirst: async () => createFreshPortfolioSnapshot(),
    },
    reconciliationCheckpoint: {
      findFirst: async ({ where }: { where: { source: string } }) =>
        createFreshReconciliationCheckpoint(where.source),
    },
    botRuntimeStatus: {
      findUnique: async () => createFreshRuntimeStatus(),
    },
    liveConfig: {
      findUnique: async () => ({ id: 'live', noTradeWindowSeconds: 30 }),
    },
  };

  const job = new ExecuteOrdersJob(prisma as never);
  stubExternalPortfolioService(job);
  const result = await job.run({ canSubmit: () => true });

  assert.strictEqual(result.submitted, 0);
  assert.strictEqual(result.rejected, 1);
  assert.strictEqual(orderCreates, 0);
  assert.strictEqual(rejectedReason, 'orderbook_stale');
}

async function testExecutionFreshnessVetoBlocksSubmit(): Promise<void> {
  let orderCreates = 0;
  let auditEventType: string | null = null;

  const prisma = {
    signal: {
      findMany: async () => [createExecutionSignal()],
      update: async () => null,
    },
    signalDecision: {
      findFirst: async () => ({ positionSize: 10, verdict: 'approved' }),
      create: async () => null,
    },
    market: {
      findUnique: async () => createMarket(),
    },
    marketSnapshot: {
      findFirst: async () => createFreshSnapshot(),
    },
    orderbook: {
      findFirst: async () => createFreshOrderbook(),
    },
    order: {
      findFirst: async () => null,
      create: async () => {
        orderCreates += 1;
      },
    },
    auditEvent: {
      create: async ({ data }: { data: { eventType: string } }) => {
        auditEventType = data.eventType;
      },
    },
    portfolioSnapshot: {
      findFirst: async () => createFreshPortfolioSnapshot(),
    },
    reconciliationCheckpoint: {
      findFirst: async ({ where }: { where: { source: string } }) => ({
        source: where.source,
        status: 'completed',
        processedAt: new Date(Date.now() - 60_000),
      }),
    },
    botRuntimeStatus: {
      findUnique: async () => createFreshRuntimeStatus(),
    },
    liveConfig: {
      findUnique: async () => ({
        ...createRuntimeConfig(),
        id: 'live',
      }),
    },
  };

  const job = new ExecuteOrdersJob(prisma as never);
  stubExternalPortfolioService(job);
  const result = await job.run({ canSubmit: () => true });

  assert.strictEqual(result.submitted, 0);
  assert.strictEqual(result.rejected, 0);
  assert.strictEqual(orderCreates, 0);
  assert.strictEqual(auditEventType, 'execution.runtime_freshness_veto');
}

async function testReconcileFillSyncFailurePropagates(): Promise<void> {
  const checkpoints: Array<{ source: string; status: string }> = [];
  const runtimeControl = {
    recordReconciliationCheckpoint: async ({
      source,
      status,
    }: {
      source: string;
      status: string;
    }) => {
      checkpoints.push({ source, status });
    },
  };

  const prisma = {
    order: {
      findMany: async () => [],
    },
  };

  const job = new ReconcileFillsJob(prisma as never, runtimeControl as never);
  (job as any).fetchVenueTrades = async () => ({
    ok: false,
    trades: [],
    error: 'venue down',
  });

  const result = await job.run();

  assert.strictEqual(result.fillsInserted, 0);
  assert.strictEqual(result.syncFailed, true);
  assert.strictEqual(
    checkpoints.some(
      (entry) =>
        entry.source === 'fills_reconcile_cycle' && entry.status === 'sync_failed',
    ),
    true,
  );
}

async function testSignerHealthAcceptsPemKeys(): Promise<void> {
  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'secp256k1',
  });

  const signerHealth = new SignerHealth();
  const result = signerHealth.check({
    privateKey: privateKey.export({ format: 'pem', type: 'sec1' }).toString(),
    apiKey: 'key',
    apiSecret: 'secret',
    apiPassphrase: 'passphrase',
  });

  assert.strictEqual(result.healthy, true);
  assert.strictEqual(result.checks.privateKey, true);
}

async function testHeartbeatMarksDegradedRuntimeTruth(): Promise<void> {
  let writtenReason: string | null = null;

  const prisma = {
    botRuntimeStatus: {
      upsert: async ({ update, create }: { update: { reason: string }; create: { reason: string } }) => {
        writtenReason = update?.reason ?? create.reason;
      },
    },
    liveConfig: {
      findUnique: async () => ({
        ...createRuntimeConfig(),
        id: 'live',
      }),
    },
    portfolioSnapshot: {
      findFirst: async () => createFreshPortfolioSnapshot(),
    },
    reconciliationCheckpoint: {
      findFirst: async ({ where }: { where: { source: string } }) => ({
        source: where.source,
        status: 'completed',
        processedAt: new Date(Date.now() - 60_000),
      }),
    },
  };

  const repository = new RuntimeControlRepository(prisma as never, createRuntimeConfig());
  const result = await repository.heartbeat('running', 'runtime ready');

  assert.strictEqual(result.healthy, false);
  assert.strictEqual(result.reasonCode, 'open_orders_reconcile_stale');
  assert.strictEqual(writtenReason, 'degraded:open_orders_reconcile_stale');
}

async function testRuntimeFreshnessFailsWhenExternalPortfolioBlocksEntries(): Promise<void> {
  const prisma = {
    liveConfig: {
      findUnique: async () => ({
        ...createRuntimeConfig(),
        id: 'live',
      }),
    },
    portfolioSnapshot: {
      findFirst: async () => createFreshPortfolioSnapshot(),
    },
    reconciliationCheckpoint: {
      findFirst: async ({ where }: { where: { source: string } }) => {
        if (where.source === 'external_portfolio_reconcile') {
          return {
            source: where.source,
            status: 'completed',
            processedAt: new Date(),
            details: {
              snapshot: createExternalPortfolioSnapshot({
                tradingPermissions: {
                  allowNewEntries: false,
                  allowPositionManagement: true,
                  reasonCodes: ['inventory_mismatch_vs_current_positions'],
                },
                divergence: {
                  status: 'recoverable',
                  classes: ['inventory_mismatch_vs_current_positions'],
                  details: [],
                },
              }),
            },
          };
        }

        return {
          source: where.source,
          status: 'completed',
          processedAt: new Date(),
          details: {},
        };
      },
    },
    order: {
      count: async () => 0,
    },
  };

  const repository = new RuntimeControlRepository(prisma as never, createRuntimeConfig());
  const result = await repository.assessOperationalFreshness();

  assert.strictEqual(result.healthy, false);
  assert.strictEqual(result.reasonCode, 'external_portfolio_truth_unhealthy');
}

async function testVenueAwarenessPreflightRejectsGeoblock(): Promise<void> {
  const awareness = new PolymarketVenueAwareness({
    host: 'http://localhost',
    now: () => 1_000,
  });

  const result = await awareness.preflightStartup({
    getOk: async () => {
      throw {
        status: 451,
        message: 'Trading is restricted in your location.',
      };
    },
    getServerTime: async () => 1_000,
    getClosedOnlyMode: async () => ({ closed_only: false }),
  });

  assert.strictEqual(result.ready, false);
  assert.strictEqual(result.reasonCode, 'venue_geoblocked');
}

async function testVenueAwarenessPreflightRejectsClockSkew(): Promise<void> {
  const awareness = new PolymarketVenueAwareness({
    host: 'http://localhost',
    maxClockSkewMs: 500,
    now: () => 10_000,
  });

  const result = await awareness.preflightStartup({
    getOk: async () => ({ ok: true }),
    getServerTime: async () => 12,
    getClosedOnlyMode: async () => ({ closed_only: false }),
  });

  assert.strictEqual(result.ready, false);
  assert.strictEqual(result.reasonCode, 'clock_skew_exceeds_limit');
  assert.strictEqual(result.details.clockSkewMs, 2_000);
}

async function testVenueAwarenessRateGovernorBacksOffAfterRateLimit(): Promise<void> {
  let now = 0;
  const sleeps: number[] = [];
  const awareness = new PolymarketVenueAwareness({
    host: 'http://localhost',
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });

  await assert.rejects(
    () =>
      awareness.execute('private', 'get_open_orders', async () => {
        throw {
          status: 429,
          message: 'Too many requests. Retry after 750ms',
          data: {
            retry_after_ms: 750,
          },
        };
      }),
    (error: unknown) =>
      error instanceof Error && error.message.includes('[rate_limited]'),
  );

  const snapshotAfterFailure = awareness.getGovernanceSnapshot();
  assert.strictEqual(
    snapshotAfterFailure.nextAllowedAtByScope.private >= 750,
    true,
  );

  await awareness.execute('private', 'get_open_orders', async () => ['ok']);
  assert.strictEqual(
    sleeps.some((value) => value >= 750),
    true,
  );
}

async function testCanonicalTradeIntentResolverResolvesExplicitTokenAndIntent(): Promise<void> {
  const resolver = new TradeIntentResolver();
  const result = resolver.resolve({
    market: {
      id: 'm1',
      tokenIdYes: 'yes1',
      tokenIdNo: 'no1',
    },
    signal: {
      marketId: 'm1',
      tokenId: 'no1',
      outcome: 'NO',
      action: 'ENTER',
      side: 'BUY',
    },
  });

  assert.strictEqual(result.ok, true);
  if (!result.ok) {
    throw new Error('Expected successful canonical trade-intent resolution.');
  }

  assert.deepStrictEqual(result.resolved, {
    marketId: 'm1',
    tokenId: 'no1',
    outcome: 'NO',
    venueSide: 'BUY',
    intent: 'ENTER',
    inventoryEffect: 'INCREASE',
  });
}

async function testCanonicalTradeIntentResolverRequiresInventoryForExit(): Promise<void> {
  const resolver = new TradeIntentResolver();
  const result = resolver.resolve({
    market: {
      id: 'm1',
      tokenIdYes: 'yes1',
      tokenIdNo: 'no1',
    },
    signal: {
      marketId: 'm1',
      tokenId: 'yes1',
      outcome: 'YES',
      action: 'EXIT',
      side: 'SELL',
    },
    inventory: {
      quantityByTokenId: {
        yes1: 0,
      },
    },
  });

  assert.strictEqual(result.ok, false);
  if (result.ok) {
    throw new Error('Expected resolution failure when exit inventory is missing.');
  }
  assert.strictEqual(result.reasonCode, 'intent_requires_inventory');
}

async function testOfficialClientPassesTickSizeAndNegRiskToCreateOrder(): Promise<void> {
  let createOrderOptions: Record<string, unknown> | null = null;

  const client = new OfficialPolymarketTradingClient({
    host: 'http://localhost',
    chainId: 137,
    privateKey: '0x1111111111111111111111111111111111111111111111111111111111111111',
    apiKey: 'key',
    apiSecret: 'secret',
    apiPassphrase: 'pass',
  });

  (client as any).getModules = async () => ({
    clob: {
      OrderType: { GTC: 'gtc' },
      Side: { BUY: 'buy' },
    },
    ethers: {
      Wallet: class Wallet {
        constructor(_privateKey: string) {}
      },
    },
  });
  (client as any).getClient = async () => ({
    createOrder: async (_order: Record<string, unknown>, options?: Record<string, unknown>) => {
      createOrderOptions = options ?? null;
      return { signed: true };
    },
    postOrder: async () => ({
      success: true,
      orderID: 'venue-1',
      status: 'acknowledged',
    }),
  });

  const result = await client.postOrder({
    tokenId: 'yes1',
    side: 'BUY',
    price: 0.5,
    size: 2,
    orderType: 'GTC',
    tickSize: 0.01,
    minOrderSize: 1,
    negRisk: false,
  });

  assert.strictEqual(result.success, true);
  assert.deepStrictEqual(createOrderOptions, {
    tickSize: '0.01',
    negRisk: false,
  });
}

async function testOfficialClientReadsFeeRate(): Promise<void> {
  const client = new OfficialPolymarketTradingClient({
    host: 'http://localhost',
    chainId: 137,
    privateKey: '0x1111111111111111111111111111111111111111111111111111111111111111',
    apiKey: 'key',
    apiSecret: 'secret',
    apiPassphrase: 'pass',
  });

  (client as any).getClient = async () => ({
    getFeeRateBps: async (_tokenId: string) => 17,
  });

  const result = await client.getFeeRate('yes1');

  assert.strictEqual(result.tokenId, 'yes1');
  assert.strictEqual(result.feeRateBps, 17);
}

async function testOfficialClientReadsOrderScoring(): Promise<void> {
  const client = new OfficialPolymarketTradingClient({
    host: 'http://localhost',
    chainId: 137,
    privateKey: '0x1111111111111111111111111111111111111111111111111111111111111111',
    apiKey: 'key',
    apiSecret: 'secret',
    apiPassphrase: 'pass',
  });

  (client as any).getClient = async () => ({
    areOrdersScoring: async () => ({
      'venue-1': true,
      'venue-2': false,
    }),
  });

  const result = await client.getOrderScoring(['venue-1', 'venue-2']);

  assert.deepStrictEqual(result, [
    {
      orderId: 'venue-1',
      scoring: true,
      checkedAt: result[0]?.checkedAt,
    },
    {
      orderId: 'venue-2',
      scoring: false,
      checkedAt: result[1]?.checkedAt,
    },
  ]);
}

async function testOfficialClientReadsCurrentRewards(): Promise<void> {
  const client = new OfficialPolymarketTradingClient({
    host: 'http://localhost',
    chainId: 137,
    privateKey: '0x1111111111111111111111111111111111111111111111111111111111111111',
    apiKey: 'key',
    apiSecret: 'secret',
    apiPassphrase: 'pass',
  });

  (client as any).getClient = async () => ({
    getCurrentRewards: async () => [
      {
        condition_id: 'cond-1',
        rewards_max_spread: 0.03,
        rewards_min_size: 5,
        market_slug: 'btc-up',
        question: 'BTC above X?',
        tokens: [{ token_id: 'yes1', outcome: 'YES', price: 0.5 }],
      },
    ],
  });

  const result = await client.getCurrentRewards();

  assert.strictEqual(result[0]?.conditionId, 'cond-1');
  assert.strictEqual(result[0]?.tokens[0]?.tokenId, 'yes1');
}

async function testOfficialClientRejectsMissingNegRiskMetadata(): Promise<void> {
  const client = new OfficialPolymarketTradingClient({
    host: 'http://localhost',
    chainId: 137,
    privateKey: '0x1111111111111111111111111111111111111111111111111111111111111111',
    apiKey: 'key',
    apiSecret: 'secret',
    apiPassphrase: 'pass',
  });

  await assert.rejects(
    () =>
      client.postOrder({
        tokenId: 'yes1',
        side: 'BUY',
        price: 0.5,
        size: 2,
        orderType: 'GTC',
        tickSize: 0.01,
        minOrderSize: 1,
        negRisk: null,
      }),
    /neg_risk_missing/,
  );
}

async function testOfficialClientBlocksInvalidSignerConfiguration(): Promise<void> {
  const client = new OfficialPolymarketTradingClient({
    host: 'http://localhost',
    chainId: 137,
    privateKey: 'not-a-key',
    apiKey: 'key',
    apiSecret: 'secret',
    apiPassphrase: 'pass',
  });

  (client as any).getModules = async () => ({
    clob: {
      ClobClient: class ClobClient {},
      OrderType: { GTC: 'gtc' },
      Side: { BUY: 'buy' },
    },
    ethers: {
      Wallet: class Wallet {
        constructor(_privateKey: string) {}
      },
    },
  });

  await assert.rejects(
    () => (client as any).buildClient(),
    /privateKey must be 32-byte hex or a PEM-encoded secp256k1 key/,
  );
}

async function testOfficialClientBuildsVenueAwareSdkClient(): Promise<void> {
  let constructorArgs: unknown[] | null = null;

  const client = new OfficialPolymarketTradingClient({
    host: 'http://localhost',
    chainId: 137,
    privateKey: '0x1111111111111111111111111111111111111111111111111111111111111111',
    apiKey: 'key',
    apiSecret: 'secret',
    apiPassphrase: 'pass',
    geoBlockToken: 'geo-token',
    useServerTime: true,
    retryOnError: true,
  });

  (client as any).getModules = async () => ({
    clob: {
      ClobClient: class ClobClient {
        constructor(...args: unknown[]) {
          constructorArgs = args;
        }
      },
      OrderType: { GTC: 'gtc' },
      Side: { BUY: 'buy' },
    },
    ethers: {
      Wallet: class Wallet {
        constructor(_privateKey: string) {}
      },
    },
  });

  await (client as any).buildClient();

  assert.strictEqual(constructorArgs?.[6], 'geo-token');
  assert.strictEqual(constructorArgs?.[7], true);
  assert.strictEqual(constructorArgs?.[10], true);
  assert.strictEqual(constructorArgs?.[12], true);
}

async function testOfficialClientPreflightRejectsClosedOnlyVenue(): Promise<void> {
  const client = new OfficialPolymarketTradingClient({
    host: 'http://localhost',
    chainId: 137,
    privateKey: '0x1111111111111111111111111111111111111111111111111111111111111111',
    apiKey: 'key',
    apiSecret: 'secret',
    apiPassphrase: 'pass',
  });

  (client as any).getClient = async () => ({
    getOk: async () => ({ ok: true }),
    getServerTime: async () => Math.floor(Date.now() / 1000),
    getClosedOnlyMode: async () => ({ closed_only: true }),
  });

  const result = await client.preflightVenue();

  assert.strictEqual(result.ready, false);
  assert.strictEqual(result.reasonCode, 'venue_closed_only');
}

async function testStartStopManagerBlocksVenuePreflightFailure(): Promise<void> {
  const stateStore = new BotStateStore('stopped');
  const manager = new StartStopManager(
    stateStore,
    {
      preflightVenue: async () => ({
        ready: false,
        reasonCode: 'venue_geoblocked',
        details: {
          host: 'http://localhost',
          publicProbeOk: false,
          serverTimeMs: null,
          localTimeMs: 0,
          clockSkewMs: null,
          maxClockSkewMs: 5_000,
          closedOnly: null,
        },
      }),
    } as never,
  );

  await assert.rejects(
    () => manager.start('manual start'),
    /venue preflight venue_geoblocked/,
  );
  assert.strictEqual(stateStore.getState(), 'stopped');
}

async function testCanonicalLivePathUsesCanonicalSignerEntrypoints(): Promise<void> {
  assert.strictEqual(
    fs.existsSync(path.join(repoRoot, 'packages/signing-engine/src/server-signer.ts')),
    true,
  );
  assert.strictEqual(
    fs.existsSync(path.join(repoRoot, 'packages/signing-engine/src/index.ts')),
    true,
  );
  assert.strictEqual(
    fs.existsSync(path.join(repoRoot, 'packages/polymarket-adapter/src/index.ts')),
    true,
  );

  const officialClientSource = fs.readFileSync(
    path.join(repoRoot, 'packages/polymarket-adapter/src/official-trading-client.ts'),
    'utf8',
  );

  assert.strictEqual(officialClientSource.includes('ServerSigner'), true);
  assert.strictEqual(officialClientSource.includes('new ServerSigner'), true);

  const obsoletePaths = [
    'packages/polymarket-adapter/src/clob-client.ts',
    'packages/polymarket-adapter/src/trading/create-order.ts',
    'packages/polymarket-adapter/src/trading/post-order.ts',
    'packages/polymarket-adapter/src/trading/cancel-order.ts',
    'packages/polymarket-adapter/src/trading/get-open-orders.ts',
    'packages/polymarket-adapter/src/trading/get-trades.ts',
  ];

  for (const relativePath of obsoletePaths) {
    assert.strictEqual(fs.existsSync(path.join(repoRoot, relativePath)), false);
  }
}

async function testTrackedEnvArtifactsContainPlaceholdersOnly(): Promise<void> {
  const envFiles = ['.env', '.env.smoke', '.env.example'];
  for (const fileName of envFiles) {
    const contents = fs.readFileSync(path.join(repoRoot, fileName), 'utf8');
    assert.strictEqual(/0x[a-fA-F0-9]{64}/.test(contents), false, `${fileName} must not contain a live private key.`);
    assert.strictEqual(contents.includes('replace-with-'), true, `${fileName} should use placeholder values.`);
  }
}

async function testSecretPolicyRejectsProductionEnvFileSecrets(): Promise<void> {
  const verdict = resolveSecrets(
    {
      POLY_PRIVATE_KEY: '0x1111111111111111111111111111111111111111111111111111111111111111',
      POLY_API_KEY: 'key',
      POLY_API_SECRET: 'secret',
      POLY_API_PASSPHRASE: 'pass',
    },
    {
      mode: 'env',
      allowInsecureEnvInProduction: false,
      isProduction: true,
    },
    {
      cwd: repoRoot,
      isTest: false,
      sources: {
        POLY_PRIVATE_KEY: {
          classification: 'env_file',
          filePath: path.join(repoRoot, '.env'),
        },
        POLY_API_KEY: {
          classification: 'env_file',
          filePath: path.join(repoRoot, '.env'),
        },
        POLY_API_SECRET: {
          classification: 'env_file',
          filePath: path.join(repoRoot, '.env'),
        },
        POLY_API_PASSPHRASE: {
          classification: 'env_file',
          filePath: path.join(repoRoot, '.env'),
        },
      },
    },
  );

  assert.strictEqual(verdict.productionPolicyPassed, false);
  assert.strictEqual(verdict.secrets.polyPrivateKey.source, 'env_file');
  assert.strictEqual(verdict.secrets.polyPrivateKey.approvedInProduction, false);
}

async function testSecretPolicyAllowsProcessEnvAndTestOverrides(): Promise<void> {
  const processEnvVerdict = resolveSecrets(
    {
      POLY_PRIVATE_KEY: '0x1111111111111111111111111111111111111111111111111111111111111111',
      POLY_API_KEY: 'key',
      POLY_API_SECRET: 'secret',
      POLY_API_PASSPHRASE: 'pass',
    },
    {
      mode: 'env',
      allowInsecureEnvInProduction: false,
      isProduction: true,
    },
    {
      cwd: repoRoot,
      isTest: false,
      sources: {
        POLY_PRIVATE_KEY: { classification: 'process_env', filePath: null },
        POLY_API_KEY: { classification: 'process_env', filePath: null },
        POLY_API_SECRET: { classification: 'process_env', filePath: null },
        POLY_API_PASSPHRASE: { classification: 'process_env', filePath: null },
      },
    },
  );
  assert.strictEqual(processEnvVerdict.productionPolicyPassed, true);

  const loaded = loadWorkerEnvironment(
    {
      NODE_ENV: 'test',
      POLY_PRIVATE_KEY:
        '0x1111111111111111111111111111111111111111111111111111111111111111',
      POLY_API_KEY: 'key',
      POLY_API_SECRET: 'secret',
      POLY_API_PASSPHRASE: 'pass',
    },
    repoRoot,
  );
  assert.strictEqual(loaded.sources.POLY_PRIVATE_KEY?.classification, 'test_override');
}

async function testRuntimePermissionMatrixMatchesCanonicalStates(): Promise<void> {
  const degraded = permissionsForRuntimeState('degraded');
  const reconciliationOnly = permissionsForRuntimeState('reconciliation_only');
  const cancelOnly = permissionsForRuntimeState('cancel_only');
  const haltedHard = permissionsForRuntimeState('halted_hard');

  assert.strictEqual(degraded.allowNewEntries, false);
  assert.strictEqual(degraded.allowOrderSubmit, false);
  assert.strictEqual(reconciliationOnly.allowReconciliation, true);
  assert.strictEqual(reconciliationOnly.allowOrderSubmit, false);
  assert.strictEqual(cancelOnly.allowOrderCancel, true);
  assert.strictEqual(haltedHard.allowEmergencyCancel, true);
  assert.strictEqual(normalizePersistedRuntimeState('starting'), 'stopped');
  assert.strictEqual(normalizePersistedRuntimeState('halted'), 'stopped');
}

async function testServerSignerBuildsCanonicalWalletAndHealth(): Promise<void> {
  const signer = new ServerSigner({
    privateKey: '0x1111111111111111111111111111111111111111111111111111111111111111',
    apiKey: 'key',
    apiSecret: 'secret',
    apiPassphrase: 'pass',
    profileAddress: '0x1111111111111111111111111111111111111111',
    signatureType: 0,
  });

  const health = signer.getHealth();
  assert.strictEqual(health.healthy, true);

  const wallet = signer.createWallet(
    class Wallet {
      constructor(readonly privateKey: string) {}
    },
  );
  assert.strictEqual((wallet as { privateKey: string }).privateKey.startsWith('0x'), true);
}

async function testStartupGatePersistsPassAndFailVerdicts(): Promise<void> {
  const checkpoints: Array<{ source: string; status: string }> = [];
  const runtimeControl = {
    recordReconciliationCheckpoint: async (input: { source: string; status: string }) => {
      checkpoints.push(input);
    },
  } as Pick<RuntimeControlRepository, 'recordReconciliationCheckpoint'> as RuntimeControlRepository;

  const marketStreamService = {
    evaluateHealth: () => ({
      healthy: true,
      reasonCode: null,
      connectionStatus: 'connected' as const,
      trackedAssets: 1,
      staleAssets: [],
      metadataInvalidations: [],
      lastEventAt: new Date().toISOString(),
      lastTrafficAt: new Date().toISOString(),
      bootstrapCompletedAt: new Date().toISOString(),
      trusted: true,
      reconnectAttempt: 0,
    }),
  } as Pick<MarketWebSocketStateService, 'evaluateHealth'> as MarketWebSocketStateService;
  const userStreamService = {
    evaluateHealth: () => ({
      healthy: true,
      reasonCode: null,
      connectionStatus: 'connected' as const,
      lastEventAt: new Date().toISOString(),
      lastTrafficAt: new Date().toISOString(),
      openOrders: 0,
      recentTrades: 0,
      divergenceDetected: false,
      lastReconciliationAt: new Date().toISOString(),
      trusted: true,
      subscribedMarkets: 1,
      reconnectAttempt: 0,
    }),
  } as Pick<UserWebSocketStateService, 'evaluateHealth'> as UserWebSocketStateService;

  const passingGate = new StartupGateService(
    runtimeControl,
    {
      run: async () => ({
        passed: true,
        reasonCode: null,
        executedAt: new Date().toISOString(),
        steps: [],
        smoke: null,
        externalSnapshot: null,
      }),
    } as never,
    {
      run: async () => ({
        recovered: true,
        reasonCode: null,
        venueOpenOrders: 0,
        fillsInserted: 0,
        syncFailed: false,
        snapshotId: 'snap-1',
        reservedCash: 0,
        workingOpenOrders: 0,
      }),
    } as never,
    marketStreamService,
    userStreamService,
  );
  const passVerdict = await passingGate.evaluate('test');
  assert.strictEqual(passVerdict.passed, true);

  const failingGate = new StartupGateService(
    runtimeControl,
    {
      run: async () => ({
        passed: false,
        reasonCode: 'runbook_failed',
        executedAt: new Date().toISOString(),
        steps: [],
        smoke: null,
        externalSnapshot: null,
      }),
    } as never,
    undefined,
    marketStreamService,
    userStreamService,
  );
  const failVerdict = await failingGate.evaluate('test');
  assert.strictEqual(failVerdict.passed, false);
  assert.strictEqual(checkpoints.some((entry) => entry.source === 'startup_gate_verdict' && entry.status === 'completed'), true);
  assert.strictEqual(checkpoints.some((entry) => entry.source === 'startup_gate_verdict' && entry.status === 'failed'), true);
}

class MockPolymarketWebSocketServer {
  private readonly httpServer = createServer();
  private readonly websocketServer = new WebSocketServer({ server: this.httpServer });
  private readonly sockets = new Set<WebSocket>();
  readonly textMessages: string[] = [];
  readonly jsonMessages: unknown[] = [];

  constructor(private readonly options: { autoPong?: boolean } = {}) {
    this.websocketServer.on('connection', (socket: WebSocket) => {
      this.sockets.add(socket);
      socket.on('message', (payload: Buffer) => {
        const text = payload.toString();
        this.textMessages.push(text);
        if (text === 'PING') {
          if (this.options.autoPong !== false) {
            socket.send('PONG');
          }
          return;
        }

        try {
          this.jsonMessages.push(JSON.parse(text));
        } catch {
          // Ignore non-JSON frames in tests.
        }
      });
      socket.on('close', () => {
        this.sockets.delete(socket);
      });
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => {
      this.httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.httpServer.address() as AddressInfo;
    return `ws://127.0.0.1:${address.port}`;
  }

  send(payload: unknown): void {
    const serialized =
      typeof payload === 'string' ? payload : JSON.stringify(payload);
    for (const socket of this.sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(serialized);
      }
    }
  }

  closeAll(code = 4000, reason = 'test_close'): void {
    for (const socket of this.sockets) {
      socket.close(code, reason);
    }
  }

  async waitForJsonMessage(
    predicate: (message: unknown) => boolean,
    timeoutMs = 2_000,
  ): Promise<unknown> {
    return waitForCondition(() => this.jsonMessages.find(predicate) ?? null, timeoutMs);
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.close();
    }
    await new Promise<void>((resolve) => {
      this.websocketServer.close(() => {
        this.httpServer.close(() => resolve());
      });
    });
  }
}

function createMarketFetchStub(
  books: Record<string, Record<string, unknown>>,
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl, 'https://clob.polymarket.com');
    const tokenId = url.searchParams.get('token_id') ?? '';
    return new Response(JSON.stringify(books[tokenId] ?? books.default ?? {}), {
      status: books[tokenId] || books.default ? 200 : 404,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }) as typeof fetch;
}

function createGammaFetchStub(markets: unknown[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl, 'https://gamma-api.polymarket.com');
    if (url.pathname === '/markets') {
      const normalizedMarkets = markets.map((market, index) => {
        if (!market || typeof market !== 'object') {
          return market;
        }

        const record = market as Record<string, unknown>;
        const tokenIds = Array.isArray(record.clobTokenIds)
          ? (record.clobTokenIds as unknown[]).map((value) => String(value))
          : [
              String(record.tokenIdYes ?? `yes-${index}`),
              String(record.tokenIdNo ?? `no-${index}`),
            ];

        return {
          slug: record.slug ?? `market-${index}`,
          question: record.question ?? record.title ?? `market-${index}`,
          active: record.active ?? true,
          closed: record.closed ?? false,
          enableOrderBook: record.enableOrderBook ?? true,
          tradable: record.tradable ?? true,
          tokens:
            record.tokens ??
            [
              { token_id: tokenIds[0], outcome: 'Yes' },
              { token_id: tokenIds[1], outcome: 'No' },
            ],
          clobTokenIds: tokenIds,
          ...record,
        };
      });

      return new Response(JSON.stringify(normalizedMarkets), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    }

    return new Response(JSON.stringify([]), { status: 404 });
  }) as typeof fetch;
}

function createScriptedRestClient(script: {
  openOrders: VenueOpenOrder[][];
  trades: VenueTradeRecord[][];
}): {
  getOpenOrders: () => Promise<VenueOpenOrder[]>;
  getTrades: () => Promise<VenueTradeRecord[]>;
} {
  let openOrderIndex = 0;
  let tradeIndex = 0;
  return {
    getOpenOrders: async () => {
      const value = script.openOrders[Math.min(openOrderIndex, script.openOrders.length - 1)] ?? [];
      openOrderIndex += 1;
      return value;
    },
    getTrades: async () => {
      const value = script.trades[Math.min(tradeIndex, script.trades.length - 1)] ?? [];
      tradeIndex += 1;
      return value;
    },
  };
}

async function withSmokeEnv<T>(
  overrides: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const nextEnv: Record<string, string> = {
    POLY_CLOB_HOST: 'https://clob.polymarket.com',
    POLY_CHAIN_ID: '137',
    POLY_PRIVATE_KEY:
      '1111111111111111111111111111111111111111111111111111111111111111',
    POLY_API_KEY: 'test-key',
    POLY_API_SECRET: 'test-secret',
    POLY_API_PASSPHRASE: 'test-pass',
    POLY_SIGNATURE_TYPE: '0',
    POLY_SMOKE_TOKEN_ID: 'yes1',
    POLY_SMOKE_PRICE: '0.5',
    POLY_SMOKE_SIZE: '1',
    POLY_SMOKE_EXECUTE: 'true',
    POLY_SMOKE_ORDER_TYPE: 'GTC',
    POLY_SMOKE_EXPIRATION_SECONDS: '75',
    POLY_SMOKE_MAX_WAIT_MS: '1500',
    POLY_SMOKE_POLL_INTERVAL_MS: '50',
    ...overrides,
  };
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(nextEnv)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function waitForCondition<T>(
  resolver: () => T | null | undefined,
  timeoutMs = 2_000,
  intervalMs = 10,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = resolver();
    if (value != null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error('condition_wait_timeout');
}

async function testMarketStreamConnectsBootstrapsAndSupportsDynamicSubscriptions(): Promise<void> {
  const server = new MockPolymarketWebSocketServer();
  const url = await server.start();
  const service = new MarketWebSocketStateService(250, {
    url,
    restBaseUrl: 'https://clob.polymarket.com',
    fetchImpl: createMarketFetchStub({
      yes1: {
        bids: [{ price: '0.49', size: '10' }],
        asks: [{ price: '0.51', size: '12' }],
        tick_size: '0.01',
        min_order_size: '1',
        neg_risk: false,
        last_trade_price: '0.5',
        hash: 'rest-yes1',
      },
      no1: {
        bids: [{ price: '0.44', size: '8' }],
        asks: [{ price: '0.56', size: '9' }],
        tick_size: '0.01',
        min_order_size: '1',
        neg_risk: false,
        last_trade_price: '0.45',
        hash: 'rest-no1',
      },
    }),
    heartbeatIntervalMs: 50,
    reconnectBaseDelayMs: 25,
    reconnectMaxDelayMs: 100,
    reconnectMaxAttempts: 4,
    bootstrapTimeoutMs: 1_000,
  });

  try {
    const startPromise = service.start(['yes1']);
    await server.waitForJsonMessage(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        (message as Record<string, unknown>).type === 'market',
    );
    server.send({
      event_type: 'book',
      asset_id: 'yes1',
      market: 'cond-1',
      bids: [{ price: '0.49', size: '10' }],
      asks: [{ price: '0.51', size: '12' }],
      timestamp: `${Date.now()}`,
      hash: 'stream-yes1',
    });
    const health = await startPromise;
    assert.strictEqual(health.healthy, true);
    assert.strictEqual(service.getAssetState('yes1')?.bestBid, 0.49);

    const subscribePromise = service.syncSubscriptions(['yes1', 'no1']);
    await server.waitForJsonMessage(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        (message as Record<string, unknown>).operation === 'subscribe',
    );
    server.send({
      event_type: 'book',
      asset_id: 'no1',
      market: 'cond-1',
      bids: [{ price: '0.44', size: '8' }],
      asks: [{ price: '0.56', size: '9' }],
      timestamp: `${Date.now() + 1}`,
      hash: 'stream-no1',
    });
    await subscribePromise;
    assert.strictEqual(service.getAssetState('no1')?.bestAsk, 0.56);

    await service.syncSubscriptions(['yes1']);
    await server.waitForJsonMessage(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        (message as Record<string, unknown>).operation === 'unsubscribe',
    );
    assert.strictEqual(service.getAssetState('no1'), null);
  } finally {
    service.stop();
    await server.stop();
  }
}

async function testUserStreamAuthenticatesAndBootstrapsWithRestCatchup(): Promise<void> {
  const server = new MockPolymarketWebSocketServer();
  const url = await server.start();
  const restClient = createScriptedRestClient({
    openOrders: [
      [
        {
          id: 'o-1',
          status: 'open',
          side: 'BUY',
          price: 0.5,
          size: 2,
          matchedSize: 0,
          tokenId: 'yes1',
          createdAt: new Date().toISOString(),
          raw: {},
        },
      ],
      [
        {
          id: 'o-1',
          status: 'open',
          side: 'BUY',
          price: 0.5,
          size: 2,
          matchedSize: 1,
          tokenId: 'yes1',
          createdAt: new Date().toISOString(),
          raw: {},
        },
      ],
    ],
    trades: [
      [],
      [
        {
          id: 't-1',
          orderId: 'o-1',
          tokenId: 'yes1',
          side: 'BUY',
          price: 0.5,
          size: 1,
          fee: 0.01,
          filledAt: new Date().toISOString(),
          status: 'MATCHED',
          raw: {},
        },
      ],
    ],
  });

  const service = new UserWebSocketStateService(250, {
    url,
    auth: {
      apiKey: 'key-1',
      secret: 'secret-1',
      passphrase: 'pass-1',
    },
    fetchImpl: createGammaFetchStub([
      {
        id: 'm1',
        conditionId: 'cond-1',
        clobTokenIds: ['yes1', 'no1'],
      },
    ]),
    restClient,
    heartbeatIntervalMs: 50,
    reconnectBaseDelayMs: 25,
    reconnectMaxDelayMs: 100,
    reconnectMaxAttempts: 4,
    bootstrapTimeoutMs: 1_200,
    bootstrapCatchupDelayMs: 100,
  });

  try {
    const startPromise = service.start([
      {
        marketId: 'm1',
        tokenIds: ['yes1', 'no1'],
      },
    ]);
    const initialSubscription = (await server.waitForJsonMessage(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        (message as Record<string, unknown>).type === 'user',
    )) as Record<string, unknown>;
    assert.deepStrictEqual(initialSubscription.markets, ['cond-1']);
    assert.deepStrictEqual(initialSubscription.auth, {
      apiKey: 'key-1',
      secret: 'secret-1',
      passphrase: 'pass-1',
    });

    server.send({
      event_type: 'order',
      id: 'o-1',
      asset_id: 'yes1',
      market: 'cond-1',
      side: 'BUY',
      price: '0.5',
      original_size: '2',
      size_matched: '1',
      type: 'UPDATE',
      timestamp: `${Math.floor(Date.now() / 1000)}`,
    });
    server.send({
      event_type: 'trade',
      id: 't-1',
      asset_id: 'yes1',
      market: 'cond-1',
      side: 'BUY',
      price: '0.5',
      size: '1',
      status: 'MATCHED',
      taker_order_id: 'o-1',
      timestamp: `${Math.floor(Date.now() / 1000)}`,
    });

    const health = await startPromise;
    assert.strictEqual(health.healthy, true);
    assert.deepStrictEqual(service.getOpenOrderIds(), ['o-1']);
    assert.deepStrictEqual(service.getTradeIds(), ['t-1']);
  } finally {
    service.stop();
    await server.stop();
  }
}

async function testMarketStreamReconnectsAfterDisconnect(): Promise<void> {
  const server = new MockPolymarketWebSocketServer();
  const url = await server.start();
  const service = new MarketWebSocketStateService(250, {
    url,
    restBaseUrl: 'https://clob.polymarket.com',
    fetchImpl: createMarketFetchStub({
      yes1: {
        bids: [{ price: '0.49', size: '10' }],
        asks: [{ price: '0.51', size: '12' }],
        tick_size: '0.01',
        min_order_size: '1',
        neg_risk: false,
        last_trade_price: '0.5',
        hash: 'rest-yes1',
      },
    }),
    heartbeatIntervalMs: 50,
    reconnectBaseDelayMs: 25,
    reconnectMaxDelayMs: 100,
    reconnectMaxAttempts: 4,
    bootstrapTimeoutMs: 1_000,
  });

  try {
    const startPromise = service.start(['yes1']);
    await server.waitForJsonMessage(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        (message as Record<string, unknown>).type === 'market',
    );
    server.send({
      event_type: 'book',
      asset_id: 'yes1',
      market: 'cond-1',
      bids: [{ price: '0.49', size: '10' }],
      asks: [{ price: '0.51', size: '12' }],
      timestamp: `${Date.now()}`,
      hash: 'boot-1',
    });
    await startPromise;

    const initialSubscriptionCount = server.jsonMessages.length;
    server.closeAll(4001, 'drop');
    await waitForCondition(
      () => (server.jsonMessages.length > initialSubscriptionCount ? true : null),
      2_000,
    );
    server.send({
      event_type: 'book',
      asset_id: 'yes1',
      market: 'cond-1',
      bids: [{ price: '0.5', size: '9' }],
      asks: [{ price: '0.52', size: '11' }],
      timestamp: `${Date.now() + 1}`,
      hash: 'boot-2',
    });
    await waitForCondition(() => {
      const health = service.evaluateHealth();
      return health.healthy ? health : null;
    }, 2_000);
  } finally {
    service.stop();
    await server.stop();
  }
}

async function testMarketStreamHeartbeatLossTriggersReconnect(): Promise<void> {
  const server = new MockPolymarketWebSocketServer({ autoPong: false });
  const url = await server.start();
  const service = new MarketWebSocketStateService(120, {
    url,
    restBaseUrl: 'https://clob.polymarket.com',
    fetchImpl: createMarketFetchStub({
      yes1: {
        bids: [{ price: '0.49', size: '10' }],
        asks: [{ price: '0.51', size: '12' }],
        tick_size: '0.01',
        min_order_size: '1',
        neg_risk: false,
        last_trade_price: '0.5',
        hash: 'rest-yes1',
      },
    }),
    heartbeatIntervalMs: 40,
    reconnectBaseDelayMs: 20,
    reconnectMaxDelayMs: 80,
    reconnectMaxAttempts: 4,
    bootstrapTimeoutMs: 1_000,
  });

  try {
    const startPromise = service.start(['yes1']);
    await server.waitForJsonMessage(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        (message as Record<string, unknown>).type === 'market',
    );
    server.send({
      event_type: 'book',
      asset_id: 'yes1',
      market: 'cond-1',
      bids: [{ price: '0.49', size: '10' }],
      asks: [{ price: '0.51', size: '12' }],
      timestamp: `${Date.now()}`,
      hash: 'boot-1',
    });
    await startPromise;

    const subscriptionsBeforeReconnect = server.jsonMessages.length;
    await waitForCondition(
      () => (server.jsonMessages.length > subscriptionsBeforeReconnect ? true : null),
      2_000,
    );
    assert.strictEqual(service.evaluateHealth().healthy, false);
  } finally {
    service.stop();
    await server.stop();
  }
}

async function testUserStreamStalenessFailsClosedAfterRealTraffic(): Promise<void> {
  const server = new MockPolymarketWebSocketServer();
  const url = await server.start();
  const service = new UserWebSocketStateService(50, {
    url,
    auth: {
      apiKey: 'key-1',
      secret: 'secret-1',
      passphrase: 'pass-1',
    },
    fetchImpl: createGammaFetchStub([
      {
        id: 'm1',
        conditionId: 'cond-1',
        clobTokenIds: ['yes1', 'no1'],
      },
    ]),
    restClient: createScriptedRestClient({
      openOrders: [[]],
      trades: [[]],
    }),
    heartbeatIntervalMs: 20,
    bootstrapTimeoutMs: 1_000,
    bootstrapCatchupDelayMs: 50,
  });

  try {
    await service.start([
      {
        marketId: 'm1',
        tokenIds: ['yes1', 'no1'],
      },
    ]);
    const health = service.evaluateHealth(Date.now() + 1_000);
    assert.strictEqual(health.healthy, false);
    assert.strictEqual(health.reasonCode, 'user_stream_stale');
  } finally {
    service.stop();
    await server.stop();
  }
}

async function testMarketStreamIgnoresDuplicateAndOutOfOrderMessages(): Promise<void> {
  const server = new MockPolymarketWebSocketServer();
  const url = await server.start();
  const service = new MarketWebSocketStateService(250, {
    url,
    restBaseUrl: 'https://clob.polymarket.com',
    fetchImpl: createMarketFetchStub({
      yes1: {
        bids: [{ price: '0.49', size: '10' }],
        asks: [{ price: '0.51', size: '12' }],
        tick_size: '0.01',
        min_order_size: '1',
        neg_risk: false,
        last_trade_price: '0.5',
        hash: 'rest-yes1',
      },
    }),
    heartbeatIntervalMs: 50,
    bootstrapTimeoutMs: 1_000,
  });

  try {
    const baseTimestamp = Date.now();
    const startPromise = service.start(['yes1']);
    await server.waitForJsonMessage(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        (message as Record<string, unknown>).type === 'market',
    );
    server.send({
      event_type: 'book',
      asset_id: 'yes1',
      market: 'cond-1',
      bids: [{ price: '0.49', size: '10' }],
      asks: [{ price: '0.51', size: '12' }],
      timestamp: `${baseTimestamp}`,
      hash: 'newer',
    });
    await startPromise;

    server.send({
      event_type: 'book',
      asset_id: 'yes1',
      market: 'cond-1',
      bids: [{ price: '0.48', size: '9' }],
      asks: [{ price: '0.52', size: '11' }],
      timestamp: `${baseTimestamp}`,
      hash: 'newer',
    });
    server.send({
      event_type: 'book',
      asset_id: 'yes1',
      market: 'cond-1',
      bids: [{ price: '0.4', size: '7' }],
      asks: [{ price: '0.6', size: '8' }],
      timestamp: `${baseTimestamp - 1_000}`,
      hash: 'older',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(service.getAssetState('yes1')?.bestBid, 0.49);
    assert.strictEqual(service.getAssetState('yes1')?.bestAsk, 0.51);
  } finally {
    service.stop();
    await server.stop();
  }
}

async function testUserStreamIgnoresOutOfOrderAndDuplicateTradeMessages(): Promise<void> {
  const server = new MockPolymarketWebSocketServer();
  const url = await server.start();
  const service = new UserWebSocketStateService(250, {
    url,
    auth: {
      apiKey: 'key-1',
      secret: 'secret-1',
      passphrase: 'pass-1',
    },
    fetchImpl: createGammaFetchStub([
      {
        id: 'm1',
        conditionId: 'cond-1',
        clobTokenIds: ['yes1', 'no1'],
      },
    ]),
    restClient: createScriptedRestClient({
      openOrders: [[]],
      trades: [[]],
    }),
    heartbeatIntervalMs: 20,
    bootstrapTimeoutMs: 1_000,
    bootstrapCatchupDelayMs: 50,
  });

  try {
    const baseTimestamp = Date.now();
    await service.start([
      {
        marketId: 'm1',
        tokenIds: ['yes1', 'no1'],
      },
    ]);

    server.send({
      event_type: 'trade',
      id: 't-1',
      asset_id: 'yes1',
      market: 'cond-1',
      side: 'BUY',
      price: '0.5',
      size: '1',
      status: 'CONFIRMED',
      taker_order_id: 'o-1',
      timestamp: `${baseTimestamp}`,
    });
    server.send({
      event_type: 'trade',
      id: 't-1',
      asset_id: 'yes1',
      market: 'cond-1',
      side: 'BUY',
      price: '0.5',
      size: '1',
      status: 'MATCHED',
      taker_order_id: 'o-1',
      timestamp: `${baseTimestamp - 1_000}`,
    });
    server.send({
      event_type: 'trade',
      id: 't-1',
      asset_id: 'yes1',
      market: 'cond-1',
      side: 'BUY',
      price: '0.5',
      size: '1',
      status: 'CONFIRMED',
      taker_order_id: 'o-1',
      timestamp: `${baseTimestamp}`,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepStrictEqual(service.getTradeIds(), ['t-1']);
    const storedTrade = (service as unknown as {
      recentTrades: Map<string, UserStreamTradeProjection>;
    }).recentTrades.get('t-1');
    assert.strictEqual(storedTrade?.status, 'CONFIRMED');
  } finally {
    service.stop();
    await server.stop();
  }
}

async function testProductionReadinessProvesActiveMarketSubscription(): Promise<void> {
  const server = new MockPolymarketWebSocketServer();
  const url = await server.start();
  const service = new MarketWebSocketStateService(250, {
    url,
    restBaseUrl: 'https://clob.polymarket.com',
    fetchImpl: createMarketFetchStub({
      yes1: {
        bids: [{ price: '0.49', size: '10' }],
        asks: [{ price: '0.51', size: '12' }],
        tick_size: '0.01',
        min_order_size: '1',
        neg_risk: false,
        last_trade_price: '0.5',
        hash: 'rest-yes1',
      },
    }),
    heartbeatIntervalMs: 50,
    bootstrapTimeoutMs: 1_000,
  });

  try {
    const stepPromise = probeMarketStreamReadiness({
      service,
      assetIds: ['yes1'],
      staleAfterMs: 250,
    });
    const subscription = (await server.waitForJsonMessage(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        (message as Record<string, unknown>).type === 'market',
    )) as Record<string, unknown>;
    assert.deepStrictEqual(subscription.assets_ids, ['yes1']);

    server.send({
      event_type: 'book',
      asset_id: 'yes1',
      market: 'cond-1',
      bids: [{ price: '0.49', size: '10' }],
      asks: [{ price: '0.51', size: '12' }],
      timestamp: `${Date.now()}`,
      hash: 'readiness-book-1',
    });

    const step = await stepPromise;
    assert.strictEqual(step.ok, true);
    assert.strictEqual(step.name, 'market_stream_live_subscription');
    assert.strictEqual(step.evidence.trackedAssets, 1);
    assert.strictEqual(step.evidence.sampleAssetId, 'yes1');
    assert.strictEqual(typeof step.evidence.lastTrafficAt, 'string');
  } finally {
    service.stop();
    await server.stop();
  }
}

async function testProductionReadinessProvesActiveAuthenticatedUserSubscription(): Promise<void> {
  const server = new MockPolymarketWebSocketServer();
  const url = await server.start();
  const restClient = createScriptedRestClient({
    openOrders: [[], []],
    trades: [
      [
        {
          id: 'u-t-1',
          orderId: null,
          tokenId: 'yes1',
          side: 'BUY',
          price: 0.5,
          size: 1,
          fee: 0.01,
          filledAt: new Date().toISOString(),
          status: 'MATCHED',
          raw: {},
        },
      ],
      [
        {
          id: 'u-t-1',
          orderId: null,
          tokenId: 'yes1',
          side: 'BUY',
          price: 0.5,
          size: 1,
          fee: 0.01,
          filledAt: new Date().toISOString(),
          status: 'MATCHED',
          raw: {},
        },
      ],
    ],
  });
  const service = new UserWebSocketStateService(250, {
    url,
    auth: {
      apiKey: 'key-1',
      secret: 'secret-1',
      passphrase: 'pass-1',
    },
    fetchImpl: createGammaFetchStub([
      {
        id: 'm1',
        conditionId: 'cond-1',
        clobTokenIds: ['yes1', 'no1'],
      },
    ]),
    restClient,
    heartbeatIntervalMs: 25,
    bootstrapTimeoutMs: 1_000,
    bootstrapCatchupDelayMs: 50,
  });

  try {
    const startPromise = service.start([
      {
        marketId: 'm1',
        tokenIds: ['yes1', 'no1'],
      },
    ]);
    const subscription = (await server.waitForJsonMessage(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        (message as Record<string, unknown>).type === 'user',
    )) as Record<string, unknown>;
    assert.deepStrictEqual(subscription.markets, ['cond-1']);
    assert.deepStrictEqual(subscription.auth, {
      apiKey: 'key-1',
      secret: 'secret-1',
      passphrase: 'pass-1',
    });

    server.send({
      event_type: 'trade',
      id: 'u-t-1',
      asset_id: 'yes1',
      market: 'cond-1',
      side: 'BUY',
      price: '0.5',
      size: '1',
      status: 'MATCHED',
      taker_order_id: 'u-o-1',
      timestamp: `${Math.floor(Date.now() / 1000)}`,
    });

    const health = await waitForCondition(() => {
      const current = service.evaluateHealth();
      return current.trusted && current.lastEventAt !== null ? current : null;
    }, 1_000);
    await startPromise;

    assert.strictEqual(health.trusted, true);
    assert.strictEqual(health.subscribedMarkets, 1);
    assert.strictEqual(typeof health.lastTrafficAt, 'string');
    assert.deepStrictEqual(service.getTradeIds(), ['u-t-1']);
  } finally {
    service.stop();
    await server.stop();
  }
}

async function testProductionReadinessRequiresActualEventReceipt(): Promise<void> {
  const server = new MockPolymarketWebSocketServer();
  const url = await server.start();
  const service = new UserWebSocketStateService(250, {
    url,
    auth: {
      apiKey: 'key-1',
      secret: 'secret-1',
      passphrase: 'pass-1',
    },
    fetchImpl: createGammaFetchStub([
      {
        id: 'm1',
        conditionId: 'cond-1',
        clobTokenIds: ['yes1', 'no1'],
      },
    ]),
    restClient: createScriptedRestClient({
      openOrders: [[]],
      trades: [[]],
    }),
    heartbeatIntervalMs: 1_000,
    bootstrapTimeoutMs: 150,
    bootstrapCatchupDelayMs: 25,
  });

  try {
    const step = await probeUserStreamReadiness({
      service,
      subscriptions: [
        {
          marketId: 'm1',
          tokenIds: ['yes1', 'no1'],
        },
      ],
      staleAfterMs: 250,
    });
    assert.strictEqual(step.ok, false);
    assert.notStrictEqual(step.reasonCode, null);
  } finally {
    service.stop();
    await server.stop();
  }
}

async function testProductionReadinessFreshnessTimeoutFailsClosed(): Promise<void> {
  const marketServer = new MockPolymarketWebSocketServer();
  const userServer = new MockPolymarketWebSocketServer();
  const marketUrl = await marketServer.start();
  const userUrl = await userServer.start();
  const marketService = new MarketWebSocketStateService(40, {
    url: marketUrl,
    restBaseUrl: 'https://clob.polymarket.com',
    fetchImpl: createMarketFetchStub({
      yes1: {
        bids: [{ price: '0.49', size: '10' }],
        asks: [{ price: '0.51', size: '12' }],
        tick_size: '0.01',
        min_order_size: '1',
        neg_risk: false,
        last_trade_price: '0.5',
        hash: 'rest-yes1',
      },
    }),
    heartbeatIntervalMs: 1_000,
    bootstrapTimeoutMs: 1_000,
  });
  const userService = new UserWebSocketStateService(40, {
    url: userUrl,
    auth: {
      apiKey: 'key-1',
      secret: 'secret-1',
      passphrase: 'pass-1',
    },
    fetchImpl: createGammaFetchStub([
      {
        id: 'm1',
        conditionId: 'cond-1',
        clobTokenIds: ['yes1', 'no1'],
      },
    ]),
    restClient: createScriptedRestClient({
      openOrders: [[], []],
      trades: [
        [
          {
            id: 'freshness-trade-1',
            orderId: null,
            tokenId: 'yes1',
            side: 'BUY',
            price: 0.5,
            size: 1,
            fee: 0.01,
            filledAt: new Date().toISOString(),
            status: 'MATCHED',
            raw: {},
          },
        ],
        [
          {
            id: 'freshness-trade-1',
            orderId: null,
            tokenId: 'yes1',
            side: 'BUY',
            price: 0.5,
            size: 1,
            fee: 0.01,
            filledAt: new Date().toISOString(),
            status: 'MATCHED',
            raw: {},
          },
        ],
      ],
    }),
    heartbeatIntervalMs: 1_000,
    bootstrapTimeoutMs: 1_000,
    bootstrapCatchupDelayMs: 25,
  });

  try {
    const marketStart = marketService.start(['yes1']);
    await marketServer.waitForJsonMessage(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        (message as Record<string, unknown>).type === 'market',
    );
    marketServer.send({
      event_type: 'book',
      asset_id: 'yes1',
      market: 'cond-1',
      bids: [{ price: '0.49', size: '10' }],
      asks: [{ price: '0.51', size: '12' }],
      timestamp: `${Date.now()}`,
      hash: 'freshness-market-1',
    });
    await marketStart;

    const userStart = userService.start([
      {
        marketId: 'm1',
        tokenIds: ['yes1', 'no1'],
      },
    ]);
    await userServer.waitForJsonMessage(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        (message as Record<string, unknown>).type === 'user',
    );
    userServer.send({
      event_type: 'trade',
      id: 'freshness-trade-1',
      asset_id: 'yes1',
      market: 'cond-1',
      side: 'BUY',
      price: '0.5',
      size: '1',
      status: 'MATCHED',
      taker_order_id: 'freshness-order-1',
      timestamp: `${Math.floor(Date.now() / 1000)}`,
    });
    await userStart;

    const marketHealth = marketService.evaluateHealth();
    const userHealth = userService.evaluateHealth();
    marketHealth.lastEventAt = new Date(Date.now() - 1_000).toISOString();
    userHealth.lastEventAt = new Date(Date.now() - 1_000).toISOString();
    marketHealth.lastTrafficAt = new Date(Date.now() - 1_000).toISOString();
    userHealth.lastTrafficAt = new Date(Date.now() - 1_000).toISOString();

    const step = probeCombinedStreamFreshness({
      marketHealth,
      userHealth,
      marketStaleAfterMs: 40,
      userStaleAfterMs: 40,
    });
    assert.strictEqual(step.ok, false);
    assert.strictEqual(step.reasonCode, 'stream_truth_stale');
  } finally {
    marketService.stop();
    userService.stop();
    await marketServer.stop();
    await userServer.stop();
  }
}

async function testProductionReadinessReconnectRecoveryUsesLivePath(): Promise<void> {
  const marketServer = new MockPolymarketWebSocketServer();
  const marketUrl = await marketServer.start();
  const marketDisconnect = createForcedDisconnectWebSocketFactory({
    disconnectAfterInboundFrames: 2,
  });

  const marketService = new MarketWebSocketStateService(250, {
    url: marketUrl,
    restBaseUrl: 'https://clob.polymarket.com',
    fetchImpl: createMarketFetchStub({
      yes1: {
        bids: [{ price: '0.49', size: '10' }],
        asks: [{ price: '0.51', size: '12' }],
        tick_size: '0.01',
        min_order_size: '1',
        neg_risk: false,
        last_trade_price: '0.5',
        hash: 'rest-yes1',
      },
    }),
    heartbeatIntervalMs: 50,
    reconnectBaseDelayMs: 20,
    reconnectMaxDelayMs: 80,
    reconnectMaxAttempts: 4,
    bootstrapTimeoutMs: 1_000,
    webSocketFactory: marketDisconnect.factory,
  });

  try {
    let marketSubscriptionIndex = 0;
    const marketResponder = setInterval(() => {
      const nextMessage = marketServer.jsonMessages[marketSubscriptionIndex] as
        | Record<string, unknown>
        | undefined;
      if (!nextMessage || nextMessage.type !== 'market') {
        return;
      }
      marketSubscriptionIndex += 1;
      marketServer.send({
        event_type: 'book',
        asset_id: 'yes1',
        market: 'cond-1',
        bids: [{ price: '0.49', size: '10' }],
        asks: [{ price: '0.51', size: '12' }],
        timestamp: `${Date.now() + marketSubscriptionIndex}`,
        hash: `reconnect-market-${marketSubscriptionIndex}`,
      });
    }, 10);

    const marketStep = await probeReconnectRecovery({
      name: 'market_stream_reconnect_recovery',
      starter: () => marketService.start(['yes1']),
      evaluator: () => marketService.evaluateHealth(),
      probe: marketDisconnect.probe,
      timeoutMs: 3_000,
    });

    clearInterval(marketResponder);
    assert.strictEqual(marketStep.ok, true);
    assert.strictEqual(marketDisconnect.probe.forcedDisconnects > 0, true);
  } finally {
    marketService.stop();
    await marketServer.stop();
  }
}

async function testProductionReadinessReconcilesAgainstStreamTruth(): Promise<void> {
  const server = new MockPolymarketWebSocketServer();
  const url = await server.start();
  const restClient = createScriptedRestClient({
    openOrders: [
      [
        {
          id: 'o-1',
          status: 'open',
          side: 'BUY',
          price: 0.5,
          size: 2,
          matchedSize: 1,
          tokenId: 'yes1',
          createdAt: new Date().toISOString(),
          raw: {},
        },
      ],
      [
        {
          id: 'o-1',
          status: 'open',
          side: 'BUY',
          price: 0.5,
          size: 2,
          matchedSize: 1,
          tokenId: 'yes1',
          createdAt: new Date().toISOString(),
          raw: {},
        },
      ],
    ],
    trades: [
      [
        {
          id: 't-1',
          orderId: 'o-1',
          tokenId: 'yes1',
          side: 'BUY',
          price: 0.5,
          size: 1,
          fee: 0.01,
          filledAt: new Date().toISOString(),
          status: 'MATCHED',
          raw: {},
        },
      ],
      [
        {
          id: 't-1',
          orderId: 'o-1',
          tokenId: 'yes1',
          side: 'BUY',
          price: 0.5,
          size: 1,
          fee: 0.01,
          filledAt: new Date().toISOString(),
          status: 'MATCHED',
          raw: {},
        },
      ],
    ],
  });
  const service = new UserWebSocketStateService(250, {
    url,
    auth: {
      apiKey: 'key-1',
      secret: 'secret-1',
      passphrase: 'pass-1',
    },
    fetchImpl: createGammaFetchStub([
      {
        id: 'm1',
        conditionId: 'cond-1',
        clobTokenIds: ['yes1', 'no1'],
      },
    ]),
    restClient,
    heartbeatIntervalMs: 25,
    bootstrapTimeoutMs: 1_000,
    bootstrapCatchupDelayMs: 50,
  });

  try {
    const startPromise = service.start([
      {
        marketId: 'm1',
        tokenIds: ['yes1', 'no1'],
      },
    ]);
    await server.waitForJsonMessage(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        (message as Record<string, unknown>).type === 'user',
    );
    server.send({
      event_type: 'order',
      id: 'o-1',
      asset_id: 'yes1',
      market: 'cond-1',
      side: 'BUY',
      price: '0.5',
      original_size: '2',
      size_matched: '1',
      type: 'UPDATE',
      timestamp: `${Math.floor(Date.now() / 1000)}`,
    });
    server.send({
      event_type: 'trade',
      id: 't-1',
      asset_id: 'yes1',
      market: 'cond-1',
      side: 'BUY',
      price: '0.5',
      size: '1',
      status: 'MATCHED',
      taker_order_id: 'o-1',
      timestamp: `${Math.floor(Date.now() / 1000)}`,
    });
    await startPromise;

    const step = await probeStreamReconciliation({
      userStreamService: service,
      tradingClient: {
        getOpenOrders: async () => restClient.getOpenOrders(),
        getTrades: async () => restClient.getTrades(),
      },
      externalPortfolioService: {
        capture: async () => createExternalPortfolioSnapshot(),
      } as Pick<ExternalPortfolioService, 'capture'>,
    });

    assert.strictEqual(step.ok, true);
    assert.strictEqual(step.name, 'stream_truth_reconciliation');
    assert.strictEqual(step.evidence.venueOpenOrders, 1);
    assert.strictEqual(step.evidence.venueTrades, 1);
  } finally {
    service.stop();
    await server.stop();
  }
}

async function testProductionReadinessObservesUserLifecycleEventsFromStream(): Promise<void> {
  const server = new MockPolymarketWebSocketServer();
  const url = await server.start();
  const service = new UserWebSocketStateService(250, {
    url,
    auth: {
      apiKey: 'key-1',
      secret: 'secret-1',
      passphrase: 'pass-1',
    },
    fetchImpl: createGammaFetchStub([
      {
        id: 'm1',
        conditionId: 'cond-1',
        clobTokenIds: ['yes1', 'no1'],
      },
    ]),
    restClient: createScriptedRestClient({
      openOrders: [[], []],
      trades: [
        [
          {
            id: 'bootstrap-trade',
            orderId: null,
            tokenId: 'yes1',
            side: 'BUY',
            price: 0.5,
            size: 1,
            fee: 0.01,
            filledAt: new Date().toISOString(),
            status: 'MATCHED',
            raw: {},
          },
        ],
        [
          {
            id: 'bootstrap-trade',
            orderId: null,
            tokenId: 'yes1',
            side: 'BUY',
            price: 0.5,
            size: 1,
            fee: 0.01,
            filledAt: new Date().toISOString(),
            status: 'MATCHED',
            raw: {},
          },
        ],
      ],
    }),
    heartbeatIntervalMs: 25,
    bootstrapTimeoutMs: 1_000,
    bootstrapCatchupDelayMs: 50,
  });

  try {
    const startPromise = service.start([
      {
        marketId: 'm1',
        tokenIds: ['yes1', 'no1'],
      },
    ]);
    await server.waitForJsonMessage(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        (message as Record<string, unknown>).type === 'user',
    );
    server.send({
      event_type: 'trade',
      id: 'bootstrap-trade',
      asset_id: 'yes1',
      market: 'cond-1',
      side: 'BUY',
      price: '0.5',
      size: '1',
      status: 'MATCHED',
      taker_order_id: 'bootstrap-order',
      timestamp: `${Math.floor(Date.now() / 1000)}`,
    });
    await startPromise;

    const result = await probeUserStreamLifecycleVisibility({
      service,
      timeoutMs: 1_500,
      smokeRunner: async () => {
        const baseTime = Math.floor(Date.now() / 1000);
        server.send({
          event_type: 'order',
          id: 'lifecycle-order-1',
          asset_id: 'yes1',
          market: 'cond-1',
          side: 'BUY',
          price: '0.5',
          original_size: '1',
          size_matched: '0',
          type: 'PLACEMENT',
          timestamp: `${baseTime}`,
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
        server.send({
          event_type: 'trade',
          id: 'lifecycle-trade-1',
          asset_id: 'yes1',
          market: 'cond-1',
          side: 'BUY',
          price: '0.5',
          size: '1',
          status: 'MATCHED',
          taker_order_id: 'lifecycle-order-1',
          timestamp: `${baseTime + 1}`,
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
        server.send({
          event_type: 'order',
          id: 'lifecycle-order-1',
          asset_id: 'yes1',
          market: 'cond-1',
          side: 'BUY',
          price: '0.5',
          original_size: '1',
          size_matched: '1',
          type: 'CANCELLATION',
          status: 'CANCELED',
          timestamp: `${baseTime + 2}`,
        });

        return {
          success: true,
          executedAt: new Date().toISOString(),
          freshnessTtlMs: 1_500,
          orderId: 'lifecycle-order-1',
          steps: [],
        };
      },
    });

    assert.strictEqual(result.step.ok, true);
    assert.strictEqual(result.step.name, 'user_stream_lifecycle_visibility');
    assert.strictEqual(result.step.evidence.appearedOrderId, 'lifecycle-order-1');
    assert.deepStrictEqual(result.step.evidence.newTradeIds, ['lifecycle-trade-1']);
    assert.strictEqual(result.step.evidence.disappearedAfterAppearance, true);
  } finally {
    service.stop();
    await server.stop();
  }
}

async function testProductionReadinessSuitePersistsLiveEvidence(): Promise<void> {
  await withSmokeEnv({}, async () => {
    const marketServer = new MockPolymarketWebSocketServer();
    const userServer = new MockPolymarketWebSocketServer();
    const marketUrl = await marketServer.start();
    const userUrl = await userServer.start();
    const checkpoints: Array<{
      cycleKey: string;
      source: string;
      status: string;
      details?: Record<string, unknown>;
    }> = [];
    const marketDisconnect = createForcedDisconnectWebSocketFactory({
      disconnectAfterInboundFrames: 2,
    });
    const userDisconnect = createForcedDisconnectWebSocketFactory({
      disconnectAfterInboundFrames: 2,
    });
    const tradingClient = createScriptedRestClient({
      openOrders: [[], [], [], [], [], []],
      trades: [
        [
          {
            id: 'bootstrap-trade',
            orderId: null,
            tokenId: 'yes1',
            side: 'BUY',
            price: 0.5,
            size: 1,
            fee: 0.01,
            filledAt: new Date().toISOString(),
            status: 'MATCHED',
            raw: {},
          },
        ],
        [
          {
            id: 'bootstrap-trade',
            orderId: null,
            tokenId: 'yes1',
            side: 'BUY',
            price: 0.5,
            size: 1,
            fee: 0.01,
            filledAt: new Date().toISOString(),
            status: 'MATCHED',
            raw: {},
          },
        ],
        [
          {
            id: 'bootstrap-trade',
            orderId: null,
            tokenId: 'yes1',
            side: 'BUY',
            price: 0.5,
            size: 1,
            fee: 0.01,
            filledAt: new Date().toISOString(),
            status: 'MATCHED',
            raw: {},
          },
          {
            id: 'readiness-trade-1',
            orderId: 'readiness-order-1',
            tokenId: 'yes1',
            side: 'BUY',
            price: 0.5,
            size: 1,
            fee: 0.01,
            filledAt: new Date().toISOString(),
            status: 'MATCHED',
            raw: {},
          },
        ],
        [
          {
            id: 'bootstrap-trade',
            orderId: null,
            tokenId: 'yes1',
            side: 'BUY',
            price: 0.5,
            size: 1,
            fee: 0.01,
            filledAt: new Date().toISOString(),
            status: 'MATCHED',
            raw: {},
          },
          {
            id: 'readiness-trade-1',
            orderId: 'readiness-order-1',
            tokenId: 'yes1',
            side: 'BUY',
            price: 0.5,
            size: 1,
            fee: 0.01,
            filledAt: new Date().toISOString(),
            status: 'MATCHED',
            raw: {},
          },
        ],
      ],
    });

    const marketService = new MarketWebSocketStateService(250, {
      url: marketUrl,
      restBaseUrl: 'https://clob.polymarket.com',
      fetchImpl: createMarketFetchStub({
        yes1: {
          bids: [{ price: '0.49', size: '10' }],
          asks: [{ price: '0.51', size: '12' }],
          tick_size: '0.01',
          min_order_size: '1',
          neg_risk: false,
          last_trade_price: '0.5',
          hash: 'rest-yes1',
        },
      }),
      heartbeatIntervalMs: 25,
      bootstrapTimeoutMs: 1_000,
    });
    const userService = new UserWebSocketStateService(250, {
      url: userUrl,
      auth: {
        apiKey: 'key-1',
        secret: 'secret-1',
        passphrase: 'pass-1',
      },
      fetchImpl: createGammaFetchStub([
        {
          id: 'm1',
          conditionId: 'cond-1',
          clobTokenIds: ['yes1', 'no1'],
        },
      ]),
      restClient: tradingClient,
      heartbeatIntervalMs: 25,
      bootstrapTimeoutMs: 1_000,
      bootstrapCatchupDelayMs: 25,
    });
    const reconnectMarketService = new MarketWebSocketStateService(250, {
      url: marketUrl,
      restBaseUrl: 'https://clob.polymarket.com',
      fetchImpl: createMarketFetchStub({
        yes1: {
          bids: [{ price: '0.49', size: '10' }],
          asks: [{ price: '0.51', size: '12' }],
          tick_size: '0.01',
          min_order_size: '1',
          neg_risk: false,
          last_trade_price: '0.5',
          hash: 'rest-yes1',
        },
      }),
      heartbeatIntervalMs: 25,
      reconnectBaseDelayMs: 20,
      reconnectMaxDelayMs: 80,
      reconnectMaxAttempts: 4,
      bootstrapTimeoutMs: 1_000,
      webSocketFactory: marketDisconnect.factory,
    });
    const reconnectUserService = new UserWebSocketStateService(250, {
      url: userUrl,
      auth: {
        apiKey: 'key-1',
        secret: 'secret-1',
        passphrase: 'pass-1',
      },
      fetchImpl: createGammaFetchStub([
        {
          id: 'm1',
          conditionId: 'cond-1',
          clobTokenIds: ['yes1', 'no1'],
        },
      ]),
      restClient: createScriptedRestClient({
        openOrders: [[], [], []],
        trades: [
          [
            {
              id: 'bootstrap-trade',
              orderId: null,
              tokenId: 'yes1',
              side: 'BUY',
              price: 0.5,
              size: 1,
              fee: 0.01,
              filledAt: new Date().toISOString(),
              status: 'MATCHED',
              raw: {},
            },
          ],
          [
            {
              id: 'bootstrap-trade',
              orderId: null,
              tokenId: 'yes1',
              side: 'BUY',
              price: 0.5,
              size: 1,
              fee: 0.01,
              filledAt: new Date().toISOString(),
              status: 'MATCHED',
              raw: {},
            },
          ],
          [
            {
              id: 'bootstrap-trade',
              orderId: null,
              tokenId: 'yes1',
              side: 'BUY',
              price: 0.5,
              size: 1,
              fee: 0.01,
              filledAt: new Date().toISOString(),
              status: 'MATCHED',
              raw: {},
            },
          ],
        ],
      }),
      heartbeatIntervalMs: 25,
      reconnectBaseDelayMs: 20,
      reconnectMaxDelayMs: 80,
      reconnectMaxAttempts: 4,
      bootstrapTimeoutMs: 1_000,
      bootstrapCatchupDelayMs: 25,
      webSocketFactory: userDisconnect.factory,
    });

    try {
      let marketSubscriptionsSeen = 0;
      let userSubscriptionsSeen = 0;
      const marketResponder = setInterval(() => {
        const nextMessage = marketServer.jsonMessages[marketSubscriptionsSeen] as
          | Record<string, unknown>
          | undefined;
        if (!nextMessage || nextMessage.type !== 'market') {
          return;
        }
        marketSubscriptionsSeen += 1;
        marketServer.send({
          event_type: 'book',
          asset_id: 'yes1',
          market: 'cond-1',
          bids: [{ price: '0.49', size: '10' }],
          asks: [{ price: '0.51', size: '12' }],
          timestamp: `${Date.now() + marketSubscriptionsSeen}`,
          hash: `readiness-market-${marketSubscriptionsSeen}`,
        });
      }, 10);
      const userResponder = setInterval(() => {
        const nextMessage = userServer.jsonMessages[userSubscriptionsSeen] as
          | Record<string, unknown>
          | undefined;
        if (!nextMessage || nextMessage.type !== 'user') {
          return;
        }
        userSubscriptionsSeen += 1;
        userServer.send({
          event_type: 'trade',
          id: 'bootstrap-trade',
          asset_id: 'yes1',
          market: 'cond-1',
          side: 'BUY',
          price: '0.5',
          size: '1',
          status: 'MATCHED',
          taker_order_id: 'bootstrap-order',
          timestamp: `${Math.floor(Date.now() / 1000) + userSubscriptionsSeen}`,
        });
      }, 10);

      const result = await runProductionReadiness({
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
        connectPrisma: false,
        marketStreamService: marketService,
        userStreamService: userService,
        reconnectMarketStreamService: {
          service: reconnectMarketService,
          probe: marketDisconnect.probe,
        },
        reconnectUserStreamService: {
          service: reconnectUserService,
          probe: userDisconnect.probe,
        },
        tradingClient: tradingClient as never,
        externalPortfolioService: {
          capture: async () => createExternalPortfolioSnapshot(),
        } as Pick<ExternalPortfolioService, 'capture'>,
        runtimeControl: {
          recordReconciliationCheckpoint: async (input) => {
            checkpoints.push(input);
          },
        },
        smokeRunner: async () => {
          const baseTime = Math.floor(Date.now() / 1000);
          userServer.send({
            event_type: 'order',
            id: 'readiness-order-1',
            asset_id: 'yes1',
            market: 'cond-1',
            side: 'BUY',
            price: '0.5',
            original_size: '1',
            size_matched: '0',
            type: 'PLACEMENT',
            timestamp: `${baseTime}`,
          });
          await new Promise((resolve) => setTimeout(resolve, 25));
          userServer.send({
            event_type: 'trade',
            id: 'readiness-trade-1',
            asset_id: 'yes1',
            market: 'cond-1',
            side: 'BUY',
            price: '0.5',
            size: '1',
            status: 'MATCHED',
            taker_order_id: 'readiness-order-1',
            timestamp: `${baseTime + 1}`,
          });
          await new Promise((resolve) => setTimeout(resolve, 25));
          userServer.send({
            event_type: 'order',
            id: 'readiness-order-1',
            asset_id: 'yes1',
            market: 'cond-1',
            side: 'BUY',
            price: '0.5',
            original_size: '1',
            size_matched: '1',
            type: 'CANCELLATION',
            status: 'CANCELED',
            timestamp: `${baseTime + 2}`,
          });

          return {
            success: true,
            executedAt: new Date().toISOString(),
            freshnessTtlMs: 1_500,
            orderId: 'readiness-order-1',
            steps: [],
          };
        },
      });

      clearInterval(marketResponder);
      clearInterval(userResponder);
      assert.strictEqual(
        result.steps.some((step) => step.name === 'stream_truth_reconciliation' && step.ok),
        true,
      );
      assert.strictEqual(
        result.steps.some((step) => step.name === 'user_stream_lifecycle_visibility' && step.ok),
        true,
      );
      assert.strictEqual(
        checkpoints.some(
          (checkpoint) =>
            checkpoint.source === 'production_readiness_stream_truth' &&
            checkpoint.status === (result.success ? 'completed' : 'failed') &&
            Array.isArray(checkpoint.details?.steps),
        ),
        true,
      );
      assert.strictEqual(
        checkpoints.some(
          (checkpoint) =>
            checkpoint.source === 'production_readiness_suite' &&
            checkpoint.status === (result.success ? 'completed' : 'failed') &&
            Array.isArray(checkpoint.details?.steps),
        ),
        true,
      );
    } finally {
      marketService.stop();
      userService.stop();
      reconnectMarketService.stop();
      reconnectUserService.stop();
      await marketServer.stop();
      await userServer.stop();
    }
  });
}

async function testProductionReadinessCommandExists(): Promise<void> {
  assert.strictEqual(
    fs.existsSync(path.join(repoRoot, 'apps/worker/src/smoke/production-readiness.ts')),
    true,
  );
  assert.strictEqual(
    fs.existsSync(path.join(repoRoot, 'scripts/run-production-readiness.sh')),
    true,
  );

  const workerPackage = fs.readFileSync(
    path.join(repoRoot, 'apps/worker/package.json'),
    'utf8',
  );
  assert.strictEqual(workerPackage.includes('readiness:production'), true);
}

async function testDocsDescribeProductionReadinessStreamProof(): Promise<void> {
  const architecture = fs.readFileSync(
    path.join(repoRoot, 'docs/architecture.md'),
    'utf8',
  );
  const tradingFlow = fs.readFileSync(
    path.join(repoRoot, 'docs/live-trading-flow.md'),
    'utf8',
  );
  const startStop = fs.readFileSync(
    path.join(repoRoot, 'docs/start-stop.md'),
    'utf8',
  );

  const combined = `${architecture}\n${tradingFlow}\n${startStop}`;
  assert.strictEqual(combined.includes('REST-only proof is insufficient'), true);
  assert.strictEqual(combined.includes('stream freshness'), true);
  assert.strictEqual(combined.includes('reconnect'), true);
  assert.strictEqual(combined.includes('actual incoming'), true);
}

async function testDocsDescribeCanonicalPolymarketSdkPath(): Promise<void> {
  const readme = fs.readFileSync(path.join(repoRoot, 'readme.md'), 'utf8');
  const architecture = fs.readFileSync(
    path.join(repoRoot, 'docs/architecture.md'),
    'utf8',
  );
  const tradingFlow = fs.readFileSync(
    path.join(repoRoot, 'docs/live-trading-flow.md'),
    'utf8',
  );
  const walletBootstrap = fs.readFileSync(
    path.join(repoRoot, 'docs/wallet-bootstrap.md'),
    'utf8',
  );

  for (const document of [readme, architecture, tradingFlow, walletBootstrap]) {
    assert.strictEqual(document.includes('server-side signing'), false);
  }

  assert.strictEqual(
    readme.includes('official Polymarket trading client'),
    true,
  );
  assert.strictEqual(
    architecture.includes('canonical trade-intent resolution'),
    true,
  );
  assert.strictEqual(
    tradingFlow.includes('official Polymarket trading client signs the order through the official SDK wallet path'),
    true,
  );
  assert.strictEqual(
    walletBootstrap.includes('official live Polymarket SDK client construction'),
    true,
  );
}

async function testFundingValidatorRejectsInsufficientBuyBalance(): Promise<void> {
  const validator = new PreTradeFundingValidator();
  const result = validator.validate({
    tokenId: 'yes1',
    side: 'BUY',
    price: 0.5,
    size: 4,
    snapshot: createExternalPortfolioSnapshot({
      cashBalance: 1,
      cashAllowance: 10,
      availableCapital: 10,
    }),
  });

  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.reasonCode, 'buy_balance_insufficient');
}

async function testFundingValidatorRejectsInsufficientSellInventory(): Promise<void> {
  const validator = new PreTradeFundingValidator();
  const result = validator.validate({
    tokenId: 'yes1',
    side: 'SELL',
    price: 0.5,
    size: 4,
    snapshot: createExternalPortfolioSnapshot({
      inventories: [
        createExternalInventorySnapshot({
          tokenId: 'yes1',
          marketId: 'm1',
          outcome: 'YES',
          balance: 2,
          allowance: 10,
          reservedQuantity: 0,
          freeQuantityBeforeAllowance: 2,
          freeQuantityAfterAllowance: 2,
          tradableSellHeadroom: 2,
          availableQuantity: 2,
          positionQuantity: 2,
          markPrice: 0.51,
          markedValue: 1.02,
        }),
      ],
    }),
  });

  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.reasonCode, 'sell_inventory_insufficient');
}

async function testFundingValidatorRejectsAllowanceAndReservedHeadroom(): Promise<void> {
  const validator = new PreTradeFundingValidator();

  const buyAllowance = validator.validate({
    tokenId: 'yes1',
    side: 'BUY',
    price: 0.5,
    size: 4,
    snapshot: createExternalPortfolioSnapshot({
      cashBalance: 10,
      cashAllowance: 1,
      availableCapital: 10,
    }),
  });
  assert.strictEqual(buyAllowance.reasonCode, 'buy_allowance_insufficient');

  const buyReserved = validator.validate({
    tokenId: 'yes1',
    side: 'BUY',
    price: 0.5,
    size: 4,
    snapshot: createExternalPortfolioSnapshot({
      cashBalance: 10,
      cashAllowance: 10,
      reservedCash: 9,
      freeCashBeforeAllowance: 1,
      freeCashAfterAllowance: 1,
      tradableBuyHeadroom: 1,
      availableCapital: 1,
    }),
  });
  assert.strictEqual(buyReserved.reasonCode, 'buy_reserved_headroom_exhausted');

  const sellAllowance = validator.validate({
    tokenId: 'yes1',
    side: 'SELL',
    price: 0.5,
    size: 4,
    snapshot: createExternalPortfolioSnapshot({
      inventories: [
        createExternalInventorySnapshot({
          tokenId: 'yes1',
          marketId: 'm1',
          outcome: 'YES',
          balance: 10,
          allowance: 1,
          reservedQuantity: 0,
          freeQuantityBeforeAllowance: 10,
          freeQuantityAfterAllowance: 1,
          tradableSellHeadroom: 1,
          availableQuantity: 1,
          positionQuantity: 10,
          markPrice: 0.51,
          markedValue: 5.1,
        }),
      ],
    }),
  });
  assert.strictEqual(sellAllowance.reasonCode, 'sell_allowance_insufficient');

  const sellReserved = validator.validate({
    tokenId: 'yes1',
    side: 'SELL',
    price: 0.5,
    size: 4,
    snapshot: createExternalPortfolioSnapshot({
      inventories: [
        createExternalInventorySnapshot({
          tokenId: 'yes1',
          marketId: 'm1',
          outcome: 'YES',
          balance: 10,
          allowance: 10,
          reservedQuantity: 8,
          freeQuantityBeforeAllowance: 2,
          freeQuantityAfterAllowance: 2,
          tradableSellHeadroom: 2,
          availableQuantity: 2,
          positionQuantity: 10,
          markPrice: 0.51,
          markedValue: 5.1,
        }),
      ],
    }),
  });
  assert.strictEqual(sellReserved.reasonCode, 'sell_reserved_inventory_exhausted');
}

async function testFundingValidatorRejectsStaleSnapshotAndAllowsValidOrder(): Promise<void> {
  const validator = new PreTradeFundingValidator();

  const stale = validator.validate({
    tokenId: 'yes1',
    side: 'BUY',
    price: 0.5,
    size: 2,
    snapshot: createExternalPortfolioSnapshot({
      freshnessState: 'stale',
    }),
  });
  assert.strictEqual(stale.reasonCode, 'external_portfolio_truth_stale');

  const healthy = validator.validate({
    tokenId: 'yes1',
    side: 'SELL',
    price: 0.5,
    size: 2,
    snapshot: createExternalPortfolioSnapshot(),
  });
  assert.strictEqual(healthy.passed, true);
  assert.strictEqual(healthy.reasonCode, null);
}

async function testExternalPortfolioServiceCapturesAuthenticatedTruth(): Promise<void> {
  const checkpoints: unknown[] = [];
  const prisma = {
    market: {
      findMany: async () => [createMarket()],
    },
    marketSnapshot: {
      findMany: async () => [
        {
          marketId: 'm1',
          marketPrice: 0.52,
          observedAt: new Date(),
        },
      ],
    },
    orderbook: {
      findMany: async () => [
        {
          marketId: 'm1',
          tokenId: 'yes1',
          bestBid: 0.5,
          bestAsk: 0.52,
          observedAt: new Date(),
        },
      ],
    },
    position: {
      findMany: async () => [
        {
          marketId: 'm1',
          tokenId: 'yes1',
          quantity: 7,
        },
      ],
    },
    order: {
      findMany: async () => [
        {
          marketId: 'm1',
          tokenId: 'yes1',
          venueOrderId: 'buy-1',
          status: 'submitted',
        },
        {
          marketId: 'm1',
          tokenId: 'yes1',
          venueOrderId: 'sell-1',
          status: 'submitted',
        },
      ],
    },
    fill: {
      findMany: async () => [
        {
          tokenId: 'yes1',
          filledAt: new Date(),
        },
      ],
    },
    portfolioSnapshot: {
      create: async () => ({ id: 'ps-auth-1' }),
    },
    reconciliationCheckpoint: {
      create: async ({ data }: { data: unknown }) => {
        checkpoints.push(data);
        return data;
      },
      findFirst: async () => null,
    },
  };

  const service = new ExternalPortfolioService(prisma as never, {
    getBalanceAllowance: async ({ assetType, tokenId }: { assetType: string; tokenId?: string }) =>
      assetType === 'COLLATERAL'
        ? {
            assetType: 'COLLATERAL',
            tokenId: null,
            balance: 100,
            allowance: 80,
            checkedAt: new Date().toISOString(),
            raw: {},
          }
        : {
            assetType: 'CONDITIONAL',
            tokenId: tokenId ?? null,
            balance: tokenId === 'yes1' ? 7 : 0,
            allowance: tokenId === 'yes1' ? 7 : 0,
            checkedAt: new Date().toISOString(),
            raw: {},
          },
    getOpenOrders: async () => [
      {
        id: 'buy-1',
        status: 'live',
        side: 'BUY',
        price: 0.5,
        size: 10,
        matchedSize: 2,
        tokenId: 'yes1',
        raw: {},
      },
      {
        id: 'sell-1',
        status: 'live',
        side: 'SELL',
        price: 0.55,
        size: 5,
        matchedSize: 1,
        tokenId: 'yes1',
        raw: {},
      },
    ],
    getTrades: async () => [
      {
        id: 'trade-1',
        orderId: 'buy-1',
        tokenId: 'yes1',
        side: 'BUY',
        price: 0.5,
        size: 2,
        fee: 0.2,
        filledAt: new Date().toISOString(),
        status: 'matched',
        raw: {},
      },
    ],
    getUserTrades: async () => [
      {
        id: 'data-trade-1',
        tokenId: 'yes1',
        marketId: 'm1',
        conditionId: null,
        side: 'BUY',
        price: 0.5,
        size: 2,
        outcome: 'YES',
        timestamp: new Date().toISOString(),
        transactionHash: '0xhash',
        raw: {},
      },
    ],
    getCurrentPositions: async () => [
      {
        tokenId: 'yes1',
        marketId: 'm1',
        conditionId: null,
        size: 7,
        avgPrice: 0.5,
        initialValue: 3.5,
        currentValue: 3.64,
        cashPnl: 0.14,
        realizedPnl: 0,
        currentPrice: 0.52,
        outcome: 'YES',
        oppositeTokenId: 'no1',
        endDate: null,
        negativeRisk: false,
        raw: {},
      },
    ],
    getClosedPositions: async () => [
      {
        tokenId: 'yes1',
        marketId: 'm1',
        conditionId: null,
        size: 1,
        avgPrice: 0.48,
        initialValue: 0.48,
        currentValue: 0,
        cashPnl: 0.02,
        realizedPnl: 0.02,
        currentPrice: 0,
        outcome: 'YES',
        oppositeTokenId: 'no1',
        endDate: null,
        negativeRisk: false,
        raw: {},
      },
    ],
  } as never);

  const snapshot = await service.capture();

  assert.strictEqual(snapshot.snapshotId, 'ps-auth-1');
  assert.strictEqual(snapshot.availableCapital, 76);
  assert.strictEqual(snapshot.reservedCash, 4);
  assert.strictEqual(snapshot.openOrderExposure, 6.2);
  assert.strictEqual(snapshot.realizedFees, 0.2);
  assert.strictEqual(snapshot.inventories[0]?.reservedQuantity, 4);
  assert.strictEqual(snapshot.inventories[0]?.availableQuantity, 3);
  assert.strictEqual(snapshot.cash.tradableBuyHeadroom, 76);
  assert.strictEqual(snapshot.inventories[0]?.positionQuantity, 7);
  assert.strictEqual(snapshot.positions.current[0]?.size, 7);
  assert.strictEqual(snapshot.positions.closed[0]?.realizedPnl, 0.02);
  assert.strictEqual(snapshot.freshness.allowNewEntries, true);
  assert.strictEqual(snapshot.divergence.status, 'none');
  assert.strictEqual(checkpoints.length > 0, true);
}

async function testExternalPortfolioServiceFlagsRecoverableDivergence(): Promise<void> {
  const prisma = {
    market: {
      findMany: async () => [createMarket()],
    },
    marketSnapshot: {
      findMany: async () => [],
    },
    orderbook: {
      findMany: async () => [],
    },
    position: {
      findMany: async () => [
        {
          marketId: 'm1',
          tokenId: 'yes1',
          quantity: 5,
        },
      ],
    },
    order: {
      findMany: async () => [],
    },
    fill: {
      findMany: async () => [
        {
          tokenId: 'yes1',
          filledAt: new Date(),
        },
      ],
    },
    reconciliationCheckpoint: {
      create: async () => null,
      findFirst: async () => null,
    },
    portfolioSnapshot: {
      create: async () => ({ id: 'ps-auth-2' }),
    },
  };

  const service = new ExternalPortfolioService(prisma as never, {
    getBalanceAllowance: async ({ assetType, tokenId }: { assetType: string; tokenId?: string }) =>
      assetType === 'COLLATERAL'
        ? {
            assetType: 'COLLATERAL',
            tokenId: null,
            balance: 50,
            allowance: 50,
            checkedAt: new Date().toISOString(),
            raw: {},
          }
        : {
            assetType: 'CONDITIONAL',
            tokenId: tokenId ?? null,
            balance: 7,
            allowance: 7,
            checkedAt: new Date().toISOString(),
            raw: {},
          },
    getOpenOrders: async () => [],
    getTrades: async () => [],
    getUserTrades: async () => [],
    getCurrentPositions: async () => [
      {
        tokenId: 'yes1',
        marketId: 'm1',
        conditionId: null,
        size: 7,
        avgPrice: 0.5,
        initialValue: 3.5,
        currentValue: 3.57,
        cashPnl: 0.07,
        realizedPnl: 0,
        currentPrice: 0.51,
        outcome: 'YES',
        oppositeTokenId: 'no1',
        endDate: null,
        negativeRisk: false,
        raw: {},
      },
    ],
    getClosedPositions: async () => [],
  } as never);

  const snapshot = await service.capture({
    persist: false,
  });

  assert.strictEqual(snapshot.divergence.status, 'recoverable');
  assert.strictEqual(
    snapshot.divergence.classes.includes('inventory_mismatch_vs_current_positions'),
    true,
  );
  assert.strictEqual(snapshot.recovery.mode, 'rebuild_local_positions');
  assert.strictEqual(snapshot.tradingPermissions?.allowNewEntries, false);
  assert.strictEqual(snapshot.inventories[0]?.positionQuantity, 7);
  assert.strictEqual(snapshot.inventories[0]?.tradableSellHeadroom, 7);
}

async function testExternalPortfolioLoadLatestSnapshotRecomputesFreshness(): Promise<void> {
  const staleFetchedAt = new Date(Date.now() - 400_000).toISOString();
  const stored = createExternalPortfolioSnapshot({
    freshnessState: 'fresh',
    freshness: {
      ...createExternalPortfolioSnapshot().freshness,
      components: {
        ...createExternalPortfolioSnapshot().freshness.components,
        balances: {
          ...createExternalPortfolioSnapshot().freshness.components.balances,
          fetchedAt: staleFetchedAt,
        },
      },
    },
  });

  const service = new ExternalPortfolioService(
    {
      reconciliationCheckpoint: {
        findFirst: async () => ({
          details: {
            snapshot: stored,
          },
        }),
      },
    } as never,
    {} as never,
  );

  const loaded = await service.loadLatestSnapshot();

  assert.ok(loaded);
  assert.strictEqual(loaded?.freshness.overallVerdict, 'stale');
  assert.strictEqual(loaded?.freshnessState, 'stale');
}

async function testExecutionRejectsStaleExternalPortfolioTruth(): Promise<void> {
  let rejectionReason: string | null = null;
  let orderCreates = 0;

  const prisma = {
    signal: {
      findMany: async () => [createExecutionSignal()],
      update: async () => null,
    },
    signalDecision: {
      findFirst: async () => ({ positionSize: 10, verdict: 'approved' }),
      create: async ({ data }: { data: { reasonCode: string } }) => {
        rejectionReason = data.reasonCode;
      },
    },
    market: {
      findUnique: async () => createMarket(),
    },
    marketSnapshot: {
      findFirst: async () => createFreshSnapshot(),
    },
    orderbook: {
      findFirst: async () => createFreshOrderbook(),
    },
    order: {
      findFirst: async () => null,
      create: async () => {
        orderCreates += 1;
      },
    },
    auditEvent: {
      create: async () => null,
    },
    portfolioSnapshot: {
      findFirst: async () => createFreshPortfolioSnapshot(),
    },
    reconciliationCheckpoint: {
      findFirst: async ({ where }: { where: { source: string } }) =>
        createFreshReconciliationCheckpoint(where.source),
    },
    botRuntimeStatus: {
      findUnique: async () => createFreshRuntimeStatus(),
    },
    liveConfig: {
      findUnique: async () => ({ id: 'live', noTradeWindowSeconds: 30 }),
    },
  };

  const job = new ExecuteOrdersJob(prisma as never);
  stubExternalPortfolioService(
    job,
    createExternalPortfolioSnapshot({
      freshnessState: 'stale',
    }),
  );

  const result = await job.run({ canSubmit: () => true });

  assert.strictEqual(result.submitted, 0);
  assert.strictEqual(result.rejected, 1);
  assert.strictEqual(orderCreates, 0);
  assert.strictEqual(rejectionReason, 'external_portfolio_truth_stale');
}

async function testVenueHeartbeatStartsAndStopsWithOpenOrders(): Promise<void> {
  let workingOpenOrders = 1;
  const checkpoints: Array<{ source: string; status: string }> = [];

  const service = new VenueOpenOrderHeartbeatService(
    {
      order: {
        count: async () => workingOpenOrders,
      },
    } as never,
    {
      recordReconciliationCheckpoint: async ({
        source,
        status,
      }: {
        source: string;
        status: string;
      }) => {
        checkpoints.push({ source, status });
      },
    } as never,
    async () => undefined,
    {
      postHeartbeat: async () => ({
        success: true,
        heartbeatId: 'hb-1',
        error: null,
        raw: {},
      }),
    } as never,
  );

  await service.sync();
  assert.strictEqual(service.isRunning(), true);

  workingOpenOrders = 0;
  await service.sync();
  assert.strictEqual(service.isRunning(), false);
  assert.strictEqual(
    checkpoints.some((entry) => entry.source === 'venue_open_orders_heartbeat'),
    true,
  );
}

async function testVenueHeartbeatFailureTriggersProtectiveCallback(): Promise<void> {
  let protectedState = false;
  const checkpoints: Array<{ status: string }> = [];

  const service = new VenueOpenOrderHeartbeatService(
    {
      order: {
        count: async () => 1,
      },
    } as never,
    {
      recordReconciliationCheckpoint: async ({
        status,
      }: {
        status: string;
      }) => {
        checkpoints.push({ status });
      },
    } as never,
    async () => {
      protectedState = true;
    },
    {
      postHeartbeat: async () => {
        throw new Error('heartbeat down');
      },
    } as never,
  );

  const result = await service.beatOnce();

  assert.strictEqual(result, false);
  assert.strictEqual(protectedState, true);
  assert.strictEqual(checkpoints.some((entry) => entry.status === 'sync_failed'), true);
}

async function testExecutionReadinessRequiresVenueHeartbeatWhenOrdersExist(): Promise<void> {
  let orderCreates = 0;
  let auditEventType: string | null = null;

  const prisma = {
    signal: {
      findMany: async () => [createExecutionSignal()],
      update: async () => null,
    },
    signalDecision: {
      findFirst: async () => ({ positionSize: 10, verdict: 'approved' }),
      create: async () => null,
    },
    market: {
      findUnique: async () => createMarket(),
    },
    marketSnapshot: {
      findFirst: async () => createFreshSnapshot(),
    },
    orderbook: {
      findFirst: async () => createFreshOrderbook(),
    },
    order: {
      findFirst: async () => null,
      create: async () => {
        orderCreates += 1;
      },
      count: async () => 1,
    },
    auditEvent: {
      create: async ({ data }: { data: { eventType: string } }) => {
        auditEventType = data.eventType;
      },
    },
    portfolioSnapshot: {
      findFirst: async () => createFreshPortfolioSnapshot(),
    },
    reconciliationCheckpoint: {
      findFirst: async ({ where }: { where: { source: string } }) => {
        if (where.source === 'venue_open_orders_heartbeat') {
          return null;
        }
        return createFreshReconciliationCheckpoint(where.source);
      },
    },
    botRuntimeStatus: {
      findUnique: async () => createFreshRuntimeStatus(),
    },
    liveConfig: {
      findUnique: async () => ({ id: 'live', noTradeWindowSeconds: 30 }),
    },
  };

  const job = new ExecuteOrdersJob(prisma as never);
  const result = await job.run({ canSubmit: () => true });

  assert.strictEqual(result.submitted, 0);
  assert.strictEqual(result.rejected, 0);
  assert.strictEqual(orderCreates, 0);
  assert.strictEqual(auditEventType, 'execution.runtime_freshness_veto');
}

async function testSmokeHarnessFailsClosedWithoutExecuteGuard(): Promise<void> {
  assert.throws(
    () =>
      parsePolymarketSmokeEnv({
        POLY_CLOB_HOST: 'http://localhost',
        POLY_CHAIN_ID: '137',
        POLY_PRIVATE_KEY:
          '0x1111111111111111111111111111111111111111111111111111111111111111',
        POLY_API_KEY: 'key',
        POLY_API_SECRET: 'secret',
        POLY_API_PASSPHRASE: 'pass',
        POLY_SMOKE_TOKEN_ID: 'yes1',
        POLY_SMOKE_PRICE: '0.5',
        POLY_SMOKE_SIZE: '1',
        POLY_SMOKE_EXECUTE: 'false',
      }),
    /POLY_SMOKE_EXECUTE=true is required/,
  );
}

async function testSafetyStateMachineEscalatesAndRespectsCooldown(): Promise<void> {
  const machine = new SafetyStateMachine();
  const escalated = machine.evaluate({
    currentState: 'normal',
    currentStateEnteredAt: new Date(Date.now() - 60_000).toISOString(),
    dailyLossRatio: 0.8,
    consecutiveLosses: 1,
    maxConsecutiveLosses: 3,
    killSwitchTriggers: [],
    lossAttributionSummary: {
      dominantCause: 'execution_error',
      dominantConfidence: 0.7,
      weightedConfidenceByCause: {
        model_error: 0,
        execution_error: 0.7,
        stale_data: 0,
        venue_rejection: 0,
        liquidity_decay: 0,
        regime_mismatch: 0,
      },
      episodeCount: 1,
    },
  });

  assert.strictEqual(escalated.state, 'passive_only');
  assert.strictEqual(escalated.allowAggressiveEntries, false);

  const cooledTooSoon = machine.evaluate({
    currentState: 'passive_only',
    currentStateEnteredAt: new Date(Date.now() - 60_000).toISOString(),
    dailyLossRatio: 0,
    consecutiveLosses: 0,
    maxConsecutiveLosses: 3,
    killSwitchTriggers: [],
    lossAttributionSummary: null,
  });

  assert.strictEqual(cooledTooSoon.state, 'passive_only');

  const cooledEnough = machine.evaluate({
    currentState: 'passive_only',
    currentStateEnteredAt: new Date(Date.now() - 11 * 60_000).toISOString(),
    dailyLossRatio: 0,
    consecutiveLosses: 0,
    maxConsecutiveLosses: 3,
    killSwitchTriggers: [],
    lossAttributionSummary: null,
  });

  assert.strictEqual(cooledEnough.state, 'normal');
}

async function testExecutionQualityKillSwitchesCompoundWarnings(): Promise<void> {
  const killSwitches = new ExecutionQualityKillSwitches();
  const result = killSwitches.evaluate({
    diagnostics: Array.from({ length: 5 }, () => ({
      expectedSlippage: 0.01,
      realizedSlippage: 0.03,
      expectedEv: 0.05,
      realizedEv: -0.02,
      staleOrder: false,
    })),
    postFailureCount: 4,
    cancelFailureCount: 2,
    cancelFailuresWithWorkingOrders: 1,
    heartbeatFailuresWithOpenOrders: 1,
    divergenceStatus: 'warning',
    staleBookRejectCount: 4,
    totalRecentDecisions: 5,
  });

  const families = new Set(result.triggers.map((trigger) => trigger.family));
  assert.strictEqual(families.has('fill_quality'), true);
  assert.strictEqual(families.has('post_failures'), true);
  assert.strictEqual(families.has('cancel_failures'), true);
  assert.strictEqual(families.has('heartbeat_failures'), true);
  assert.strictEqual(families.has('divergence'), true);
  assert.strictEqual(families.has('stale_book'), true);
}

async function testMultiDimensionalPositionLimitsBlockSameThesisExposure(): Promise<void> {
  const limits = new MultiDimensionalPositionLimits();
  const result = limits.evaluate({
    candidate: {
      marketId: 'm2',
      outcome: 'YES',
      resolutionBucket: '2026-03-22T10:00:00.000Z',
      thesisKey: 'btc_5m:BUY:YES',
      notional: 20,
    },
    openPositions: [
      {
        marketId: 'm1',
        outcome: 'YES',
        resolutionBucket: '2026-03-22T10:00:00.000Z',
        thesisKey: 'btc_5m:BUY:YES',
        notional: 15,
      },
    ],
    workingOrders: [
      {
        marketId: 'm3',
        outcome: 'YES',
        resolutionBucket: '2026-03-22T10:05:00.000Z',
        thesisKey: 'btc_5m:BUY:YES',
        notional: 10,
      },
    ],
    limits: {
      maxPerMarketNotional: 100,
      maxPerOutcomeNotional: 100,
      maxPerResolutionBucketNotional: 100,
      maxAggregateNotional: 100,
      maxSameThesisNotional: 30,
    },
  });

  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.reasonCode, 'same_thesis_limit_exceeded');
}

async function testLossAttributionPrefersExecutionError(): Promise<void> {
  const attribution = new LossAttributionModel();
  const result = attribution.attribute({
    pnl: -15,
    expectedEv: 4,
    expectedSlippage: 0.01,
    realizedSlippage: 0.04,
    executionFailure: true,
  });

  assert.strictEqual(result.dominantCause, 'execution_error');
  assert.strictEqual(result.dominantConfidence > 0.7, true);
}

async function testEvaluateTradeOpportunitiesRejectsSameThesisExposure(): Promise<void> {
  let rejectedReason: string | null = null;

  const prisma = {
    signal: {
      findMany: async () => [
        createExecutionSignal({
          posteriorProbability: 0.8,
          edge: 0.2,
          expectedEv: 0.12,
        }),
      ],
      update: async () => null,
    },
    portfolioSnapshot: {
      findFirst: async () => ({
        bankroll: 100,
        availableCapital: 100,
        realizedPnlDay: 0,
        consecutiveLosses: 0,
        capturedAt: new Date(),
      }),
    },
    position: {
      findMany: async () => [
        {
          marketId: 'm0',
          tokenId: 'yes0',
          outcome: 'YES',
          quantity: 40,
          entryPrice: 0.5,
          status: 'open',
        },
      ],
    },
    order: {
      findMany: async () => [
        {
          marketId: 'm9',
          tokenId: 'yes9',
          outcome: 'YES',
          price: 1,
          size: 10,
          remainingSize: 10,
          status: 'submitted',
        },
      ],
    },
    signalDecision: {
      findFirst: async () => null,
      findMany: async () => [],
      create: async ({ data }: { data: { reasonCode: string } }) => {
        rejectedReason = data.reasonCode;
      },
    },
    market: {
      findMany: async () => [
        createMarket(),
        {
          id: 'm0',
          expiresAt: new Date(Date.now() + 120_000),
        },
        {
          id: 'm9',
          expiresAt: new Date(Date.now() + 120_000),
        },
      ],
    },
    orderbook: {
      findFirst: async () => createFreshOrderbook({ spread: 0.02 }),
    },
    marketSnapshot: {
      findFirst: async () => createFreshSnapshot(),
    },
    reconciliationCheckpoint: {
      findFirst: async ({ where }: { where: { source: string } }) =>
        createFreshReconciliationCheckpoint(where.source),
    },
    botRuntimeStatus: {
      findUnique: async () => createFreshRuntimeStatus(),
    },
    executionDiagnostic: {
      findMany: async () => [],
    },
    auditEvent: {
      findMany: async () => [],
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

  const job = new EvaluateTradeOpportunitiesJob(prisma as never, runtimeControl as never);
  const result = await job.run({
    ...createRuntimeConfig(),
    maxOpenPositions: 5,
  });

  assert.strictEqual(result.approved, 0);
  assert.strictEqual(result.rejected, 1);
  assert.strictEqual(rejectedReason === 'passed', false);
}

async function testEvaluateTradeOpportunitiesTriggersSafetyHaltOnExecutionBreakage(): Promise<void> {
  let rejectedReason: string | null = null;
  let transitionState: string | null = null;

  const prisma = {
    signal: {
      findMany: async () => [createExecutionSignal()],
      update: async () => null,
    },
    portfolioSnapshot: {
      findFirst: async () => ({
        bankroll: 1000,
        availableCapital: 1000,
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
      create: async ({ data }: { data: { reasonCode: string } }) => {
        rejectedReason = data.reasonCode;
      },
    },
    market: {
      findMany: async () => [createMarket()],
    },
    orderbook: {
      findFirst: async () => createFreshOrderbook(),
    },
    marketSnapshot: {
      findFirst: async () => createFreshSnapshot(),
    },
    reconciliationCheckpoint: {
      findFirst: async ({ where }: { where: { source: string } }) =>
        createFreshReconciliationCheckpoint(where.source),
    },
    botRuntimeStatus: {
      findUnique: async () => createFreshRuntimeStatus(),
    },
    executionDiagnostic: {
      findMany: async () =>
        Array.from({ length: 5 }, () => ({
          expectedSlippage: 0.01,
          realizedSlippage: 0.04,
          expectedEv: 0.05,
          realizedEv: -0.03,
          staleOrder: false,
        })),
    },
    auditEvent: {
      findMany: async () => [],
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
    recordSafetyStateTransition: async ({
      state,
    }: {
      state: { state: string };
    }) => {
      transitionState = state.state;
    },
  };

  const job = new EvaluateTradeOpportunitiesJob(prisma as never, runtimeControl as never);
  const result = await job.run(createRuntimeConfig());

  assert.strictEqual(result.killSwitchTriggered, true);
  assert.strictEqual(result.safetyState, 'halt');
  assert.strictEqual(transitionState, 'halt');
  assert.strictEqual(rejectedReason, 'fill_quality_deterioration');
}

async function testExecuteOrdersBlocksAggressiveEntryInPassiveOnlyState(): Promise<void> {
  let rejectedReason: string | null = null;
  let orderCreates = 0;

  const prisma = {
    liveConfig: {
      findUnique: async () => ({ id: 'live', noTradeWindowSeconds: 5 }),
    },
    signal: {
      findMany: async () => [createExecutionSignal()],
      update: async () => null,
    },
    signalDecision: {
      findFirst: async () => ({ positionSize: 10, verdict: 'approved' }),
      create: async ({ data }: { data: { reasonCode: string } }) => {
        rejectedReason = data.reasonCode;
      },
    },
    market: {
      findUnique: async () => createMarket(),
    },
    marketSnapshot: {
      findFirst: async () => ({
        observedAt: new Date(),
        expiresAt: new Date(Date.now() + 15_000),
      }),
    },
    orderbook: {
      findFirst: async () =>
        createFreshOrderbook({
          bestBid: 0.5,
          bestAsk: 0.51,
        }),
    },
    order: {
      findFirst: async () => null,
      create: async () => {
        orderCreates += 1;
      },
      count: async () => 0,
      findMany: async () => [],
    },
    auditEvent: {
      create: async () => null,
    },
    portfolioSnapshot: {
      findFirst: async () => createFreshPortfolioSnapshot(),
    },
    reconciliationCheckpoint: {
      findFirst: async ({ where }: { where: { source: string } }) =>
        createFreshReconciliationCheckpoint(where.source),
    },
    botRuntimeStatus: {
      findUnique: async () => createFreshRuntimeStatus(),
    },
    executionDiagnostic: {
      create: async () => null,
    },
  };

  const runtimeControl = {
    getLatestSafetyState: async () => ({
      state: 'passive_only',
      enteredAt: new Date().toISOString(),
      reasonCodes: ['fill_quality_deterioration'],
      sizeMultiplier: 0.55,
      evaluationCadenceMultiplier: 2,
      allowAggressiveEntries: false,
      allowNewEntries: true,
      haltRequested: false,
      maxNewSignalsPerTick: 1,
      evidence: {},
    }),
    assessOperationalFreshness: async () => ({
      healthy: true,
      reasonCode: null,
      details: {
        lastPortfolioSnapshotAt: new Date(),
        lastOpenOrdersCheckpointAt: new Date(),
        lastFillCheckpointAt: new Date(),
        lastExternalPortfolioCheckpointAt: new Date(),
        lastVenueHeartbeatAt: new Date(),
        workingOpenOrders: 0,
      },
    }),
  };

  const job = new ExecuteOrdersJob(prisma as never, runtimeControl as never);
  stubExternalPortfolioService(job);
  const result = await job.run({ canSubmit: () => true });

  assert.strictEqual(result.submitted, 0);
  assert.strictEqual(result.rejected, 1);
  assert.strictEqual(rejectedReason, 'safety_state_passive_only');
  assert.strictEqual(orderCreates, 0);
}

async function testManageOpenOrdersSurfacesCancelFailure(): Promise<void> {
  let orderLastError: string | null = null;

  const prisma = {
    order: {
      findMany: async () => [
        {
          id: 'o1',
          venueOrderId: 'v1',
          marketId: 'm1',
          signalId: 's1',
          tokenId: 'yes1',
          status: 'submitted',
          createdAt: new Date(),
          price: 0.5,
          size: 10,
          remainingSize: 10,
        },
      ],
      update: async ({ data }: { data: { lastError: string } }) => {
        orderLastError = data.lastError;
      },
    },
    auditEvent: {
      create: async () => null,
    },
  };

  const job = new ManageOpenOrdersJob(prisma as never);
  (job as any).fetchVenueOpenOrders = async () => ({
    ok: true,
    orders: [
      {
        venueOrderId: 'v1',
        status: 'open',
        side: 'BUY',
        price: 0.5,
        size: 10,
        matchedSize: 0,
        tokenId: 'yes1',
      },
    ],
  });
  (job as any).fetchOrderScoringStatuses = async () => new Map();
  (job as any).tradingClient = {
    cancelOrder: async () => {
      throw new Error('cancel_down');
    },
  };
  (job as any).cancelVenueOrder = async () => {
    throw new Error('cancel_down');
  };

  await job.run({ forceCancelAll: true });

  assert.strictEqual(orderLastError, 'cancel_down');
}

async function testReconcileFillsCreatesExecutionDiagnosticSnapshot(): Promise<void> {
  let diagnosticCreateCalls = 0;
  const fills: Array<Record<string, unknown>> = [];

  const prisma = {
    fill: {
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        fills.push(data);
        return null;
      },
      findMany: async () => fills,
    },
    order: {
      findFirst: async () => ({
        id: 'o1',
        venueOrderId: 'venue-o1',
        marketId: 'm1',
        tokenId: 'yes1',
        signalId: 's1',
        strategyVersionId: 'sv1',
        side: 'BUY',
        size: 10,
        price: 0.5,
        expectedEv: 0.08,
        filledSize: 0,
        remainingSize: 10,
        avgFillPrice: null,
        lastVenueStatus: null,
        lastVenueSyncAt: null,
        createdAt: new Date('2026-03-27T10:00:00.000Z'),
        postedAt: new Date('2026-03-27T10:00:05.000Z'),
        acknowledgedAt: null,
      }),
      findMany: async () => [],
      update: async () => null,
    },
    signal: {
      findUnique: async () => ({
        id: 's1',
        regime: 'balanced_rotation',
        observedAt: new Date('2026-03-27T09:59:50.000Z'),
        createdAt: new Date('2026-03-27T09:59:55.000Z'),
      }),
    },
    executionDiagnostic: {
      create: async () => {
        diagnosticCreateCalls += 1;
      },
    },
    auditEvent: {
      findFirst: async () => null,
      create: async () => null,
    },
  };

  const runtimeControl = {
    recordReconciliationCheckpoint: async () => null,
  };

  const job = new ReconcileFillsJob(prisma as never, runtimeControl as never);
  (job as any).fetchVenueTrades = async () => ({
    ok: true,
    trades: [
      {
        id: 't1',
        orderId: 'o1',
        price: 0.53,
        size: 4,
        fee: 0.01,
        filledAt: new Date().toISOString(),
      },
    ],
    error: null,
  });

  const result = await job.run();

  assert.strictEqual(result.fillsInserted, 1);
  assert.strictEqual(diagnosticCreateCalls, 1);
}

async function testOrderIntentIdentityStableAcrossRetry(): Promise<void> {
  const service = new OrderIntentService();
  const first = service.identify({
    source: 'signal:s1:epoch:0',
    marketId: 'm1',
    tokenId: 'yes1',
    side: 'BUY',
    intent: 'ENTER',
    price: 0.52,
    size: 10,
    orderType: 'GTC',
    expiration: null,
  });
  const second = service.identify({
    source: 'signal:s1:epoch:0',
    marketId: 'm1',
    tokenId: 'yes1',
    side: 'BUY',
    intent: 'ENTER',
    price: 0.52,
    size: 10,
    orderType: 'GTC',
    expiration: null,
  });
  const replacement = service.identify({
    source: 'signal:s1:epoch:1',
    marketId: 'm1',
    tokenId: 'yes1',
    side: 'BUY',
    intent: 'ENTER',
    price: 0.52,
    size: 10,
    orderType: 'GTC',
    expiration: null,
  });

  assert.strictEqual(first.intentId, second.intentId);
  assert.strictEqual(first.clientOrderId, second.clientOrderId);
  assert.notStrictEqual(first.intentId, replacement.intentId);
}

async function testExecutionReplayProtectionBlocksDuplicateSubmit(): Promise<void> {
  let orderCreates = 0;
  let sawTruthPendingAudit = false;

  const prisma = {
    signal: {
      findMany: async () => [createExecutionSignal()],
      update: async () => null,
    },
    signalDecision: {
      findFirst: async () => ({ positionSize: 5, verdict: 'approved' }),
      create: async () => null,
    },
    market: {
      findUnique: async () => createMarket(),
    },
    orderbook: {
      findFirst: async () => createFreshOrderbook({ spread: 0.02 }),
    },
    marketSnapshot: {
      findFirst: async () => createFreshSnapshot(),
    },
    order: {
      findFirst: async () => null,
      create: async () => {
        orderCreates += 1;
      },
      count: async () => 0,
    },
    auditEvent: {
      create: async ({ data }: { data: { eventType: string } }) => {
        sawTruthPendingAudit = sawTruthPendingAudit || data.eventType === 'order.intent.truth_pending';
      },
    },
    liveConfig: {
      findUnique: async () => ({ id: 'live' }),
    },
    reconciliationCheckpoint: {
      findFirst: async () => createFreshReconciliationCheckpoint('external_portfolio_reconcile'),
    },
    botRuntimeStatus: {
      findUnique: async () => createFreshRuntimeStatus(),
    },
  };

  const job = new ExecuteOrdersJob(prisma as never);
  stubExternalPortfolioService(job);
  (job as any).runtimeControl = {
    assessOperationalFreshness: async () => ({ healthy: true, reasonCode: null }),
    getLatestSafetyState: async () => ({
      state: 'normal',
      enteredAt: new Date().toISOString(),
      reasonCodes: [],
      sizeMultiplier: 1,
      evaluationCadenceMultiplier: 1,
      allowAggressiveEntries: true,
      allowNewEntries: true,
      haltRequested: false,
      maxNewSignalsPerTick: 4,
      evidence: {},
    }),
    updateRuntimeStatus: async () => null,
  };
  (job as any).orderIntentRepository = {
    loadLatest: async () => ({
      intentId: 'intent_prior',
      status: 'unknown_visibility',
      orderId: null,
      venueOrderId: null,
      clientOrderId: 'coid_prior',
      signalId: 's1',
      marketId: 'm1',
      tokenId: 'yes1',
      fingerprint: 'fp',
      attempts: 1,
      updatedAt: new Date().toISOString(),
    }),
    record: async () => null,
  };

  const result = await job.run({ runtimeState: 'running' });

  assert.strictEqual(result.submitted, 0);
  assert.strictEqual(orderCreates, 0);
  assert.strictEqual(sawTruthPendingAudit, true);
}

async function testVenueAwarenessBudgetsAreScoped(): Promise<void> {
  let now = 0;
  const sleeps: number[] = [];
  const awareness = new PolymarketVenueAwareness({
    host: 'http://localhost',
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });

  await assert.rejects(
    () =>
      awareness.execute('public', 'get_markets', async () => {
        throw {
          status: 429,
          message: 'Too many requests. Retry after 900ms',
          data: { retry_after_ms: 900 },
        };
      }),
    (error: unknown) => error instanceof Error && error.message.includes('[rate_limited]'),
  );

  await awareness.execute('submit', 'post_order', async () => 'ok');

  assert.strictEqual(sleeps.some((value) => value >= 900), false);
  assert.strictEqual(awareness.getGovernanceSnapshot().nextAllowedAtByScope.public >= 900, true);
}

async function testFillStateTracksPartialFillResidualsAndGhostExposure(): Promise<void> {
  const service = new FillStateService();
  const partial = service.applyFill({
    state: {
      intendedSize: 10,
      cumulativeFilledSize: 0,
      averageFillPrice: null,
      remainingSize: 10,
      cumulativeFees: 0,
      lastVisibleVenueState: 'submitted',
      lastUserStreamUpdateAt: null,
      lastRestConfirmationAt: null,
    },
    fillPrice: 0.53,
    fillSize: 4,
    fee: 0.02,
    venueState: 'partially_filled',
    observedAt: new Date().toISOString(),
  });

  assert.strictEqual(partial.cumulativeFilledSize, 4);
  assert.strictEqual(partial.remainingSize, 6);
  assert.strictEqual(partial.averageFillPrice, 0.53);
  assert.strictEqual(
    service.decideResidual({
      remainingSize: 0.4,
      minMeaningfulSize: 1,
      signalAgeMs: 5_000,
      maxSignalAgeMs: 20_000,
      priceDriftBps: 2,
      fillProbability: 0.7,
    }),
    'cancel',
  );
  assert.strictEqual(
    service.detectGhostExposure({
      localOrderIds: ['o1'],
      venueOrderIds: ['o1'],
      userStreamOrderIds: ['o1'],
      unresolvedIntentIds: ['intent_pending'],
    }),
    true,
  );
}

async function testInventoryLiquidationPolicyHandlesSoftAndHardTriggers(): Promise<void> {
  const policy = new InventoryLiquidationPolicy();
  const soft = policy.evaluate([
    {
      trigger: 'near_expiry',
      active: true,
      severity: 'medium',
      reasonCode: 'liquidation_near_expiry',
      affectedMarketIds: ['m1'],
    },
  ]);
  const hard = policy.evaluate([
    {
      trigger: 'user_stream_lost',
      active: true,
      severity: 'high',
      reasonCode: 'user_stream_stale',
    },
    {
      trigger: 'market_closed_only',
      active: true,
      severity: 'high',
      reasonCode: 'venue_closed_only',
      affectedMarketIds: ['m1'],
    },
  ]);

  assert.strictEqual(soft.mode, 'soft_reduce');
  assert.strictEqual(soft.transitionTo, 'degraded');
  assert.strictEqual(hard.mode, 'hard_flatten');
  assert.strictEqual(hard.transitionTo, 'reconciliation_only');
  assert.strictEqual(hard.forceCancelAll, true);
}

async function testMarketEligibilityStrictlyFailsClosed(): Promise<void> {
  const service = new MarketEligibilityService();
  const base = {
    market: {
      id: 'm1',
      slug: 'btc-5m',
      title: 'btc',
      question: 'btc',
      active: true,
      closed: false,
      tradable: true,
      tokenIdYes: 'yes1',
      tokenIdNo: 'no1',
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      negativeRisk: false,
      enableOrderBook: true,
      abnormalTransition: false,
    },
    spread: 0.01,
    bidDepth: 50,
    askDepth: 50,
    topLevelDepth: 50,
    tickSize: 0.01,
    orderbookObservedAt: new Date(),
    marketObservedAt: new Date(),
    recentTradeCount: 4,
    maxOrderbookAgeMs: 8_000,
    maxMarketAgeMs: 8_000,
    noTradeWindowSeconds: 30,
  };

  assert.strictEqual(
    service.evaluate({
      ...base,
      market: {
        ...base.market,
        enableOrderBook: false,
      },
    }).reasonCode,
    'enable_orderbook_required',
  );
  assert.strictEqual(
    service.evaluate({
      ...base,
      market: {
        ...base.market,
        abnormalTransition: true,
      },
    }).reasonCode,
    'abnormal_market_metadata',
  );
}

async function testFeeAccountingKeepsRewardsSeparateByDefault(): Promise<void> {
  const service = new FeeAccountingService();
  const defaultAccounting = service.compute({
    side: 'BUY',
    entryPrice: 0.4,
    exitPrice: 0.5,
    quantity: 10,
    fees: 0.2,
    rewards: 0.15,
  });
  const rewardsEnabled = service.compute({
    side: 'BUY',
    entryPrice: 0.4,
    exitPrice: 0.5,
    quantity: 10,
    fees: 0.2,
    rewards: 0.15,
    includeRewardsInAlpha: true,
  });

  assert.strictEqual(Math.abs(defaultAccounting.grossPnl - 1) < 1e-9, true);
  assert.strictEqual(Math.abs(defaultAccounting.netAlphaPnl - 0.8) < 1e-9, true);
  assert.strictEqual(Math.abs(defaultAccounting.netPnl - 0.8) < 1e-9, true);
  assert.strictEqual(Math.abs(defaultAccounting.netEconomicPnl - 0.95) < 1e-9, true);
  assert.strictEqual(Math.abs(rewardsEnabled.netPnl - 0.95) < 1e-9, true);
}

async function testVenueOperationalPolicyEscalatesCriticalRejects(): Promise<void> {
  const policy = new VenueOperationalPolicyService();
  assert.strictEqual(
    policy.evaluate({ reasonCode: 'venue_geoblocked' }).transitionTo,
    'halted_hard',
  );
  assert.strictEqual(
    policy.evaluate({ reasonCode: 'auth_failed' }).transitionTo,
    'reconciliation_only',
  );
  assert.strictEqual(
    policy.evaluate({
      reasonCode: 'venue_validation_failed',
      recentRejectCount: 5,
    }).transitionTo,
    'cancel_only',
  );
}

async function testLearningStateStorePersistsAndRecoversFromCorruption(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-state-store-'));
  const store = new LearningStateStore(rootDir);

  const initial = await store.load();
  initial.lastCycleCompletedAt = '2026-03-21T00:00:00.000Z';
  initial.strategyVariants.strategyA = {
    strategyVariantId: 'strategyA',
    health: 'watch',
    lastLearningAt: '2026-03-21T00:00:00.000Z',
    regimeSnapshots: {},
    calibrationContexts: [],
    executionLearning: createDefaultExecutionLearningState(),
    lastPromotionDecision: {
      decision: 'not_evaluated',
      reasons: [],
      evidence: {},
      decidedAt: null,
    },
    lastQuarantineDecision: {
      status: 'none',
      severity: 'none',
      reasons: [],
      scope: {},
      decidedAt: null,
    },
    lastCapitalAllocationDecision: {
      status: 'unchanged',
      targetMultiplier: 1,
      reasons: [],
      decidedAt: null,
    },
  };
  await store.save(initial);
  await store.save(initial);

  const reloaded = await new LearningStateStore(rootDir).load();
  assert.strictEqual(reloaded.lastCycleCompletedAt, '2026-03-21T00:00:00.000Z');
  assert.strictEqual(reloaded.strategyVariants.strategyA?.health, 'watch');

  fs.writeFileSync(store.getPaths().statePath, '{"broken":');
  const recovered = await new LearningStateStore(rootDir).load();
  assert.strictEqual(recovered.lastCycleCompletedAt, '2026-03-21T00:00:00.000Z');
  assert.strictEqual(
    fs.readdirSync(store.getPaths().corruptDir).some((file) => file.endsWith('.corrupt.json')),
    true,
  );
}

async function testExecutionLearningStorePersistsVersionedPolicyAcrossRestart(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-learning-store-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const adapter = {
    loadState: () => learningStateStore.load(),
    saveState: (state: ReturnType<typeof createDefaultLearningState>) =>
      learningStateStore.save(state as never),
  };
  const executionLearningStore = new ExecutionLearningStore(adapter);
  const versionStore = new ExecutionPolicyVersionStore(adapter);
  const updater = new ExecutionPolicyUpdater(versionStore);

  const updated = updater.update({
    priorState: await executionLearningStore.getState(),
    cycleId: 'cycle-execution-1',
    now: new Date('2026-03-25T00:00:00.000Z'),
    observations: [
      {
        strategyVariantId: 'variant:strategy-live-1',
        regime: 'trend_burst',
        route: 'maker',
        fillRatio: 0.2,
        fillDelayMs: 32_000,
        slippage: 0.008,
        cancelAttempted: true,
        cancelSucceeded: false,
        partiallyFilled: true,
        observedAt: '2026-03-24T23:55:00.000Z',
      },
      {
        strategyVariantId: 'variant:strategy-live-1',
        regime: 'trend_burst',
        route: 'maker',
        fillRatio: 0.25,
        fillDelayMs: 28_000,
        slippage: 0.007,
        cancelAttempted: true,
        cancelSucceeded: false,
        partiallyFilled: true,
        observedAt: '2026-03-24T23:56:00.000Z',
      },
      {
        strategyVariantId: 'variant:strategy-live-1',
        regime: 'trend_burst',
        route: 'maker',
        fillRatio: 0.3,
        fillDelayMs: 25_000,
        slippage: 0.007,
        cancelAttempted: true,
        cancelSucceeded: true,
        partiallyFilled: true,
        observedAt: '2026-03-24T23:57:00.000Z',
      },
      {
        strategyVariantId: 'variant:strategy-live-1',
        regime: 'trend_burst',
        route: 'taker',
        fillRatio: 1,
        fillDelayMs: 2_000,
        slippage: 0.003,
        cancelAttempted: false,
        cancelSucceeded: null,
        partiallyFilled: false,
        observedAt: '2026-03-24T23:58:00.000Z',
      },
    ],
  });

  await executionLearningStore.saveState(updated.executionLearning);

  const reloadedContext = await new ExecutionLearningStore(adapter).getForStrategy(
    'variant:strategy-live-1',
    'trend_burst',
  );
  const reloadedVersion = await new ExecutionPolicyVersionStore(adapter).getActiveVersionForStrategy(
    'variant:strategy-live-1',
    'trend_burst',
  );

  assert.ok(reloadedContext);
  assert.ok(reloadedVersion);
  assert.strictEqual(reloadedContext?.sampleCount, 4);
  assert.strictEqual(reloadedContext?.makerPunished, true);
  assert.strictEqual(reloadedVersion?.contextKey, reloadedContext?.contextKey);
}

async function testLearningEventLogAppendOnlyAndReadable(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-event-log-'));
  const log = new LearningEventLog(rootDir);

  await log.append([
    {
      id: 'event-1',
      type: 'learning_cycle_started',
      severity: 'info',
      createdAt: '2026-03-22T00:00:00.000Z',
      cycleId: 'cycle-1',
      strategyVariantId: null,
      contextKey: null,
      summary: 'started',
      details: {},
    },
    {
      id: 'event-2',
      type: 'learning_cycle_completed',
      severity: 'warning',
      createdAt: '2026-03-22T00:05:00.000Z',
      cycleId: 'cycle-1',
      strategyVariantId: 'strategyA',
      contextKey: 'strategy:strategyA|regime:all',
      summary: 'completed',
      details: { status: 'completed_with_warnings' },
    },
  ]);

  const latest = await log.readLatest(10);
  assert.strictEqual(latest.length, 2);
  assert.strictEqual(latest[0]?.id, 'event-1');
  assert.strictEqual(latest[1]?.id, 'event-2');
  assert.strictEqual(fs.readFileSync(log.getPath(), 'utf8').trim().split('\n').length, 2);
}

async function testDailyReviewPersistsSummaryAndCalibration(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-review-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const learningEventLog = new LearningEventLog(rootDir);
  const prisma = {
    executionDiagnostic: {
      findMany: async () => [
        {
          orderId: 'order-1',
          strategyVersionId: 'strategyA',
          expectedEv: 0.05,
          realizedEv: -0.03,
          realizedSlippage: 0.006,
          fillRate: 0.5,
          regime: 'trend_burst',
          capturedAt: new Date('2026-03-22T00:01:00.000Z'),
          staleOrder: true,
        },
      ],
    },
    order: {
      findMany: async () => [
        {
          id: 'order-1',
          marketId: 'market-1',
          tokenId: 'yes1',
          side: 'BUY',
          status: 'filled',
          strategyVersionId: 'strategyA',
          createdAt: new Date('2026-03-22T00:00:10.000Z'),
          acknowledgedAt: new Date('2026-03-22T00:00:12.000Z'),
          signal: {
            id: 'signal-1',
            marketId: 'market-1',
            strategyVersionId: 'strategyA',
            posteriorProbability: 0.72,
            expectedEv: 0.05,
            regime: 'trend_burst',
            observedAt: new Date('2026-03-22T00:00:00.000Z'),
          },
          market: {
            id: 'market-1',
            expiresAt: new Date('2026-03-22T00:10:00.000Z'),
          },
        },
      ],
    },
    orderbook: {
      findFirst: async () => ({
        spread: 0.07,
        askLevels: [{ price: 0.52, size: 8 }],
        bidLevels: [{ price: 0.5, size: 5 }],
      }),
    },
  };

  const job = new DailyReviewJob(
    prisma as never,
    learningStateStore,
    learningEventLog,
  );
  const summary = await job.run({
    force: true,
    now: new Date('2026-03-22T00:10:00.000Z'),
  });

  assert.strictEqual(summary.status !== 'failed', true);
  assert.strictEqual(summary.realizedOutcomeCount, 1);
  assert.strictEqual(summary.calibrationUpdates >= 1, true);
  assert.strictEqual(summary.shrinkageActions >= 1, true);

  const state = await learningStateStore.load();
  assert.strictEqual(Object.keys(state.calibration).length >= 1, true);
  assert.strictEqual(Boolean(state.strategyVariants['variant:strategyA']), true);
  assert.strictEqual(
    Object.values(state.calibration).some((calibration) => calibration.shrinkageFactor < 1),
    true,
  );

  const events = await learningEventLog.readLatest(10);
  assert.strictEqual(
    events.some((event) => event.type === 'calibration_updated'),
    true,
  );
  assert.strictEqual(
    events.some((event) => event.type === 'learning_cycle_completed'),
    true,
  );
}

async function testDailyReviewUpdatesExecutionLearningAndVersionsPolicy(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-review-wave3-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const learningEventLog = new LearningEventLog(rootDir);

  const prisma = {
    strategyVersion: {
      findMany: async () => [],
    },
    executionDiagnostic: {
      findMany: async () => [
        {
          orderId: 'order-1',
          strategyVersionId: 'strategyA',
          expectedEv: 0.05,
          realizedEv: -0.01,
          realizedSlippage: 0.002,
          fillRate: 0.25,
          regime: 'trend_burst',
          capturedAt: new Date('2026-03-25T00:01:00.000Z'),
          staleOrder: false,
        },
      ],
    },
    order: {
      findMany: async () => [
        {
          id: 'order-1',
          marketId: 'market-1',
          tokenId: 'yes1',
          side: 'BUY',
          status: 'canceled',
          strategyVersionId: 'strategyA',
          createdAt: new Date('2026-03-25T00:00:00.000Z'),
          postedAt: new Date('2026-03-25T00:00:02.000Z'),
          acknowledgedAt: new Date('2026-03-25T00:00:03.000Z'),
          canceledAt: new Date('2026-03-25T00:00:30.000Z'),
          filledSize: 1,
          remainingSize: 3,
          size: 4,
          signal: {
            id: 'signal-1',
            marketId: 'market-1',
            strategyVersionId: 'strategyA',
            posteriorProbability: 0.68,
            expectedEv: 0.05,
            regime: 'trend_burst',
            observedAt: new Date('2026-03-25T00:00:00.000Z'),
          },
          market: {
            id: 'market-1',
            expiresAt: new Date('2026-03-25T00:10:00.000Z'),
          },
        },
      ],
    },
    orderbook: {
      findFirst: async () => ({
        spread: 0.03,
        askLevels: [{ price: 0.52, size: 8 }],
        bidLevels: [{ price: 0.5, size: 5 }],
      }),
    },
    fill: {
      findMany: async () => [
        {
          orderId: 'order-1',
          filledAt: new Date('2026-03-25T00:00:10.000Z'),
        },
      ],
    },
    auditEvent: {
      findMany: async () => [
        {
          orderId: 'order-1',
          eventType: 'order.submitted',
          createdAt: new Date('2026-03-25T00:00:02.000Z'),
          metadata: {
            route: 'maker',
            executionStyle: 'rest',
          },
        },
        {
          orderId: 'order-1',
          eventType: 'order.cancel_requested',
          createdAt: new Date('2026-03-25T00:00:28.000Z'),
          metadata: {
            reasonCode: 'cancel_request_pending_confirmation',
          },
        },
      ],
    },
  };

  const job = new DailyReviewJob(
    prisma as never,
    learningStateStore,
    learningEventLog,
  );
  await job.run({
    force: true,
    now: new Date('2026-03-25T00:10:00.000Z'),
  });

  const state = await learningStateStore.load();
  const contextKey = buildExecutionLearningContextKey('variant:strategyA', 'trend_burst');
  assert.ok(state.executionLearning.contexts[contextKey]);
  assert.strictEqual(
    state.executionLearning.contexts[contextKey]?.activePolicyVersionId != null,
    true,
  );
  assert.strictEqual(
    Object.keys(state.executionLearning.policyVersions).length >= 1,
    true,
  );
  assert.strictEqual(
    Object.keys(state.strategyVariants['variant:strategyA']?.executionLearning.contexts ?? {})
      .length >= 1,
    true,
  );

  const events = await learningEventLog.readLatest(20);
  assert.strictEqual(
    events.some((event) => event.type === 'execution_learning_updated'),
    true,
  );
  assert.strictEqual(
    events.some((event) => event.type === 'execution_policy_versioned'),
    true,
  );
}

async function testDailyReviewRegistersChallengerAndStartsPaperFromLiveTruth(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-review-wave2-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const learningEventLog = new LearningEventLog(rootDir);
  const deploymentRegistry = new StrategyDeploymentRegistry(rootDir);
  const resolvedTradeLedger = new ResolvedTradeLedger(rootDir);
  const state = createDefaultLearningState(new Date('2026-03-24T00:00:00.000Z'));
  state.strategyVariants['variant:strategy-live-1'] = {
    strategyVariantId: 'variant:strategy-live-1',
    health: 'healthy',
    lastLearningAt: '2026-03-24T00:00:00.000Z',
    regimeSnapshots: {
      incumbent: {
        key: 'incumbent',
        regime: 'trend_burst',
        liquidityBucket: 'balanced',
        spreadBucket: 'normal',
        timeToExpiryBucket: 'under_15m',
        entryTimingBucket: 'early',
        executionStyle: 'hybrid',
        side: 'buy',
        strategyVariantId: 'variant:strategy-live-1',
        sampleCount: 8,
        winRate: 0.5,
        expectedEvSum: 0.08,
        realizedEvSum: 0.08,
        avgExpectedEv: 0.01,
        avgRealizedEv: 0.01,
        realizedVsExpected: 1,
        avgFillRate: 0.9,
        avgSlippage: 0.002,
        health: 'healthy',
        lastObservedAt: '2026-03-24T00:00:00.000Z',
      },
      incumbent_follow_through: {
        key: 'incumbent_follow_through',
        regime: 'range_reversal',
        liquidityBucket: 'balanced',
        spreadBucket: 'normal',
        timeToExpiryBucket: 'under_15m',
        entryTimingBucket: 'early',
        executionStyle: 'hybrid',
        side: 'buy',
        strategyVariantId: 'variant:strategy-live-1',
        sampleCount: 4,
        winRate: 0.57,
        expectedEvSum: 0.06,
        realizedEvSum: 0.06,
        avgExpectedEv: 0.0086,
        avgRealizedEv: 0.0086,
        realizedVsExpected: 1,
        avgFillRate: 0.9,
        avgSlippage: 0.002,
        health: 'healthy',
        lastObservedAt: '2026-03-24T00:00:00.000Z',
      },
    },
    calibrationContexts: ['strategy:variant:strategy-live-1|regime:all'],
    executionLearning: {
      ...createDefaultExecutionLearningState(),
      updatedAt: '2026-03-24T00:00:00.000Z',
    },
    lastPromotionDecision: {
      decision: 'not_evaluated',
      reasons: [],
      evidence: {},
      decidedAt: null,
    },
    lastQuarantineDecision: {
      status: 'none',
      severity: 'none',
      reasons: [],
      scope: {},
      decidedAt: null,
    },
    lastCapitalAllocationDecision: {
      status: 'unchanged',
      targetMultiplier: 1,
      reasons: [],
      decidedAt: null,
    },
  };
  state.strategyVariants['variant:strategy-challenger-2'] = {
    strategyVariantId: 'variant:strategy-challenger-2',
    health: 'healthy',
    lastLearningAt: '2026-03-24T00:00:00.000Z',
    regimeSnapshots: {
      challenger: {
        key: 'challenger',
        regime: 'trend_burst',
        liquidityBucket: 'balanced',
        spreadBucket: 'normal',
        timeToExpiryBucket: 'under_15m',
        entryTimingBucket: 'early',
        executionStyle: 'hybrid',
        side: 'buy',
        strategyVariantId: 'variant:strategy-challenger-2',
        sampleCount: 4,
        winRate: 0.75,
        expectedEvSum: 0.08,
        realizedEvSum: 0.1,
        avgExpectedEv: 0.01,
        avgRealizedEv: 0.0125,
        realizedVsExpected: 1.25,
        avgFillRate: 0.88,
        avgSlippage: 0.002,
        health: 'healthy',
        lastObservedAt: '2026-03-24T00:00:00.000Z',
      },
      challenger_follow_through: {
        key: 'challenger_follow_through',
        regime: 'range_reversal',
        liquidityBucket: 'balanced',
        spreadBucket: 'normal',
        timeToExpiryBucket: 'under_15m',
        entryTimingBucket: 'early',
        executionStyle: 'hybrid',
        side: 'buy',
        strategyVariantId: 'variant:strategy-challenger-2',
        sampleCount: 4,
        winRate: 0.71,
        expectedEvSum: 0.07,
        realizedEvSum: 0.08,
        avgExpectedEv: 0.01,
        avgRealizedEv: 0.0114,
        realizedVsExpected: 1.14,
        avgFillRate: 0.89,
        avgSlippage: 0.002,
        health: 'healthy',
        lastObservedAt: '2026-03-24T00:00:00.000Z',
      },
    },
    calibrationContexts: ['strategy:variant:strategy-challenger-2|regime:all'],
    executionLearning: {
      ...createDefaultExecutionLearningState(),
      updatedAt: '2026-03-24T00:00:00.000Z',
    },
    lastPromotionDecision: {
      decision: 'not_evaluated',
      reasons: [],
      evidence: {},
      decidedAt: null,
    },
    lastQuarantineDecision: {
      status: 'none',
      severity: 'none',
      reasons: [],
      scope: {},
      decidedAt: null,
    },
    lastCapitalAllocationDecision: {
      status: 'unchanged',
      targetMultiplier: 1,
      reasons: [],
      decidedAt: null,
    },
  };
  state.calibration['strategy:variant:strategy-challenger-2|regime:all'] = {
    contextKey: 'strategy:variant:strategy-challenger-2|regime:all',
    strategyVariantId: 'variant:strategy-challenger-2',
    regime: null,
    sampleCount: 8,
    brierScore: 0.1,
    logLoss: 0.3,
    shrinkageFactor: 1,
    overconfidenceScore: 0.02,
    health: 'healthy',
    version: 1,
    driftSignals: ['calibration_stable'],
    lastUpdatedAt: '2026-03-24T00:00:00.000Z',
  };
  await learningStateStore.save(state);
  for (const record of buildGovernanceResolvedTrades({
    count: 10,
    strategyVariantId: 'variant:strategy-challenger-2',
    strategyVersion: 'strategy-challenger-2',
    regime: 'trend_burst',
    realizedNetEdgeBps: 84,
    expectedNetEdgeBps: 68,
    benchmarkState: 'outperforming',
    lifecycleState: 'economically_resolved_with_portfolio_truth',
  })) {
    await resolvedTradeLedger.append(record);
  }
  for (const record of buildGovernanceResolvedTrades({
    count: 10,
    strategyVariantId: 'variant:strategy-live-1',
    strategyVersion: 'strategy-live-1',
    regime: 'trend_burst',
    realizedNetEdgeBps: 58,
    expectedNetEdgeBps: 54,
    benchmarkState: 'outperforming',
    lifecycleState: 'economically_resolved_with_portfolio_truth',
  })) {
    await resolvedTradeLedger.append(record);
  }

  const prisma = {
    strategyVersion: {
      findMany: async () => [
        {
          id: 'strategy-live-1',
          name: 'live',
          isActive: true,
          createdAt: new Date('2026-03-20T00:00:00.000Z'),
          updatedAt: new Date('2026-03-24T00:00:00.000Z'),
        },
        {
          id: 'strategy-challenger-2',
          name: 'challenger',
          isActive: false,
          createdAt: new Date('2026-03-21T00:00:00.000Z'),
          updatedAt: new Date('2026-03-24T00:05:00.000Z'),
        },
      ],
    },
    executionDiagnostic: {
      findMany: async () => [],
    },
    order: {
      findMany: async () => [],
    },
    orderbook: {
      findFirst: async () => null,
    },
  };

  const job = new DailyReviewJob(
    prisma as never,
    learningStateStore,
    learningEventLog,
    deploymentRegistry,
    undefined,
    undefined,
    resolvedTradeLedger,
  );
  await job.run({
    force: true,
    now: new Date('2026-03-24T00:10:00.000Z'),
  });

  const registryState = await deploymentRegistry.load();
  assert.strictEqual(registryState.incumbentVariantId, 'variant:strategy-live-1');
  assert.strictEqual(
    registryState.activeRollout?.challengerVariantId,
    'variant:strategy-challenger-2',
  );
  assert.strictEqual(registryState.activeRollout?.stage, 'paper');

  const events = await learningEventLog.readLatest(20);
  assert.strictEqual(
    events.some((event) => event.type === 'strategy_variant_registered'),
    true,
  );
  assert.strictEqual(
    events.some((event) => event.type === 'strategy_rollout_changed'),
    true,
  );
}

function buildGovernanceResolvedTrades(input: {
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
}): ResolvedTradeRecord[] {
  return Array.from({ length: input.count }, (_, index) => {
    const realizedNetEdgeBps = input.realizedNetEdgeBps - index;
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
      toxicityScoreAtDecision: 0.14,
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
      lossAttributionCategory: 'mixed',
      executionAttributionCategory: 'queue_decay',
      lifecycleState: input.lifecycleState,
      attribution: {
        benchmarkContext: {
          benchmarkComparisonState: input.benchmarkState,
          baselinePenaltyMultiplier: input.benchmarkState === 'outperforming' ? 1 : 0.8,
          regimeBenchmarkGateState:
            input.benchmarkState === 'outperforming' ? 'passed' : 'blocked',
          underperformedBenchmarkIds:
            input.benchmarkState === 'underperforming' ? ['btc_follow_baseline'] : [],
          outperformedBenchmarkIds:
            input.benchmarkState === 'outperforming' ? ['btc_follow_baseline'] : [],
          reasonCodes: ['fixture'],
        },
        lossAttributionCategory: 'mixed',
        executionAttributionCategory: 'queue_decay',
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

async function testEvaluateTradeOpportunitiesBlocksQuarantinedVariant(): Promise<void> {
  let rejectedReason: string | null = null;
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quarantined-variant-'));
  const deploymentRegistry = new StrategyDeploymentRegistry(rootDir);
  const state = createDefaultStrategyDeploymentRegistryState(
    new Date('2026-03-24T00:00:00.000Z'),
  );
  state.incumbentVariantId = 'variant:strategy-live-1';
  state.variants['variant:strategy-live-1'] = {
    variantId: 'variant:strategy-live-1',
    strategyVersionId: 'strategy-live-1',
    status: 'quarantined',
    evaluationMode: 'shadow_only',
    rolloutStage: 'shadow_only',
    health: 'quarantine_candidate',
    lineage: {
      variantId: 'variant:strategy-live-1',
      strategyVersionId: 'strategy-live-1',
      parentVariantId: null,
      createdAt: '2026-03-20T00:00:00.000Z',
      createdReason: 'test',
    },
    capitalAllocationPct: 0,
    lastShadowEvaluatedAt: null,
    createdAt: '2026-03-20T00:00:00.000Z',
    updatedAt: '2026-03-20T00:00:00.000Z',
  };
  await deploymentRegistry.save(state);

  const prisma = {
    signal: {
      findMany: async () => [createExecutionSignal()],
      update: async () => null,
    },
    portfolioSnapshot: {
      findFirst: async () => ({
        bankroll: 1000,
        availableCapital: 1000,
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
      create: async ({ data }: { data: { reasonCode: string } }) => {
        rejectedReason = data.reasonCode;
      },
    },
    market: {
      findMany: async () => [createMarket()],
    },
    orderbook: {
      findFirst: async () => createFreshOrderbook(),
    },
    marketSnapshot: {
      findFirst: async () => createFreshSnapshot(),
    },
    reconciliationCheckpoint: {
      findFirst: async ({ where }: { where: { source: string } }) =>
        createFreshReconciliationCheckpoint(where.source),
    },
    botRuntimeStatus: {
      findUnique: async () => createFreshRuntimeStatus(),
    },
    executionDiagnostic: {
      findMany: async () => [],
    },
    auditEvent: {
      findMany: async () => [],
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
  );
  const result = await job.run(createRuntimeConfig());

  assert.strictEqual(result.approved, 0);
  assert.strictEqual(result.rejected, 1);
  assert.strictEqual(rejectedReason, 'strategy_variant_quarantined');
}

async function testConfidenceShrinkagePolicyReducesAggressiveness(): Promise<void> {
  const policy = new ConfidenceShrinkagePolicy();
  const decision = policy.evaluate({
    contextKey: 'strategy:strategyA|regime:trend_burst',
    strategyVariantId: 'strategyA',
    regime: 'trend_burst',
    sampleCount: 8,
    brierScore: 0.32,
    logLoss: 0.82,
    shrinkageFactor: 0.58,
    overconfidenceScore: 0.24,
    health: 'degraded',
    version: 2,
    driftSignals: ['overconfidence_detected'],
    lastUpdatedAt: '2026-03-22T00:00:00.000Z',
  });

  assert.strictEqual(decision.health, 'degraded');
  assert.strictEqual(decision.thresholdMultiplier > 1, true);
  assert.strictEqual(decision.sizeMultiplier < 1, true);
}

async function testExecuteOrdersUsesLearnedExecutionPolicyVersion(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'execute-orders-wave3-'));
  const learningStateStore = new LearningStateStore(rootDir);
  const contextKey = buildExecutionLearningContextKey(
    'variant:strategy-live-1',
    'momentum_continuation',
  );
  const learningState = createDefaultLearningState(
    new Date('2026-03-25T00:00:00.000Z'),
  );
  learningState.executionLearning = {
    ...createDefaultExecutionLearningState(),
    updatedAt: '2026-03-25T00:00:00.000Z',
    lastPolicyChangeAt: '2026-03-25T00:00:00.000Z',
    contexts: {
      [contextKey]: {
        contextKey,
        strategyVariantId: 'variant:strategy-live-1',
        regime: 'momentum_continuation',
        sampleCount: 6,
        makerSampleCount: 3,
        takerSampleCount: 3,
        makerFillRate: 0.25,
        takerFillRate: 0.95,
        averageFillDelayMs: 22_000,
        averageSlippage: 0.004,
        adverseSelectionScore: 0.55,
        cancelSuccessRate: 0.6,
        partialFillRate: 0.2,
        makerPunished: true,
        health: 'degraded',
        notes: ['maker_adverse_selection_detected'],
        activePolicyVersionId: 'execution-policy:test:v1',
        lastUpdatedAt: '2026-03-25T00:00:00.000Z',
      },
    },
    policyVersions: {
      'execution-policy:test:v1': {
        versionId: 'execution-policy:test:v1',
        contextKey,
        strategyVariantId: 'variant:strategy-live-1',
        regime: 'momentum_continuation',
        mode: 'taker_preferred',
        recommendedRoute: 'taker',
        recommendedExecutionStyle: 'cross',
        sampleCount: 6,
        makerFillRateAssumption: 0.25,
        takerFillRateAssumption: 0.95,
        expectedFillDelayMs: 22_000,
        expectedSlippage: 0.004,
        adverseSelectionScore: 0.55,
        cancelSuccessRate: 0.6,
        partialFillRate: 0.2,
        health: 'degraded',
        rationale: ['maker_adverse_selection_detected'],
        sourceCycleId: 'cycle-1',
        supersedesVersionId: null,
        createdAt: '2026-03-25T00:00:00.000Z',
      },
    },
    activePolicyVersionIds: {
      [contextKey]: 'execution-policy:test:v1',
    },
  };
  await learningStateStore.save(learningState);

  let auditMetadata: Record<string, unknown> | null = null;
  const prisma = {
    signal: {
      findMany: async () => [createExecutionSignal()],
      update: async () => null,
    },
    signalDecision: {
      findFirst: async () => ({ positionSize: 10, verdict: 'approved' }),
      create: async () => null,
    },
    market: {
      findUnique: async () => createMarket(),
    },
    marketSnapshot: {
      findFirst: async () => createFreshSnapshot(),
    },
    orderbook: {
      findFirst: async () => createFreshOrderbook(),
    },
    order: {
      findFirst: async () => null,
      create: async () => null,
    },
    auditEvent: {
      create: async ({ data }: { data: { metadata: Record<string, unknown> } }) => {
        if ((data as Record<string, unknown>).eventType === 'order.submitted') {
          auditMetadata = data.metadata;
        }
      },
    },
    portfolioSnapshot: {
      findFirst: async () => createFreshPortfolioSnapshot(),
    },
    reconciliationCheckpoint: {
      findFirst: async ({ where }: { where: { source: string } }) =>
        createFreshReconciliationCheckpoint(where.source),
    },
    botRuntimeStatus: {
      findUnique: async () => createFreshRuntimeStatus(),
    },
    liveConfig: {
      findUnique: async () => ({ id: 'live', noTradeWindowSeconds: 30 }),
    },
  };

  const job = new ExecuteOrdersJob(prisma as never, undefined, learningStateStore);
  stubExternalPortfolioService(
    job,
    createExternalPortfolioSnapshot({
      inventories: [
        createExternalInventorySnapshot({
          tokenId: 'yes1',
          marketId: 'm1',
          outcome: 'YES',
          balance: 100,
          allowance: 100,
          reservedQuantity: 0,
          freeQuantityBeforeAllowance: 100,
          freeQuantityAfterAllowance: 100,
          tradableSellHeadroom: 0,
          availableQuantity: 0,
          positionQuantity: 0,
          markPrice: 0.51,
          markedValue: 51,
        }),
      ],
    }),
  );
  (job as any).tradingClient = {
    postOrder: async () => ({
      success: true,
      orderId: 'venue-wave3-1',
      status: 'acknowledged',
    }),
  };

  const result = await job.run({ canSubmit: () => true });

  assert.strictEqual(result.submitted, 1);
  assert.strictEqual(auditMetadata?.['learnedExecutionPolicyVersionId'], 'execution-policy:test:v1');
  assert.strictEqual(auditMetadata?.['executionStyle'], 'cross');
  assert.strictEqual(auditMetadata?.['route'], 'taker');
}

async function run(): Promise<void> {
  const tests: Array<{ name: string; fn: () => Promise<void> }> = [
    { name: 'execution veto blocks submit', fn: testExecutionVetoBlocksSubmit },
    {
      name: 'execution rejects signal without strategy version',
      fn: testExecutionRejectsSignalWithoutStrategyVersion,
    },
    {
      name: 'build signals requires active strategy',
      fn: testBuildSignalsRequiresActiveStrategy,
    },
    {
      name: 'build signals persist active strategy version',
      fn: testBuildSignalsPersistsActiveStrategyVersion,
    },
    {
      name: 'build signals uses deployment registry assignment',
      fn: testBuildSignalsUsesDeploymentRegistryAssignment,
    },
    {
      name: 'open-order sync failure does not mutate states',
      fn: testOpenOrderSyncFailureDoesNotMutateFilled,
    },
    { name: 'reconcile replay is idempotent', fn: testReconcileReplayIsIdempotent },
    { name: 'no-trade-near-expiry rejection', fn: testNoTradeNearExpiryRejected },
    { name: 'stale-signal rejection', fn: testStaleSignalRejected },
    {
      name: 'portfolio snapshot required for risk approval',
      fn: testPortfolioSnapshotRequiredForRiskApproval,
    },
    {
      name: 'portfolio snapshot freshness required for risk approval',
      fn: testPortfolioSnapshotFreshnessRequiredForRiskApproval,
    },
    {
      name: 'execution authority veto blocks submit',
      fn: testExecutionAuthorityVetoBlocksSubmit,
    },
    {
      name: 'risk verification final veto rejects approved signal',
      fn: testRiskVerificationFinalVetoRejectsApprovedSignal,
    },
    { name: 'buy YES uses YES token', fn: testExecuteBuyYesUsesYesToken },
    { name: 'buy NO uses NO token', fn: testExecuteBuyNoUsesNoToken },
    { name: 'sell YES inventory uses YES token', fn: testExecuteSellYesInventoryUsesYesToken },
    { name: 'sell NO inventory uses NO token', fn: testExecuteSellNoInventoryUsesNoToken },
    { name: 'sell rejected when no inventory exists', fn: testRiskRejectsSellWhenNoInventoryExists },
    {
      name: 'execution semantics policy selects explicit order styles',
      fn: testExecutionSemanticsPolicySelectsExplicitOrderStyles,
    },
    {
      name: 'adaptive maker taker policy uses learned policy version',
      fn: testAdaptiveMakerTakerPolicyUsesLearnedPolicyVersion,
    },
    {
      name: 'venue rejects short GTD expiration',
      fn: testVenueValidationRejectsShortGtdExpiration,
    },
    {
      name: 'cancel replace policy abandons adverse move',
      fn: testCancelReplacePolicyAbandonsAdverseMove,
    },
    {
      name: 'duplicate exposure guard blocks working orders',
      fn: testDuplicateExposureGuardBlocksWorkingOrders,
    },
    {
      name: 'venue fee model uses live and fallback inputs',
      fn: testVenueFeeModelUsesLiveAndFallbackInputs,
    },
    {
      name: 'maker quality policy models rewards aware passive quote',
      fn: testMakerQualityPolicyModelsRewardsAwarePassiveQuote,
    },
    {
      name: 'negative risk policy excludes neg risk markets',
      fn: testNegativeRiskPolicyExcludesNegRiskMarkets,
    },
    { name: 'venue rejects price not on tick', fn: testVenueValidationRejectsPriceNotOnTick },
    { name: 'venue rejects size below minimum', fn: testVenueValidationRejectsSizeBelowMinOrderSize },
    { name: 'venue allows valid GTC', fn: testVenueValidationAllowsValidGtc },
    { name: 'venue allows valid GTD', fn: testVenueValidationAllowsValidGtd },
    { name: 'venue allows valid FOK', fn: testVenueValidationAllowsValidFok },
    { name: 'venue allows valid FAK', fn: testVenueValidationAllowsValidFak },
    { name: 'venue rejects unsupported order type', fn: testVenueValidationRejectsUnsupportedOrderType },
    { name: 'venue rejects missing metadata', fn: testVenueValidationRejectsMissingMetadata },
    { name: 'execution rejects stale orderbook metadata', fn: testExecutionRejectsStaleOrderbookMetadata },
    { name: 'execution freshness veto blocks submit', fn: testExecutionFreshnessVetoBlocksSubmit },
    { name: 'reconcile fill sync failure propagates', fn: testReconcileFillSyncFailurePropagates },
    { name: 'signer health accepts pem keys', fn: testSignerHealthAcceptsPemKeys },
    { name: 'heartbeat marks degraded runtime truth', fn: testHeartbeatMarksDegradedRuntimeTruth },
    {
      name: 'btc 5 minute universe admits and rejects deterministically',
      fn: testBtcFiveMinuteUniverseAdmissionAndRejection,
    },
    {
      name: 'regime classifier covers representative scenarios',
      fn: testRegimeClassificationAcrossRepresentativeScenarios,
    },
    {
      name: 'walk forward validation prevents leakage',
      fn: testWalkForwardValidationPreventsLeakage,
    },
    {
      name: 'executable ev decomposes frictions and rejects negative net edge',
      fn: testExecutableEvDecompositionAndNegativeEvRejection,
    },
    {
      name: 'trade admission defaults to no trade when a gate is missing',
      fn: testTradeAdmissionDefaultsToNoTradeWhenGateMissing,
    },
    {
      name: 'runtime freshness fails when external portfolio blocks entries',
      fn: testRuntimeFreshnessFailsWhenExternalPortfolioBlocksEntries,
    },
    {
      name: 'venue awareness preflight rejects geoblock',
      fn: testVenueAwarenessPreflightRejectsGeoblock,
    },
    {
      name: 'venue awareness preflight rejects clock skew',
      fn: testVenueAwarenessPreflightRejectsClockSkew,
    },
    {
      name: 'venue awareness rate governor backs off after rate limit',
      fn: testVenueAwarenessRateGovernorBacksOffAfterRateLimit,
    },
    {
      name: 'order intent identity is stable across retry and changes across replacement epochs',
      fn: testOrderIntentIdentityStableAcrossRetry,
    },
    {
      name: 'execution replay protection blocks duplicate submit when truth is pending',
      fn: testExecutionReplayProtectionBlocksDuplicateSubmit,
    },
    {
      name: 'venue awareness budgets remain isolated by scope',
      fn: testVenueAwarenessBudgetsAreScoped,
    },
    {
      name: 'canonical trade intent resolver resolves explicit token and intent',
      fn: testCanonicalTradeIntentResolverResolvesExplicitTokenAndIntent,
    },
    {
      name: 'canonical trade intent resolver requires inventory for exit',
      fn: testCanonicalTradeIntentResolverRequiresInventoryForExit,
    },
    {
      name: 'official client passes tickSize and negRisk to createOrder',
      fn: testOfficialClientPassesTickSizeAndNegRiskToCreateOrder,
    },
    {
      name: 'official client reads fee rate',
      fn: testOfficialClientReadsFeeRate,
    },
    {
      name: 'official client reads order scoring',
      fn: testOfficialClientReadsOrderScoring,
    },
    {
      name: 'official client reads current rewards',
      fn: testOfficialClientReadsCurrentRewards,
    },
    {
      name: 'official client rejects missing negRisk metadata',
      fn: testOfficialClientRejectsMissingNegRiskMetadata,
    },
    {
      name: 'official client blocks invalid signer configuration',
      fn: testOfficialClientBlocksInvalidSignerConfiguration,
    },
    {
      name: 'official client builds venue-aware sdk client',
      fn: testOfficialClientBuildsVenueAwareSdkClient,
    },
    {
      name: 'official client preflight rejects closed only venue',
      fn: testOfficialClientPreflightRejectsClosedOnlyVenue,
    },
    {
      name: 'start stop manager blocks venue preflight failure',
      fn: testStartStopManagerBlocksVenuePreflightFailure,
    },
    {
      name: 'canonical live path uses canonical signer entrypoints',
      fn: testCanonicalLivePathUsesCanonicalSignerEntrypoints,
    },
    { name: 'tracked env artifacts contain placeholders only', fn: testTrackedEnvArtifactsContainPlaceholdersOnly },
    { name: 'secret policy rejects production env file secrets', fn: testSecretPolicyRejectsProductionEnvFileSecrets },
    { name: 'secret policy allows process env and test overrides', fn: testSecretPolicyAllowsProcessEnvAndTestOverrides },
    { name: 'runtime permission matrix matches canonical states', fn: testRuntimePermissionMatrixMatchesCanonicalStates },
    { name: 'server signer builds canonical wallet and health', fn: testServerSignerBuildsCanonicalWalletAndHealth },
    { name: 'startup gate persists pass and fail verdicts', fn: testStartupGatePersistsPassAndFailVerdicts },
    {
      name: 'learning state store persists and recovers from corruption',
      fn: testLearningStateStorePersistsAndRecoversFromCorruption,
    },
    {
      name: 'learning event log is append only and readable',
      fn: testLearningEventLogAppendOnlyAndReadable,
    },
    {
      name: 'execution learning store persists versioned policy across restart',
      fn: testExecutionLearningStorePersistsVersionedPolicyAcrossRestart,
    },
    {
      name: 'daily review persists summary and calibration',
      fn: testDailyReviewPersistsSummaryAndCalibration,
    },
    {
      name: 'daily review updates execution learning and versions policy',
      fn: testDailyReviewUpdatesExecutionLearningAndVersionsPolicy,
    },
    {
      name: 'daily review registers challenger and starts paper rollout from live truth',
      fn: testDailyReviewRegistersChallengerAndStartsPaperFromLiveTruth,
    },
    {
      name: 'evaluate trade opportunities blocks quarantined variant',
      fn: testEvaluateTradeOpportunitiesBlocksQuarantinedVariant,
    },
    {
      name: 'confidence shrinkage policy reduces aggressiveness',
      fn: testConfidenceShrinkagePolicyReducesAggressiveness,
    },
    {
      name: 'execute orders uses learned execution policy version',
      fn: testExecuteOrdersUsesLearnedExecutionPolicyVersion,
    },
    ...waveFiveLearningCycleIntegrationTests,
    ...waveFiveChampionChallengerIntegrationTests,
    ...waveFiveExecutionLearningIntegrationTests,
    ...waveFiveQuarantineIntegrationTests,
    ...waveFiveVersionLineageIntegrationTests,
    ...phaseOneAlphaAttributionTests,
    ...phaseOneResolvedTradeLedgerTests,
    ...phaseTwoNetEdgeTruthPathTests,
    ...phaseTenNetEdgeRealismTests,
    ...phaseThreeFillRealismTests,
    ...phaseTenFillRealismFeedbackTests,
    ...phaseFourNoTradeAuthorityTests,
    ...phaseTwoFeatureEnrichmentTests,
    ...phaseThreeToxicityTests,
    ...phaseFourLiveSizingFeedbackTests,
    ...phaseFiveBaselineBenchmarkingTests,
    ...phaseFiveEvidenceWeightedSizingTests,
    ...phaseTenEvidenceQualitySizingTests,
    ...phaseSixPromotionGovernanceTests,
    ...phaseTenLivePromotionGateTests,
    ...phaseSixLiveProofTests,
    ...phaseSevenLivePathWiringTests,
    ...phaseSevenExecutionStateHardeningTests,
    ...phaseTenExecutionWatchdogTests,
    ...phaseEightDailyDecisionQualityTests,
    ...phaseNineReadinessEnforcementTests,
    ...phaseElevenLearningStateTypeTests,
    ...phaseElevenLearningEventLogTests,
    ...phaseElevenLearningCycleJobTests,
    ...phaseElevenLearningCycleRunnerTests,
    ...itemOneLossAttributionClassifierTests,
    ...itemTwoRetentionContextTests,
    ...itemTwelveCalibrationDriftAlertTests,
    ...itemSixRegimeLocalSizingTests,
    ...itemSevenBenchmarkRelativeSizingTests,
    ...itemEightRollingBenchmarkScorecardTests,
    ...waveTwelveNetEdgeGatingIntegrationTests,
    ...waveTwelveRegimeProfitabilityIntegrationTests,
    ...waveTwelveUncertaintySizingIntegrationTests,
    ...waveTwelveAntiOvertradingIntegrationTests,
    ...waveTwelveCapitalLeakAttributionIntegrationTests,
    {
      name: 'market stream connects bootstraps and supports dynamic subscriptions',
      fn: testMarketStreamConnectsBootstrapsAndSupportsDynamicSubscriptions,
    },
    {
      name: 'user stream authenticates and bootstraps with rest catchup',
      fn: testUserStreamAuthenticatesAndBootstrapsWithRestCatchup,
    },
    {
      name: 'market stream reconnects after disconnect',
      fn: testMarketStreamReconnectsAfterDisconnect,
    },
    {
      name: 'market stream heartbeat loss triggers reconnect',
      fn: testMarketStreamHeartbeatLossTriggersReconnect,
    },
    {
      name: 'user stream staleness fails closed after real traffic',
      fn: testUserStreamStalenessFailsClosedAfterRealTraffic,
    },
    {
      name: 'market stream ignores duplicate and out-of-order messages',
      fn: testMarketStreamIgnoresDuplicateAndOutOfOrderMessages,
    },
    {
      name: 'user stream ignores out-of-order and duplicate trade messages',
      fn: testUserStreamIgnoresOutOfOrderAndDuplicateTradeMessages,
    },
    {
      name: 'production readiness proves active market subscription',
      fn: testProductionReadinessProvesActiveMarketSubscription,
    },
    {
      name: 'production readiness proves active authenticated user subscription',
      fn: testProductionReadinessProvesActiveAuthenticatedUserSubscription,
    },
    {
      name: 'production readiness requires actual event receipt',
      fn: testProductionReadinessRequiresActualEventReceipt,
    },
    {
      name: 'production readiness freshness timeout fails closed',
      fn: testProductionReadinessFreshnessTimeoutFailsClosed,
    },
    {
      name: 'production readiness validates reconnect recovery on live path',
      fn: testProductionReadinessReconnectRecoveryUsesLivePath,
    },
    {
      name: 'production readiness reconciles against stream truth',
      fn: testProductionReadinessReconcilesAgainstStreamTruth,
    },
    {
      name: 'production readiness observes user lifecycle events from stream',
      fn: testProductionReadinessObservesUserLifecycleEventsFromStream,
    },
    {
      name: 'production readiness persists live evidence',
      fn: testProductionReadinessSuitePersistsLiveEvidence,
    },
    { name: 'production readiness command exists', fn: testProductionReadinessCommandExists },
    {
      name: 'docs describe production readiness stream proof',
      fn: testDocsDescribeProductionReadinessStreamProof,
    },
    {
      name: 'docs describe canonical Polymarket SDK path',
      fn: testDocsDescribeCanonicalPolymarketSdkPath,
    },
    {
      name: 'canonical edge definition blocks missing definition',
      fn: testCanonicalEdgeDefinitionBlocksMissingDefinition,
    },
    {
      name: 'research governance and promotion require robust evidence',
      fn: testResearchGovernanceAndPromotionRequireRobustEvidence,
    },
    {
      name: 'no-trade zones half-life and setup-aware attribution fail closed',
      fn: testNoTradeZonesHalfLifeAndSetupAwareAttribution,
    },
    {
      name: 'net-edge policies reject low-margin opportunities after costs',
      fn: testNetEdgePoliciesRejectLowMarginOpportunity,
    },
    {
      name: 'regime profitability policies reduce destructive regimes',
      fn: testRegimeProfitabilityPoliciesReduceDestructiveRegime,
    },
    {
      name: 'wave3 governors prefer reduced activity over marginal activity',
      fn: testWaveThreeGovernorsPreferReducedActivityOverMarginalActivity,
    },
    {
      name: 'evaluate trade opportunities applies wave3 regime discipline',
      fn: testEvaluateTradeOpportunitiesAppliesWaveThreeRegimeDiscipline,
    },
    {
      name: 'wave4 cost model calibrates execution reality',
      fn: testWaveFourCostModelCalibratesExecutionReality,
    },
    {
      name: 'wave4 sizing policies reduce exposure',
      fn: testWaveFourSizingPoliciesReduceExposure,
    },
    {
      name: 'evaluate trade opportunities applies wave4 execution realism',
      fn: testEvaluateTradeOpportunitiesAppliesWaveFourExecutionRealism,
    },
    {
      name: 'execute orders applies wave4 execution cost reality',
      fn: testExecuteOrdersAppliesWaveFourExecutionCostReality,
    },
    {
      name: 'capital leak attribution distinguishes structured loss sources',
      fn: testCapitalLeakAttributionDistinguishesLossSources,
    },
    {
      name: 'capital leak review persists report and trade quality history',
      fn: testCapitalLeakReviewPersistsReportAndTradeQualityHistory,
    },
    {
      name: 'deployment tier capital ramp chaos replay and readiness fail closed',
      fn: testDeploymentTierCapitalRampChaosReplayAndReadiness,
    },
    {
      name: 'historical dataset loading uses empirical evidence',
      fn: testHistoricalDatasetLoading,
    },
    {
      name: 'walk-forward evaluation runs on real historical data',
      fn: testWalkForwardEvaluationOnRealData,
    },
    {
      name: 'dataset quality accepts repaired empirical coverage',
      fn: testDatasetQualityAcceptsRepairedEmpiricalCoverage,
    },
    {
      name: 'readiness observer flags internal vs external divergence',
      fn: testReadinessObserverFlagsInternalVsExternalDivergence,
    },
    {
      name: 'capital exposure validation gates shadow micro and limited modes',
      fn: testCapitalExposureValidationGatesShadowMicroAndLimitedModes,
    },
    {
      name: 'chaos harness covers adversarial timing and soak',
      fn: testChaosHarnessCoversAdversarialTimingAndSoak,
    },
    {
      name: 'regime holdout behavior uses actual observations',
      fn: testRegimeHoldoutBehaviorUsesActualObservations,
    },
    {
      name: 'executable-edge scoring uses real frictions',
      fn: testExecutableEdgeScoringWithRealFrictions,
    },
    {
      name: 'calibration checks use realized outcomes',
      fn: testCalibrationAgainstRealizedOutcomes,
    },
    {
      name: 'validation fails when only synthetic evidence is available',
      fn: testValidationFailsWhenOnlySyntheticEvidenceIsAvailable,
    },
    {
      name: 'canonical gamma parser accepts valid market payload',
      fn: testCanonicalGammaParserAcceptsValidMarket,
    },
    {
      name: 'canonical gamma parser rejects malformed market payload',
      fn: testCanonicalGammaParserRejectsMalformedMarket,
    },
    {
      name: 'canonical orderbook parser rejects malformed payload',
      fn: testCanonicalOrderbookParserRejectsMalformedPayload,
    },
    {
      name: 'canonical open orders parser rejects unknown status',
      fn: testCanonicalOpenOrdersParserRejectsUnknownStatus,
    },
    {
      name: 'canonical trade and balance parsers reject malformed payloads',
      fn: testCanonicalTradeAndBalanceParsersRejectMalformedPayloads,
    },
    {
      name: 'lifecycle validation handles submit timeout with uncertain venue truth',
      fn: testLifecycleSubmitTimeoutUncertainVenueState,
    },
    {
      name: 'lifecycle validation handles partial fill followed by reconnect',
      fn: testLifecyclePartialFillReconnect,
    },
    {
      name: 'lifecycle validation handles cancel acknowledged late',
      fn: testLifecycleCancelAcknowledgedLate,
    },
    {
      name: 'lifecycle validation handles ghost open order after restart',
      fn: testLifecycleGhostOpenOrderAfterRestart,
    },
    {
      name: 'lifecycle validation handles duplicate or delayed fill events',
      fn: testLifecycleDuplicateDelayedFillEvents,
    },
    {
      name: 'lifecycle validation handles order visibility mismatch between rest and stream',
      fn: testLifecycleOrderVisibilityMismatch,
    },
    {
      name: 'lifecycle validation handles stale local assumptions after crash',
      fn: testLifecycleStaleLocalAssumptionsAfterCrash,
    },
    {
      name: 'lifecycle validation persists auditable replay evidence',
      fn: testLifecycleSuitePersistsEvidenceAndReplayIncludesIt,
    },
    {
      name: 'funding validator rejects insufficient buy balance',
      fn: testFundingValidatorRejectsInsufficientBuyBalance,
    },
    {
      name: 'funding validator rejects insufficient sell inventory',
      fn: testFundingValidatorRejectsInsufficientSellInventory,
    },
    {
      name: 'funding validator rejects allowance and reserved headroom exhaustion',
      fn: testFundingValidatorRejectsAllowanceAndReservedHeadroom,
    },
    {
      name: 'funding validator rejects stale snapshot and allows valid order',
      fn: testFundingValidatorRejectsStaleSnapshotAndAllowsValidOrder,
    },
    {
      name: 'external portfolio service captures authenticated truth',
      fn: testExternalPortfolioServiceCapturesAuthenticatedTruth,
    },
    {
      name: 'external portfolio service flags recoverable divergence',
      fn: testExternalPortfolioServiceFlagsRecoverableDivergence,
    },
    {
      name: 'external portfolio snapshot load recomputes freshness',
      fn: testExternalPortfolioLoadLatestSnapshotRecomputesFreshness,
    },
    {
      name: 'execution rejects stale external portfolio truth',
      fn: testExecutionRejectsStaleExternalPortfolioTruth,
    },
    {
      name: 'venue heartbeat starts and stops with open orders',
      fn: testVenueHeartbeatStartsAndStopsWithOpenOrders,
    },
    {
      name: 'venue heartbeat failure triggers protective callback',
      fn: testVenueHeartbeatFailureTriggersProtectiveCallback,
    },
    {
      name: 'execution readiness requires venue heartbeat when orders exist',
      fn: testExecutionReadinessRequiresVenueHeartbeatWhenOrdersExist,
    },
    {
      name: 'safety state machine escalates and respects cooldown',
      fn: testSafetyStateMachineEscalatesAndRespectsCooldown,
    },
    {
      name: 'execution quality kill switches compound warnings',
      fn: testExecutionQualityKillSwitchesCompoundWarnings,
    },
    {
      name: 'multi-dimensional position limits block same-thesis concentration',
      fn: testMultiDimensionalPositionLimitsBlockSameThesisExposure,
    },
    {
      name: 'loss attribution prefers execution error when fill quality breaks',
      fn: testLossAttributionPrefersExecutionError,
    },
    {
      name: 'evaluate trade opportunities rejects same-thesis overexposure',
      fn: testEvaluateTradeOpportunitiesRejectsSameThesisExposure,
    },
    {
      name: 'evaluate trade opportunities halts on execution-quality breakage',
      fn: testEvaluateTradeOpportunitiesTriggersSafetyHaltOnExecutionBreakage,
    },
    {
      name: 'execute orders blocks aggressive entry in passive-only state',
      fn: testExecuteOrdersBlocksAggressiveEntryInPassiveOnlyState,
    },
    {
      name: 'fill state tracks partial fills residuals and ghost exposure',
      fn: testFillStateTracksPartialFillResidualsAndGhostExposure,
    },
    {
      name: 'manage open orders surfaces cancel failure',
      fn: testManageOpenOrdersSurfacesCancelFailure,
    },
    {
      name: 'reconcile fills writes execution diagnostic snapshot',
      fn: testReconcileFillsCreatesExecutionDiagnosticSnapshot,
    },
    {
      name: 'inventory liquidation policy handles soft and hard triggers',
      fn: testInventoryLiquidationPolicyHandlesSoftAndHardTriggers,
    },
    {
      name: 'market eligibility fails closed on strict criteria',
      fn: testMarketEligibilityStrictlyFailsClosed,
    },
    {
      name: 'fee accounting keeps rewards separate by default',
      fn: testFeeAccountingKeepsRewardsSeparateByDefault,
    },
    {
      name: 'venue operational policy escalates critical rejects',
      fn: testVenueOperationalPolicyEscalatesCriticalRejects,
    },
    {
      name: 'smoke harness fails closed without execute guard',
      fn: testSmokeHarnessFailsClosedWithoutExecuteGuard,
    },
    { name: '3-agent e2e orchestration smoke', fn: testAgentE2EOrchestrationSmoke },
  ];

  for (const test of tests) {
    await test.fn();
    // eslint-disable-next-line no-console
    console.log(`PASS ${test.name}`);
  }
}

run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Integration tests failed:', error);
  process.exit(1);
});
