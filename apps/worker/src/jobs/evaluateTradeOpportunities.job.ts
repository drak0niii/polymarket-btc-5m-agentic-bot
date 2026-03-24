import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { AppLogger } from '@worker/common/logger';
import { BotRuntimeState } from '@worker/runtime/bot-state';
import { appEnv } from '@worker/config/env';
import {
  PersistedSafetyState,
  RuntimeControlRepository,
  RuntimeLiveConfig,
} from '@worker/runtime/runtime-control.repository';
import { AccountStateService } from '@worker/portfolio/account-state.service';
import { permissionsForRuntimeState } from '@worker/runtime/runtime-state-machine';
import { PositionLimits } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { DailyLossLimits } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { ConsecutiveLossKillSwitch } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { CappedKelly } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { BetSizing } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { BankrollContraction } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { ExecutionQualityKillSwitches } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import {
  LossAttributionEvidence,
  LossAttributionModel,
} from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { PortfolioKillSwitchService } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import {
  MultiDimensionalPositionLimits,
  PositionLimitExposure,
} from '@polymarket-btc-5m-agentic-bot/risk-engine';
import {
  SafetyState,
  SafetyStateControls,
  controlsForSafetyState,
} from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { SafetyStateMachine } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import {
  EntryTimingEfficiencyScorer,
  ExecutionCostCalibrator,
  RealizedCostModel,
  SizeVsLiquidityPolicy,
  TradeIntentResolver,
} from '@polymarket-btc-5m-agentic-bot/execution-engine';
import {
  buildCalibrationContextKey,
  ConfidenceShrinkagePolicy,
  ExecutableEdgeEstimate,
  LiveCalibrationStore,
  NetEdgeEstimator,
  NetEdgeThresholdDecision,
  NetEdgeThresholdPolicy,
  TradeAdmissionGate,
} from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { MarketEligibilityService } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { EdgeDefinitionService } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { NoTradeZonePolicy } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { EdgeHalfLifePolicy } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { EventMicrostructureModel } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { FeatureBuilder } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { DeploymentTierPolicyService } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { CapitalRampPolicyService } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import {
  MarginalEdgeCooldownPolicy,
  MaxLossPerOpportunityPolicy,
  OpportunityClass,
  OpportunitySaturationDetector,
  RegimeCapitalPolicy,
  RegimeDisablePolicy,
  RegimeProfitabilityRanker,
  SizePenaltyEngine,
  TradeFrequencyGovernor,
  TradeQualityHistoryStore,
  UncertaintyWeightedSizing,
  type CapitalLeakCategory,
  type CapitalLeakReport,
} from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { DecisionLogService } from '@worker/runtime/decision-log.service';
import { LearningStateStore } from '@worker/runtime/learning-state-store';
import {
  buildStrategyVariantId,
  type CalibrationState,
  type HealthLabel,
  type NetEdgeDecision,
  type TradeQualityScore,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { StrategyDeploymentRegistry } from '@worker/runtime/strategy-deployment-registry';
import { StrategyRolloutController } from '@worker/runtime/strategy-rollout-controller';
import {
  VenueHealthLearningStore,
  VenueModePolicy,
  VenueUncertaintyDetector,
} from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';
import {
  VersionLineageRegistry,
  buildAllocationPolicyVersionLineage,
  buildCalibrationVersionLineage,
  buildFeatureSetVersionLineage,
  buildRiskPolicyVersionLineage,
  buildStrategyVersionLineage,
} from '@worker/runtime/version-lineage-registry';

type Outcome = 'YES' | 'NO';
type VenueSide = 'BUY' | 'SELL';
type EvaluationAction = 'ENTER' | 'REDUCE' | 'EXIT';
const DEFAULT_FEE_RATE = 0.005;

interface ResolvedEvaluationIntent {
  tokenId: string;
  outcome: Outcome;
  venueSide: VenueSide;
  action: EvaluationAction;
  inventoryEffect: 'increase' | 'decrease';
}

interface RecentAdmissionEvent {
  createdAt: string;
  verdict: 'approved' | 'rejected' | 'unknown';
  marginAboveThreshold: number | null;
  opportunityClass: OpportunityClass;
  reasons: string[];
}

export interface EvaluateTradeOpportunitiesResult {
  approved: number;
  rejected: number;
  killSwitchTriggered: boolean;
  killSwitchReason: string | null;
  safetyState: SafetyState;
  safetyReasonCodes: string[];
  safetyControls: SafetyStateControls;
}

export class EvaluateTradeOpportunitiesJob {
  private readonly logger = new AppLogger('EvaluateTradeOpportunitiesJob');
  private readonly positionLimits = new PositionLimits();
  private readonly dailyLossLimits = new DailyLossLimits();
  private readonly consecutiveLossKillSwitch = new ConsecutiveLossKillSwitch();
  private readonly cappedKelly = new CappedKelly();
  private readonly betSizing = new BetSizing();
  private readonly bankrollContraction = new BankrollContraction();
  private readonly executionQualityKillSwitches = new ExecutionQualityKillSwitches();
  private readonly lossAttributionModel = new LossAttributionModel();
  private readonly portfolioKillSwitchService = new PortfolioKillSwitchService();
  private readonly multiDimensionalPositionLimits = new MultiDimensionalPositionLimits();
  private readonly safetyStateMachine = new SafetyStateMachine();
  private readonly tradeIntentResolver = new TradeIntentResolver();
  private readonly tradeAdmissionGate = new TradeAdmissionGate();
  private readonly edgeDefinitionService = new EdgeDefinitionService();
  private readonly noTradeZonePolicy = new NoTradeZonePolicy();
  private readonly netEdgeEstimator = new NetEdgeEstimator();
  private readonly netEdgeThresholdPolicy = new NetEdgeThresholdPolicy();
  private readonly edgeHalfLifePolicy = new EdgeHalfLifePolicy();
  private readonly microstructureModel = new EventMicrostructureModel();
  private readonly featureBuilder = new FeatureBuilder();
  private readonly executionCostCalibrator = new ExecutionCostCalibrator();
  private readonly realizedCostModel = new RealizedCostModel();
  private readonly sizeVsLiquidityPolicy = new SizeVsLiquidityPolicy();
  private readonly entryTimingEfficiencyScorer = new EntryTimingEfficiencyScorer();
  private readonly deploymentTierPolicy = new DeploymentTierPolicyService();
  private readonly capitalRampPolicy = new CapitalRampPolicyService();
  private readonly uncertaintyWeightedSizing = new UncertaintyWeightedSizing();
  private readonly sizePenaltyEngine = new SizePenaltyEngine();
  private readonly maxLossPerOpportunityPolicy = new MaxLossPerOpportunityPolicy();
  private readonly accountStateService: AccountStateService;
  private readonly marketEligibility = new MarketEligibilityService();
  private readonly decisionLogService: DecisionLogService;
  private readonly learningStateStore: LearningStateStore;
  private readonly strategyDeploymentRegistry: StrategyDeploymentRegistry;
  private readonly liveCalibrationStore: LiveCalibrationStore;
  private readonly confidenceShrinkagePolicy = new ConfidenceShrinkagePolicy();
  private readonly strategyRolloutController = new StrategyRolloutController();
  private readonly versionLineageRegistry: VersionLineageRegistry;
  private readonly venueHealthLearningStore: VenueHealthLearningStore;
  private readonly venueUncertaintyDetector = new VenueUncertaintyDetector();
  private readonly venueModePolicy = new VenueModePolicy();
  private readonly regimeProfitabilityRanker = new RegimeProfitabilityRanker();
  private readonly regimeCapitalPolicy = new RegimeCapitalPolicy();
  private readonly regimeDisablePolicy = new RegimeDisablePolicy();
  private readonly tradeFrequencyGovernor = new TradeFrequencyGovernor();
  private readonly marginalEdgeCooldownPolicy = new MarginalEdgeCooldownPolicy();
  private readonly opportunitySaturationDetector = new OpportunitySaturationDetector();
  private readonly tradeQualityHistoryStore: TradeQualityHistoryStore;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly runtimeControl?: RuntimeControlRepository,
    strategyDeploymentRegistry?: StrategyDeploymentRegistry,
    learningStateStore?: LearningStateStore,
    versionLineageRegistry?: VersionLineageRegistry,
    venueHealthLearningStore?: VenueHealthLearningStore,
    tradeQualityHistoryStore?: TradeQualityHistoryStore,
  ) {
    this.accountStateService = new AccountStateService(prisma);
    this.decisionLogService = new DecisionLogService(prisma);
    this.learningStateStore = learningStateStore ?? new LearningStateStore();
    this.strategyDeploymentRegistry =
      strategyDeploymentRegistry ?? new StrategyDeploymentRegistry();
    this.liveCalibrationStore = new LiveCalibrationStore({
      loadState: () => this.learningStateStore.load(),
      saveState: (state) => this.learningStateStore.save(state),
    });
    this.versionLineageRegistry =
      versionLineageRegistry ?? new VersionLineageRegistry();
    this.venueHealthLearningStore =
      venueHealthLearningStore ?? createDefaultVenueHealthLearningStore(this.learningStateStore);
    this.tradeQualityHistoryStore =
      tradeQualityHistoryStore ?? new TradeQualityHistoryStore();
  }

  async run(
    config: RuntimeLiveConfig,
    options?: { runtimeState?: BotRuntimeState },
  ): Promise<EvaluateTradeOpportunitiesResult> {
    if (
      options?.runtimeState &&
      (!permissionsForRuntimeState(options.runtimeState).allowStrategyEvaluation ||
        !permissionsForRuntimeState(options.runtimeState).allowNewEntries)
    ) {
      const defaultSafety = this.defaultSafetyState();
      return {
        approved: 0,
        rejected: 0,
        killSwitchTriggered: false,
        killSwitchReason: null,
        safetyState: defaultSafety.state,
        safetyReasonCodes: defaultSafety.reasonCodes,
        safetyControls: defaultSafety,
      };
    }

    const prismaAny = this.prisma as any;
    const pendingSignals = await this.prisma.signal.findMany({
      where: {
        status: 'created',
      },
      orderBy: {
        observedAt: 'asc',
      },
      take: 50,
    });

    const defaultSafety = this.defaultSafetyState();
    if (pendingSignals.length === 0) {
      return {
        approved: 0,
        rejected: 0,
        killSwitchTriggered: false,
        killSwitchReason: null,
        safetyState: defaultSafety.state,
        safetyReasonCodes: defaultSafety.reasonCodes,
        safetyControls: defaultSafety,
      };
    }
    const learningState = await this.learningStateStore.load();
    const calibrationByContext = learningState.calibration;
    const deploymentRegistry = await this.strategyDeploymentRegistry.load();
    const venueMetrics = await this.venueHealthLearningStore.getCurrentMetrics();
    const recentTradeQualityScores = await this.tradeQualityHistoryStore.readLatest(200);
    const venueAssessment = this.venueUncertaintyDetector.evaluate(venueMetrics);
    const venueMode = this.venueModePolicy.decide(venueAssessment);
    await this.venueHealthLearningStore.setOperationalAssessment({
      activeMode: venueMode.mode,
      uncertaintyLabel: venueAssessment.label,
    });

    const [
      latestPortfolio,
      openPositionsRaw,
      workingOrders,
      runtimeStatus,
      latestOpenOrdersCheckpoint,
      latestFillCheckpoint,
      latestExternalPortfolioCheckpoint,
      recentExecutionDiagnostics,
      recentAuditEvents,
      recentSignalDecisions,
      currentSafetyState,
      latestResearchGovernanceCheckpoint,
      latestChaosRun,
      latestCapitalExposureCheckpoint,
    ] = await Promise.all([
      this.prisma.portfolioSnapshot.findFirst({
        orderBy: {
          capturedAt: 'desc',
        },
      }),
      prismaAny.position?.findMany
        ? prismaAny.position.findMany({
            where: {
              status: 'open',
            },
            orderBy: {
              openedAt: 'asc',
            },
            take: 100,
          })
        : prismaAny.position?.count
          ? prismaAny.position.count({
              where: {
                status: 'open',
              },
            })
          : Promise.resolve([]),
      this.prisma.order.findMany({
        where: {
          status: {
            in: ['submitted', 'acknowledged', 'partially_filled'],
          },
        },
      }),
      prismaAny.botRuntimeStatus?.findUnique
        ? prismaAny.botRuntimeStatus.findUnique({
            where: { id: 'live' },
          })
        : Promise.resolve(null),
      prismaAny.reconciliationCheckpoint?.findFirst
        ? prismaAny.reconciliationCheckpoint.findFirst({
            where: { source: 'open_orders_reconcile_cycle' },
            orderBy: { processedAt: 'desc' },
          })
        : Promise.resolve(null),
      prismaAny.reconciliationCheckpoint?.findFirst
        ? prismaAny.reconciliationCheckpoint.findFirst({
            where: { source: 'fills_reconcile_cycle' },
            orderBy: { processedAt: 'desc' },
          })
        : Promise.resolve(null),
      prismaAny.reconciliationCheckpoint?.findFirst
        ? prismaAny.reconciliationCheckpoint.findFirst({
            where: { source: 'external_portfolio_reconcile' },
            orderBy: { processedAt: 'desc' },
          })
        : Promise.resolve(null),
      prismaAny.executionDiagnostic?.findMany
        ? prismaAny.executionDiagnostic.findMany({
            orderBy: { capturedAt: 'desc' },
            take: 30,
          })
        : Promise.resolve([]),
      prismaAny.auditEvent?.findMany
        ? prismaAny.auditEvent.findMany({
            orderBy: { createdAt: 'desc' },
            take: 80,
          })
        : Promise.resolve([]),
      prismaAny.signalDecision?.findMany
        ? prismaAny.signalDecision.findMany({
            orderBy: { decisionAt: 'desc' },
            take: 80,
          })
        : Promise.resolve([]),
      this.runtimeControl
        ? this.runtimeControl.getLatestSafetyState()
        : Promise.resolve(this.defaultSafetyState()),
      prismaAny.reconciliationCheckpoint?.findFirst
        ? prismaAny.reconciliationCheckpoint.findFirst({
            where: { source: 'research_governance_validation' },
            orderBy: { processedAt: 'desc' },
          })
        : Promise.resolve(null),
      prismaAny.stressTestRun?.findFirst
        ? prismaAny.stressTestRun.findFirst({
            where: { family: 'chaos_harness' },
            orderBy: { startedAt: 'desc' },
          })
        : Promise.resolve(null),
      prismaAny.reconciliationCheckpoint?.findFirst
        ? prismaAny.reconciliationCheckpoint.findFirst({
            where: { source: 'capital_exposure_validation' },
            orderBy: { processedAt: 'desc' },
          })
        : Promise.resolve(null),
    ]);

    const openPositions = Array.isArray(openPositionsRaw) ? openPositionsRaw : [];
    const openPositionCount = Array.isArray(openPositionsRaw)
      ? openPositionsRaw.length
      : Number.isFinite(openPositionsRaw)
        ? Number(openPositionsRaw)
        : 0;

    const marketIds = [
      ...new Set(
        [
          ...pendingSignals.map((signal) => signal.marketId),
          ...workingOrders.map((order) => order.marketId),
          ...openPositions.map((position) => this.readStringField(position, 'marketId')),
        ].filter((value): value is string => typeof value === 'string' && value.length > 0),
      ),
    ];

    const markets = await this.prisma.market.findMany({
      where: {
        id: { in: marketIds },
      },
    });
    const marketById = new Map(markets.map((market) => [market.id, market]));
    const auditCoverage = this.decisionLogService.summarizeAuditCoverage(recentAuditEvents);
    const latestCapitalLeakReport = this.readLatestCapitalLeakReport(recentAuditEvents);
    const recentAdmissionEvents = this.readRecentAdmissionEvents(
      recentAuditEvents,
      recentSignalDecisions,
    );
    const researchGovernanceHealthy =
      latestResearchGovernanceCheckpoint?.status === 'passed';
    const latestResearchDetails =
      latestResearchGovernanceCheckpoint?.details &&
      typeof latestResearchGovernanceCheckpoint.details === 'object'
        ? (latestResearchGovernanceCheckpoint.details as Record<string, unknown>)
        : null;
    const robustnessPassed = Boolean(
      latestResearchDetails &&
      typeof latestResearchDetails.robustness === 'object' &&
      latestResearchDetails.robustness !== null &&
      Boolean((latestResearchDetails.robustness as Record<string, unknown>).passed),
    );
    const promotionScore =
      latestResearchDetails &&
      typeof latestResearchDetails.promotion === 'object' &&
      latestResearchDetails.promotion !== null
        ? Number((latestResearchDetails.promotion as Record<string, unknown>).score ?? 0)
        : 0;
    const chaosPassed = Boolean(
      latestChaosRun?.verdict === 'passed' ||
        latestChaosRun?.status === 'passed',
    );

    const portfolioState = this.evaluatePortfolioState({
      latestPortfolio,
      maxSnapshotAgeMs: this.maxPortfolioSnapshotAgeMs(config),
    });
    if (!portfolioState.passed) {
      this.logger.error('Risk evaluation halted due to invalid portfolio state.', undefined, {
        reason: portfolioState.reasonCode,
      });
      return {
        approved: 0,
        rejected: 0,
        killSwitchTriggered: true,
        killSwitchReason: portfolioState.reasonCode,
        safetyState: currentSafetyState.state,
        safetyReasonCodes: currentSafetyState.reasonCodes,
        safetyControls: currentSafetyState,
      };
    }
    if (!latestPortfolio) {
      throw new Error('Portfolio state was validated but no snapshot is available.');
    }
    const accountState = await this.accountStateService.capture({
      persist: false,
      portfolioSnapshot: latestPortfolio,
    });

    const operationalTruth = this.evaluateOperationalTruth({
      runtimeState: runtimeStatus?.state ?? null,
      latestOpenOrdersCheckpoint,
      latestFillCheckpoint,
      latestExternalPortfolioCheckpoint,
      maxAgeMs: this.maxPortfolioSnapshotAgeMs(config),
    });
    const readinessReady =
      operationalTruth.venueHealthy &&
      operationalTruth.reconciliationHealthy &&
      researchGovernanceHealthy;
    const deploymentTier = this.deploymentTierPolicy.evaluate({
      tier: appEnv.BOT_DEPLOYMENT_TIER,
      liveExecutionEnabled: appEnv.BOT_LIVE_EXECUTION_ENABLED,
      robustnessPassed,
      auditCoverageHealthy: auditCoverage.healthy,
      readinessReady,
    });
    const capitalRamp = this.capitalRampPolicy.evaluate({
      tierAllowsScale: deploymentTier.allowNewEntries,
      robustnessPassed,
      chaosPassed,
      auditCoverageHealthy: auditCoverage.healthy,
      attributionCoverage: Math.min(
        1,
        (recentExecutionDiagnostics?.length ?? 0) / 10,
      ),
      promotionScore,
      capitalExposureValidated:
        latestCapitalExposureCheckpoint?.status === 'completed' ||
        appEnv.BOT_DEPLOYMENT_TIER === 'paper' ||
        appEnv.BOT_DEPLOYMENT_TIER === 'research',
    });

    const workingOrderSlots = workingOrders.filter(
      (order) => (order.remainingSize ?? order.size) > 0,
    ).length;
    let availableOpenSlots = Math.max(
      0,
      Math.floor(config.maxOpenPositions * deploymentTier.maxOpenPositionsMultiplier) -
        (openPositionCount + workingOrderSlots),
    );
    const workingOrderExposure = workingOrders.reduce(
      (sum, order) =>
        sum +
        order.price *
          Math.max(
            0,
            order.remainingSize != null
              ? order.remainingSize
              : order.size - (order.filledSize ?? 0),
          ),
      0,
    );

    const bankroll = accountState.bankroll;
    const availableCapital = Math.max(
      0,
      accountState.deployableRiskNow - Math.max(0, workingOrderExposure - accountState.workingBuyNotional),
    );
    let remainingCapital = availableCapital;
    const dailyLossAbs = Math.abs(Math.min(accountState.realizedPnlDay, 0));

    const dailyLossCheck = this.dailyLossLimits.evaluate({
      bankroll,
      realizedPnlDay: accountState.realizedPnlDay,
      maxDailyLossPct: config.maxDailyLossPct,
    });
    const dailyLossRatio =
      dailyLossCheck.dailyLossLimitValue > 0
        ? dailyLossAbs / dailyLossCheck.dailyLossLimitValue
        : 0;

    const lossAttributionSummary = this.buildLossAttributionSummary({
      diagnostics: recentExecutionDiagnostics,
      auditEvents: recentAuditEvents,
      realizedPnlDay: accountState.realizedPnlDay,
    });
    const executionQualityTriggers = this.executionQualityKillSwitches.evaluate({
      diagnostics: (recentExecutionDiagnostics ?? []).map((diagnostic: any) => ({
        expectedSlippage: this.readNumberField(diagnostic, 'expectedSlippage'),
        realizedSlippage: this.readNumberField(diagnostic, 'realizedSlippage'),
        expectedEv: this.readNumberField(diagnostic, 'expectedEv'),
        realizedEv: this.readNumberField(diagnostic, 'realizedEv'),
        staleOrder: this.readBooleanField(diagnostic, 'staleOrder') ?? false,
      })),
      postFailureCount: this.countAuditEvents(recentAuditEvents, 'order.rejected_on_submit'),
      cancelFailureCount: this.countAuditEvents(recentAuditEvents, 'order.cancel_failed'),
      cancelFailuresWithWorkingOrders: this.countCancelFailuresWithWorkingOrders(
        recentAuditEvents,
      ),
      heartbeatFailuresWithOpenOrders: this.countAuditEvents(
        recentAuditEvents,
        'venue.heartbeat.degraded',
      ),
      divergenceStatus: this.readDivergenceStatus(latestExternalPortfolioCheckpoint),
      staleBookRejectCount: this.countStaleDecisionRejections(recentSignalDecisions),
      totalRecentDecisions: Array.isArray(recentSignalDecisions)
        ? recentSignalDecisions.length
        : 0,
    });
    const portfolioKillSwitches = this.portfolioKillSwitchService.evaluate({
      accountState,
      diagnostics: (recentExecutionDiagnostics ?? []).map((diagnostic: any) => ({
        expectedSlippage: this.readNumberField(diagnostic, 'expectedSlippage'),
        realizedSlippage: this.readNumberField(diagnostic, 'realizedSlippage'),
        expectedEv: this.readNumberField(diagnostic, 'expectedEv'),
        realizedEv: this.readNumberField(diagnostic, 'realizedEv'),
        staleOrder: this.readBooleanField(diagnostic, 'staleOrder') ?? false,
      })),
      venueInstability: {
        postFailureCount: this.countAuditEvents(recentAuditEvents, 'order.rejected_on_submit'),
        cancelFailureCount: this.countAuditEvents(recentAuditEvents, 'order.cancel_failed'),
        cancelFailuresWithWorkingOrders: this.countCancelFailuresWithWorkingOrders(
          recentAuditEvents,
        ),
        heartbeatFailuresWithOpenOrders: this.countAuditEvents(
          recentAuditEvents,
          'venue.heartbeat.degraded',
        ),
        divergenceStatus: this.readDivergenceStatus(latestExternalPortfolioCheckpoint),
        staleBookRejectCount: this.countStaleDecisionRejections(recentSignalDecisions),
        totalRecentDecisions: Array.isArray(recentSignalDecisions)
          ? recentSignalDecisions.length
          : 0,
      },
      limits: {
        maxIntradayDrawdownPct: config.maxDailyLossPct,
        maxHourlyDrawdownPct: Math.max(1, config.maxDailyLossPct / 2),
        maxConsecutiveLosses: config.maxConsecutiveLosses,
      },
    });

    const nextSafetyState = this.safetyStateMachine.evaluate({
      currentState: currentSafetyState.state,
      currentStateEnteredAt: currentSafetyState.enteredAt,
      dailyLossRatio,
      consecutiveLosses: accountState.consecutiveLosses,
      maxConsecutiveLosses: config.maxConsecutiveLosses,
      killSwitchTriggers: portfolioKillSwitches.triggers,
      lossAttributionSummary,
    });

    if (this.runtimeControl) {
      await this.runtimeControl.recordSafetyStateTransition({
        state: {
          state: nextSafetyState.state,
          enteredAt: nextSafetyState.enteredAt,
          reasonCodes: nextSafetyState.reasonCodes,
          sizeMultiplier: nextSafetyState.sizeMultiplier,
          evaluationCadenceMultiplier: nextSafetyState.evaluationCadenceMultiplier,
          allowAggressiveEntries: nextSafetyState.allowAggressiveEntries,
          allowNewEntries: nextSafetyState.allowNewEntries,
          haltRequested: nextSafetyState.haltRequested,
          maxNewSignalsPerTick: nextSafetyState.maxNewSignalsPerTick,
          evidence: nextSafetyState.evidence,
        },
        previousState: nextSafetyState.previousState,
        changed: nextSafetyState.changed,
      });
    }

    let approved = 0;
    let rejected = 0;
    let newEntriesApproved = 0;
    const safetyBlockReason =
      nextSafetyState.haltRequested
        ? nextSafetyState.reasonCodes[0] ?? 'safety_state_halt'
        : null;

    for (const signal of pendingSignals) {
      const existingDecision = await this.prisma.signalDecision.findFirst({
        where: { signalId: signal.id },
      });
      if (existingDecision) {
        continue;
      }

      const market = marketById.get(signal.marketId) ?? null;
      const now = new Date();
      const reasons: string[] = [];

      if (!market) {
        reasons.push('market_missing');
      }

      const resolvedIntent = market ? this.resolveEvaluationIntent(signal, market) : null;
      if (!resolvedIntent) {
        reasons.push('ambiguous_execution_intent');
      }

      const tokenId = resolvedIntent?.tokenId ?? null;
      const venueSide = resolvedIntent?.venueSide ?? null;
      const isNewExposure = resolvedIntent?.inventoryEffect === 'increase';

      const orderbook = tokenId
        ? await this.prisma.orderbook.findFirst({
            where: {
              marketId: signal.marketId,
              tokenId,
            },
            orderBy: { observedAt: 'desc' },
          })
        : null;

      const snapshot = await this.prisma.marketSnapshot.findFirst({
        where: { marketId: signal.marketId },
        orderBy: { observedAt: 'desc' },
      });

      const signalAgeMs = now.getTime() - new Date(signal.observedAt).getTime();
      if (signalAgeMs > appEnv.BOT_MAX_SIGNAL_AGE_MS) {
        reasons.push('signal_stale');
      }

      if (safetyBlockReason) {
        reasons.push(safetyBlockReason);
      }

      if (isNewExposure && !deploymentTier.allowNewEntries) {
        reasons.push('deployment_tier_blocks_entries');
      }

      if (isNewExposure && capitalRamp.capitalMultiplier <= 0) {
        reasons.push('capital_ramp_frozen');
      }

      if (
        isNewExposure &&
        !researchGovernanceHealthy &&
        appEnv.BOT_DEPLOYMENT_TIER !== 'paper' &&
        appEnv.BOT_DEPLOYMENT_TIER !== 'research'
      ) {
        reasons.push('research_governance_blocked');
      }

      if (
        isNewExposure &&
        !robustnessPassed &&
        appEnv.BOT_DEPLOYMENT_TIER !== 'paper' &&
        appEnv.BOT_DEPLOYMENT_TIER !== 'research'
      ) {
        reasons.push('robustness_evidence_missing');
      }

      if (isNewExposure && appEnv.BOT_DEPLOYMENT_TIER === 'scaled_live' && !chaosPassed) {
        reasons.push('chaos_harness_not_green');
      }

      if (
        !auditCoverage.healthy &&
        appEnv.BOT_DEPLOYMENT_TIER !== 'paper' &&
        appEnv.BOT_DEPLOYMENT_TIER !== 'research'
      ) {
        reasons.push('audit_coverage_unhealthy');
      }

      if (isNewExposure && !nextSafetyState.allowNewEntries) {
        reasons.push('safety_state_no_new_entries');
      }

      if (
        isNewExposure &&
        nextSafetyState.maxNewSignalsPerTick >= 0 &&
        newEntriesApproved >= nextSafetyState.maxNewSignalsPerTick
      ) {
        reasons.push('safety_reduced_frequency_entry_budget_exhausted');
      }

      if (isNewExposure) {
        const openSlotsUsed = config.maxOpenPositions - availableOpenSlots;
        const positionLimitCheck = this.positionLimits.evaluate({
          openPositions: Math.max(0, openSlotsUsed),
          maxOpenPositions: config.maxOpenPositions,
        });
        if (!positionLimitCheck.passed) {
          reasons.push(positionLimitCheck.reasonCode);
        }
      }

      if (signal.expectedEv <= 0) {
        reasons.push('positive_direction_but_negative_ev');
      }

      if (!signal.strategyVersionId) {
        reasons.push('strategy_version_missing');
      }

      if (!orderbook) {
        reasons.push('orderbook_missing');
      } else {
        const orderbookAgeMs = now.getTime() - new Date(orderbook.observedAt).getTime();
        if (orderbookAgeMs > appEnv.BOT_MAX_ORDERBOOK_AGE_MS) {
          await this.venueHealthLearningStore.recordStaleDataInterval(orderbookAgeMs);
          reasons.push('orderbook_stale');
        }
      }

      if (!snapshot) {
        reasons.push('market_snapshot_missing');
      } else {
        const snapshotAgeMs = now.getTime() - new Date(snapshot.observedAt).getTime();
        if (snapshotAgeMs > appEnv.BOT_MAX_MARKET_SNAPSHOT_AGE_MS) {
          await this.venueHealthLearningStore.recordStaleDataInterval(snapshotAgeMs);
          reasons.push('market_snapshot_stale');
        }
      }

      const expiry = snapshot?.expiresAt ?? market?.expiresAt ?? null;
      if (!expiry) {
        reasons.push('expiry_unknown');
      } else {
        const secondsToExpiry = Math.floor((new Date(expiry).getTime() - now.getTime()) / 1000);
        if (secondsToExpiry <= config.noTradeWindowSeconds) {
          reasons.push('no_trade_near_expiry');
        }
      }

      const kelly = this.cappedKelly.calculate({
        probability: this.boundProbability(signal.posteriorProbability),
        marketPrice: this.boundProbability(signal.marketImpliedProb),
        maxKellyFraction: config.maxKellyFraction,
      });
      const strategyVariantId =
        signal.strategyVersionId != null
          ? buildStrategyVariantId(signal.strategyVersionId)
          : null;
      const calibration =
        signal.strategyVersionId != null
          ? this.resolveCalibrationForSignal(
              calibrationByContext,
              signal.strategyVersionId,
              signal.regime,
            )
          : null;
      const executionContext =
        strategyVariantId != null
          ? this.resolveExecutionLearningContext(
              learningState,
              strategyVariantId,
              signal.regime,
            )
          : null;
      const activeExecutionPolicy =
        strategyVariantId != null
          ? this.resolveExecutionPolicyVersion(
              learningState,
              strategyVariantId,
              signal.regime,
            )
          : null;
      const regimeHealth =
        strategyVariantId != null
          ? this.resolveRegimeHealthForSignal(
              learningState,
              strategyVariantId,
              signal.regime,
            )
          : null;
      const rolloutControls = this.strategyRolloutController.getExecutionControls(
        deploymentRegistry,
        {
          strategyVersionId: signal.strategyVersionId,
        },
      );
      const portfolioAllocationDecision =
        signal.strategyVersionId != null
          ? this.resolvePortfolioAllocationDecision(
              learningState,
              buildStrategyVariantId(signal.strategyVersionId),
            )
          : null;
      const shrinkage = this.confidenceShrinkagePolicy.evaluate(calibration);
      const sizing = this.betSizing.calculate({
        bankroll,
        availableCapital: remainingCapital,
        cappedKellyFraction: kelly.cappedKellyFraction,
        maxPerTradeRiskPct: config.maxPerTradeRiskPct,
      });
      const contraction = this.bankrollContraction.apply({
        startingBankroll: appEnv.BOT_INITIAL_BANKROLL,
        currentBankroll: bankroll,
        baseSize: sizing.suggestedSize,
        mildDrawdownPct: 5,
        severeDrawdownPct: 10,
        mildMultiplier: 0.75,
        severeMultiplier: 0.5,
      });
      const provisionalPositionSize = Math.max(
        0,
        contraction.adjustedSize *
          (isNewExposure
            ? nextSafetyState.sizeMultiplier *
              shrinkage.sizeMultiplier *
              (portfolioAllocationDecision?.targetMultiplier ?? 1) *
              rolloutControls.sizeMultiplier *
              venueMode.sizeMultiplier *
              deploymentTier.perTradeRiskMultiplier *
              Math.max(0, capitalRamp.capitalMultiplier)
            : 1),
      );

      if (kelly.cappedKellyFraction <= 0) {
        reasons.push('kelly_size_zero');
      }
      if (sizing.riskBudget <= 0) {
        reasons.push('risk_budget_exhausted');
      }
      if (provisionalPositionSize <= 0) {
        reasons.push('position_size_zero');
      }
      if (isNewExposure && (portfolioAllocationDecision?.targetMultiplier ?? 1) <= 0) {
        reasons.push('portfolio_allocation_blocks_scaling');
      }
      if (isNewExposure && venueMode.blockNewEntries) {
        reasons.push(`venue_mode_${venueMode.mode}`);
      }
      if (rolloutControls.blocked) {
        reasons.unshift(...[...rolloutControls.reasonCodes].reverse());
      }

      const topLevelDepth = orderbook && venueSide
        ? this.topLevelDepth(orderbook, venueSide)
        : 0;
      const referencePrice =
        orderbook && venueSide
          ? venueSide === 'BUY'
            ? (orderbook.bestAsk ?? 0)
            : (orderbook.bestBid ?? 0)
          : null;
      const estimatedSizeUnits =
        referencePrice != null && Number.isFinite(referencePrice) && referencePrice > 0
          ? provisionalPositionSize / referencePrice
          : null;

      if (resolvedIntent && orderbook && venueSide) {
        if (topLevelDepth <= 0) {
          reasons.push('top_level_liquidity_missing');
        }

        if (
          referencePrice == null ||
          !Number.isFinite(referencePrice) ||
          referencePrice <= 0
        ) {
          reasons.push('reference_price_missing');
        } else {
          if (
            estimatedSizeUnits == null ||
            !Number.isFinite(estimatedSizeUnits) ||
            estimatedSizeUnits <= 0
          ) {
            reasons.push('estimated_order_size_invalid');
          } else if (topLevelDepth > 0 && estimatedSizeUnits > topLevelDepth * 0.8) {
            reasons.push('insufficient_top_level_liquidity');
          }

          if (isNewExposure && market && expiry) {
            const candidateExposure = this.buildCandidateExposure({
              marketId: market.id,
              outcome: resolvedIntent.outcome,
              expiryAt: expiry,
              signal,
              notional: provisionalPositionSize,
            });
            const positionLimitVerdict = this.multiDimensionalPositionLimits.evaluate({
              candidate: candidateExposure,
              openPositions: openPositions.map((position) =>
                this.buildOpenPositionExposure(position, marketById),
              ),
              workingOrders: workingOrders.map((order) =>
                this.buildWorkingOrderExposure(order, marketById),
              ),
              limits: {
                maxPerMarketNotional: bankroll * 0.2,
                maxPerOutcomeNotional: bankroll * 0.25,
                maxPerResolutionBucketNotional: bankroll * 0.35,
                maxAggregateNotional: bankroll * 0.75,
                maxSameThesisNotional: bankroll * 0.25,
              },
            });
            if (!positionLimitVerdict.passed) {
              reasons.push(positionLimitVerdict.reasonCode);
            }
          }
        }
      }

      const eligibility = this.marketEligibility.evaluate({
        market: {
          id: market?.id ?? signal.marketId,
          slug: this.readStringField(market, 'slug'),
          title: this.readStringField(market, 'title'),
          question: this.readStringField(market, 'title'),
          active: this.readStringField(market, 'status') !== 'closed',
          closed: this.readStringField(market, 'status') === 'closed',
          tradable: true,
          tokenIdYes: this.readStringField(market, 'tokenIdYes'),
          tokenIdNo: this.readStringField(market, 'tokenIdNo'),
          expiresAt: expiry ? new Date(expiry).toISOString() : null,
          negativeRisk:
            typeof (orderbook as Record<string, unknown> | null)?.negRisk === 'boolean'
              ? ((orderbook as Record<string, unknown>).negRisk as boolean)
              : false,
          enableOrderBook: !!orderbook,
        },
        spread: orderbook?.spread ?? null,
        bidDepth: orderbook ? this.topLevelDepth(orderbook, 'SELL') : 0,
        askDepth: orderbook ? this.topLevelDepth(orderbook, 'BUY') : 0,
        topLevelDepth: orderbook ? this.topLevelDepth(orderbook, venueSide ?? 'BUY') : 0,
        tickSize:
          typeof (orderbook as Record<string, unknown> | null)?.tickSize === 'number'
            ? ((orderbook as Record<string, unknown>).tickSize as number)
            : null,
        orderbookObservedAt: orderbook?.observedAt ?? null,
        marketObservedAt: snapshot?.observedAt ?? null,
        recentTradeCount: this.estimateRecentTradeCount(snapshot?.volume ?? null),
        maxOrderbookAgeMs: appEnv.BOT_MAX_ORDERBOOK_AGE_MS,
        maxMarketAgeMs: appEnv.BOT_MAX_MARKET_SNAPSHOT_AGE_MS,
        noTradeWindowSeconds: config.noTradeWindowSeconds,
      });
      if (!eligibility.eligible) {
        reasons.push(eligibility.reasonMessage ?? eligibility.reasonCode);
      }

      const liquidityHealthyBase =
        !!orderbook &&
        orderbook.bestBid != null &&
        orderbook.bestAsk != null &&
        (orderbook.spread ?? Number.POSITIVE_INFINITY) <= 0.06 &&
        this.topLevelDepth(orderbook, venueSide ?? 'BUY') > 0;

      const freshnessHealthy =
        !reasons.includes('signal_stale') &&
        !reasons.includes('orderbook_stale') &&
        !reasons.includes('market_snapshot_stale');

      const riskHealthy =
        !safetyBlockReason &&
        !reasons.includes('strategy_version_missing') &&
        !reasons.includes('kelly_size_zero') &&
        !reasons.includes('risk_budget_exhausted') &&
        !reasons.includes('position_size_zero') &&
        !reasons.includes('no_trade_near_expiry') &&
        !reasons.includes('deployment_tier_blocks_entries') &&
        !reasons.includes('capital_ramp_frozen') &&
        !reasons.includes('research_governance_blocked') &&
        !reasons.includes('robustness_evidence_missing') &&
        !reasons.includes('audit_coverage_unhealthy');
      const executionContextHealthy =
        liquidityHealthyBase &&
        freshnessHealthy &&
        riskHealthy &&
        operationalTruth.venueHealthy &&
        operationalTruth.reconciliationHealthy &&
        !venueMode.blockNewEntries &&
        venueAssessment.label !== 'unsafe';
      const evaluationMicrostructure = this.buildEvaluationMicrostructure({
        signal,
        orderbook,
        snapshot,
      });
      const halfLife = this.edgeHalfLifePolicy.evaluate({
        rawEdge: Math.abs(signal.edge ?? 0),
        signalAgeMs,
        timeToExpirySeconds: evaluationMicrostructure.timeToExpirySeconds,
        microstructure: evaluationMicrostructure.microstructure,
      });
      const netEdgeDecision = this.netEdgeEstimator.estimate({
        grossForecastEdge: Math.abs(signal.edge ?? 0),
        expectedEv: signal.expectedEv,
        feeRate: DEFAULT_FEE_RATE,
        spread: orderbook?.spread ?? null,
        signalAgeMs,
        halfLifeMultiplier: halfLife.decayMultiplier,
        topLevelDepth,
        estimatedOrderSizeUnits: estimatedSizeUnits,
        executionStyle: 'hybrid',
        calibrationHealth: calibration?.health ?? null,
        calibrationShrinkageFactor: calibration?.shrinkageFactor ?? null,
        calibrationSampleCount: calibration?.sampleCount ?? null,
        regimeHealth,
        venueUncertaintyLabel: venueAssessment.label,
        venueMode: venueMode.mode,
      });
      const netEdgeThreshold = this.netEdgeThresholdPolicy.evaluate({
        baseMinimumNetEdge:
          this.edgeDefinitionService.getDefinition().admissionThresholdPolicy.minimumNetEdge *
          shrinkage.thresholdMultiplier,
        netEdge: netEdgeDecision.breakdown,
        regimeHealth,
        venueUncertaintyLabel: venueAssessment.label,
      });
      const executionCostCalibration = this.executionCostCalibrator.calibrate({
        activePolicyVersion: activeExecutionPolicy,
        executionContext,
        recentObservations: this.selectRecentExecutionCostObservations(
          recentExecutionDiagnostics,
          signal.strategyVersionId,
          signal.regime ?? null,
        ),
        cancelFailureRate: this.calculateCancelFailureRate(recentAuditEvents),
        venueUncertaintyLabel: venueAssessment.label,
      });
      const entryTiming = this.entryTimingEfficiencyScorer.score({
        signalAgeMs,
        timeToExpirySeconds: evaluationMicrostructure.timeToExpirySeconds,
        halfLifeMultiplier: halfLife.decayMultiplier,
        halfLifeExpired: halfLife.expired,
        expectedFillDelayMs: executionCostCalibration.expectedFillDelayMs,
        microstructureDecayPressure: evaluationMicrostructure.microstructure.decayPressure,
      });
      const executionCostAssessment = this.realizedCostModel.evaluate({
        grossEdge: netEdgeDecision.breakdown.finalNetEdge,
        feeCost: executionCostCalibration.feeCost,
        slippageCost: executionCostCalibration.slippageCost,
        adverseSelectionCost: executionCostCalibration.adverseSelectionCost,
        fillDelayMs: signalAgeMs + (executionCostCalibration.expectedFillDelayMs ?? 0),
        expectedFillDelayMs: executionCostCalibration.expectedFillDelayMs,
        cancelReplaceOverheadCost: executionCostCalibration.cancelReplaceOverheadCost,
        missedOpportunityCost: executionCostCalibration.missedOpportunityCost,
      });
      const additionalExecutionCost = this.additionalExecutionCost(
        netEdgeDecision.breakdown,
        executionCostAssessment,
      );
      const noTradeZone = this.noTradeZonePolicy.evaluate({
        timeToExpirySeconds: evaluationMicrostructure.timeToExpirySeconds,
        noTradeWindowSeconds: config.noTradeWindowSeconds,
        btcFresh: true,
        orderbookFresh: !reasons.includes('orderbook_stale'),
        spread: orderbook?.spread ?? Number.POSITIVE_INFINITY,
        topLevelDepth,
        microstructure: evaluationMicrostructure.microstructure,
        governanceHealthy: researchGovernanceHealthy,
        edgeHalfLifeHealthy: !halfLife.expired,
        netEdge: netEdgeDecision.breakdown,
        thresholdDecision: netEdgeThreshold,
        calibrationHealth: calibration?.health ?? null,
        regimeHealth,
        executionContextHealthy,
        venueUncertaintyLabel: venueAssessment.label,
      });
      const calibratedExecutableEdge = this.buildExecutableEdgeEstimate(
        netEdgeDecision,
        netEdgeThreshold,
        additionalExecutionCost,
      );
      const sizingSignalConfidence = Math.min(
        this.boundProbability(Math.abs(signal.posteriorProbability - 0.5) * 2),
        netEdgeDecision.breakdown.confidence,
      );
      const opportunityClass = this.classifyOpportunityClass(
        calibratedExecutableEdge.finalNetEdge ?? 0,
        netEdgeThreshold.minimumNetEdge,
      );
      const recentVariantTradeQuality = this.filterRecentTradeQualityScores(
        recentTradeQualityScores,
        strategyVariantId,
        signal.regime ?? null,
      );
      const regimeLeakGroup = this.findRegimeLeakGroup(latestCapitalLeakReport, signal.regime ?? null);
      const currentDrawdownPct = this.readNumberRecordField(
        portfolioAllocationDecision?.evidence,
        'currentDrawdown',
      );
      const maxDrawdownPct = this.readNumberRecordField(
        portfolioAllocationDecision?.evidence,
        'maxDrawdown',
      );
      const regimeProfitability = this.regimeProfitabilityRanker.rank({
        strategyVariantId,
        regime: signal.regime ?? null,
        regimeSnapshot: this.resolveRegimeSnapshot(
          learningState,
          strategyVariantId,
          signal.regime ?? null,
        ),
        calibrationHealth: calibration?.health ?? null,
        executionContext,
        recentTradeQualityScores: recentVariantTradeQuality,
        currentDrawdownPct,
        maxDrawdownPct,
        recentLeakShare: regimeLeakGroup?.dominantShare ?? latestCapitalLeakReport?.dominantShare ?? null,
      });
      const regimeCapitalTreatment = this.regimeCapitalPolicy.decide({
        assessment: regimeProfitability,
        portfolioAllocationMultiplier: portfolioAllocationDecision?.targetMultiplier ?? 1,
      });
      const regimeDisableDecision = this.regimeDisablePolicy.evaluate({
        assessment: regimeProfitability,
        recentTradeQualityScores: recentVariantTradeQuality,
        recentLeakShare: regimeLeakGroup?.dominantShare ?? latestCapitalLeakReport?.dominantShare ?? null,
        recentLeakDominantCategory:
          regimeLeakGroup?.dominantCategory ?? latestCapitalLeakReport?.dominantCategory ?? null,
      });
      const recentTradeQualityScore =
        recentVariantTradeQuality.length > 0
          ? recentVariantTradeQuality.reduce(
              (sum, score) => sum + score.breakdown.overallScore,
              0,
            ) / recentVariantTradeQuality.length
          : null;
      const tradeFrequencyDecision = this.tradeFrequencyGovernor.evaluate({
        regime: signal.regime ?? null,
        regimeRank: regimeProfitability.rank,
        opportunityClass,
        recentTradeCount: recentVariantTradeQuality.length,
        recentTradeQualityScore,
        recentCapitalLeakageShare:
          regimeLeakGroup?.dominantShare ?? latestCapitalLeakReport?.dominantShare ?? null,
        currentDrawdownPct: Math.max(0, currentDrawdownPct ?? dailyLossRatio),
      });
      const recentMarginalActivity = this.summarizeMarginalActivity(recentAdmissionEvents);
      const lowQualityTradeShare =
        recentVariantTradeQuality.length > 0
          ? recentVariantTradeQuality.filter(
              (score) => score.label === 'poor' || score.label === 'destructive',
            ).length / recentVariantTradeQuality.length
          : 0;
      const marginalEdgeCooldown = this.marginalEdgeCooldownPolicy.evaluate({
        opportunityClass,
        marginAboveThreshold: netEdgeThreshold.marginAboveThreshold,
        recentMarginalApprovalCount: recentMarginalActivity.marginalApprovalCount,
        recentMarginalAttemptCount:
          recentMarginalActivity.marginalApprovalCount +
          recentMarginalActivity.weakRejectCount,
        recentLowQualityTradeShare: lowQualityTradeShare,
      });
      const opportunitySaturation = this.opportunitySaturationDetector.evaluate({
        recentApprovedCount: recentMarginalActivity.approvedCount,
        recentStrongApprovalCount: recentMarginalActivity.strongApprovalCount,
        recentMarginalApprovalCount: recentMarginalActivity.marginalApprovalCount,
        recentWeakRejectCount: recentMarginalActivity.weakRejectCount,
        recentAverageMarginAboveThreshold: recentMarginalActivity.averageMarginAboveThreshold,
        recentTradeQualityScore,
        recentCapitalLeakageShare:
          regimeLeakGroup?.dominantShare ?? latestCapitalLeakReport?.dominantShare ?? null,
      });
      const regimeAllowed =
        signal.regime !== 'illiquid_noisy_book' &&
        signal.regime !== 'near_resolution_microstructure_chaos' &&
        !regimeDisableDecision.blockNewTrades &&
        !regimeCapitalTreatment.blockNewTrades;
      const waveThreePositionSize = Math.max(
        0,
        provisionalPositionSize *
          (isNewExposure
            ? regimeCapitalTreatment.capitalMultiplier *
              regimeDisableDecision.sizeMultiplier *
              tradeFrequencyDecision.sizeMultiplier *
              marginalEdgeCooldown.sizeMultiplier *
              opportunitySaturation.sizeMultiplier
            : 1),
      );
      const sampleCount =
        calibration?.sampleCount ??
        executionContext?.sampleCount ??
        this.resolveRegimeSnapshot(learningState, strategyVariantId, signal.regime ?? null)
          ?.sampleCount ??
        null;
      const sizePenalty = this.sizePenaltyEngine.evaluate({
        calibrationHealth: calibration?.health ?? null,
        executionHealth: executionContext?.health ?? activeExecutionPolicy?.health ?? null,
        regimeHealth,
        venueUncertaintyLabel: venueAssessment.label,
        concentrationPenaltyMultiplier: this.readNumberRecordField(
          portfolioAllocationDecision?.evidence,
          'concentrationPenaltyMultiplier',
        ),
        correlationPenaltyMultiplier: this.readNumberRecordField(
          portfolioAllocationDecision?.evidence,
          'correlationPenaltyMultiplier',
        ),
      });
      const uncertaintySizing = this.uncertaintyWeightedSizing.evaluate({
        basePositionSize: waveThreePositionSize,
        netEdge: calibratedExecutableEdge.finalNetEdge ?? 0,
        netEdgeThreshold: netEdgeThreshold.minimumNetEdge,
        calibrationHealth: calibration?.health ?? null,
        executionHealth: executionContext?.health ?? activeExecutionPolicy?.health ?? null,
        regimeHealth,
        venueHealth: venueAssessment.label,
        currentDrawdownPct: Math.max(0, currentDrawdownPct ?? dailyLossRatio),
        sampleCount,
      });
      const timingAdjustedPositionSize = Math.max(
        0,
        uncertaintySizing.adjustedPositionSize *
          sizePenalty.multiplier *
          entryTiming.sizeMultiplier,
      );
      const liquidityDecision = this.sizeVsLiquidityPolicy.evaluate({
        desiredNotional: timingAdjustedPositionSize,
        desiredSizeUnits:
          referencePrice != null && referencePrice > 0
            ? timingAdjustedPositionSize / referencePrice
            : 0,
        price: referencePrice ?? 0,
        topLevelDepth,
        spread: orderbook?.spread ?? null,
        expectedSlippage: Math.max(
          netEdgeDecision.breakdown.costEstimate.slippageCost,
          executionCostCalibration.slippageCost,
        ),
        route: activeExecutionPolicy?.recommendedRoute ?? 'taker',
      });
      const cappedByLiquidityPositionSize = Math.max(
        0,
        Math.min(timingAdjustedPositionSize, liquidityDecision.allowedNotional),
      );
      const maxLossDecision = this.maxLossPerOpportunityPolicy.evaluate({
        candidatePositionSize: cappedByLiquidityPositionSize,
        bankroll,
        availableCapital: remainingCapital,
        maxPerTradeRiskPct: config.maxPerTradeRiskPct,
        opportunityClass,
        signalConfidence: sizingSignalConfidence,
      });
      const positionSize = Math.max(
        0,
        Math.min(cappedByLiquidityPositionSize, maxLossDecision.maxAllowedPositionSize),
      );
      const liquidityHealthy = liquidityHealthyBase && !liquidityDecision.blockTrade;

      if (isNewExposure && regimeCapitalTreatment.blockNewTrades) {
        reasons.push(`regime_capital_policy_${regimeCapitalTreatment.treatment}`);
      }
      if (isNewExposure && regimeDisableDecision.blockNewTrades) {
        reasons.push(`regime_disable_policy_${regimeDisableDecision.status}`);
      }
      if (isNewExposure && tradeFrequencyDecision.blockTrade) {
        reasons.push('trade_frequency_governor_blocked');
      }
      if (isNewExposure && marginalEdgeCooldown.blockTrade) {
        reasons.push('marginal_edge_cooldown_active');
      }
      if (isNewExposure && opportunitySaturation.blockTrade) {
        reasons.push('opportunity_saturation_detected');
      }
      if (entryTiming.blockTrade) {
        reasons.push('entry_timing_blocks_opportunity');
      }
      if ((calibratedExecutableEdge.finalNetEdge ?? 0) <= 0) {
        reasons.push('execution_cost_adjusted_edge_non_positive');
      }
      if (liquidityDecision.blockTrade) {
        reasons.push('liquidity_policy_blocks_size');
      }
      if (maxLossDecision.blockTrade) {
        reasons.push('max_loss_per_opportunity_blocked');
      }
      if (isNewExposure && positionSize <= 0) {
        reasons.push('wave4_position_size_zero');
      }

      const admission = this.tradeAdmissionGate.evaluate({
        edgeDefinitionVersion: this.edgeDefinitionService.getDefinition().version,
        signalPresent: reasons.length === 0 || !reasons.includes('market_missing'),
        directionalEdge: netEdgeDecision.breakdown.grossForecastEdge,
        executableEv: calibratedExecutableEdge.finalNetEdge,
        signalConfidence: sizingSignalConfidence,
        walkForwardConfidence:
          signal.expectedEv > 0 && Math.abs(signal.edge ?? 0) > 0
            ? this.boundProbability(signal.expectedEv / Math.abs(signal.edge ?? 0))
            : 0,
        liquidityHealthy,
        freshnessHealthy,
        venueHealthy: operationalTruth.venueHealthy && eligibility.eligible,
        reconciliationHealthy: operationalTruth.reconciliationHealthy,
        riskHealthy,
        regimeAllowed,
        noTradeZoneBlocked: noTradeZone.blocked,
        halfLifeExpired: halfLife.expired,
        paperEdgeDetected: netEdgeDecision.breakdown.paperEdgeBlocked,
        admissionThreshold: netEdgeThreshold.minimumNetEdge,
        executableEdge: calibratedExecutableEdge,
        minimumConfidence:
          this.edgeDefinitionService.getDefinition().admissionThresholdPolicy.minimumConfidence,
      });

      if (reasons.length === 0 && !admission.admitted) {
        reasons.push(admission.reasonCode);
      }

      if (reasons.length > 0) {
        const decisionId = randomUUID();
        await this.prisma.signalDecision.create({
          data: {
            id: decisionId,
            signalId: signal.id,
            verdict: 'rejected',
            reasonCode: reasons[0],
            reasonMessage: reasons.join(','),
            expectedEv: signal.expectedEv,
            positionSize: null,
            decisionAt: now,
          },
        });

        await this.prisma.signal.update({
          where: { id: signal.id },
          data: { status: 'rejected' },
        });
        await this.decisionLogService.record({
          category: 'admission',
          eventType: 'signal.execution_decision',
          summary: `Execution admission rejected for signal ${signal.id}.`,
          signalId: signal.id,
          marketId: signal.marketId,
          payload: {
            reasons,
            deploymentTier,
            capitalRamp,
            executableEdge: calibratedExecutableEdge,
            netEdgeDecision,
            netEdgeThreshold,
            executionCostCalibration,
            executionCostAssessment,
            entryTiming,
            opportunityClass,
            noTradeZone,
            halfLife,
            auditCoverage,
            calibration,
            regimeHealth,
            regimeProfitability,
            regimeCapitalTreatment,
            regimeDisableDecision,
            tradeFrequencyDecision,
            marginalEdgeCooldown,
            opportunitySaturation,
            uncertaintySizing,
            sizePenalty,
            liquidityDecision,
            maxLossDecision,
            shrinkage,
            portfolioAllocationDecision,
            rolloutControls,
            venueAssessment,
            venueMode,
          },
          createdAt: now.toISOString(),
        });
        await this.versionLineageRegistry.recordDecision({
          decisionId,
          decisionType: 'signal_execution',
          recordedAt: now.toISOString(),
          summary: `Execution admission rejected for signal ${signal.id}.`,
          signalId: signal.id,
          signalDecisionId: decisionId,
          marketId: signal.marketId,
          strategyVariantId:
            strategyVariantId,
          lineage: {
            strategyVersion: buildStrategyVersionLineage({
              strategyVersionId: signal.strategyVersionId,
              strategyVariantId,
            }),
            featureSetVersion: buildFeatureSetVersionLineage({
              featureSetId: 'btc-five-minute-live-signal',
              parentStrategyVersionId: signal.strategyVersionId,
              parameters: {
                signalShape: 'stored-signal-evaluation',
                regime: signal.regime ?? null,
                outcome: resolvedIntent?.outcome ?? null,
              },
            }),
            calibrationVersion: buildCalibrationVersionLineage(calibration),
            executionPolicyVersion: null,
            riskPolicyVersion: buildRiskPolicyVersionLineage({
              policyId: 'trade-evaluation',
              parameters: {
                runtimeConfig: config,
                deploymentTier,
                capitalRamp,
                netEdgeThreshold,
                executionCostCalibration,
                executionCostAssessment,
                entryTiming,
                regimeProfitability,
                regimeCapitalTreatment,
                regimeDisableDecision,
                tradeFrequencyDecision,
                marginalEdgeCooldown,
                opportunitySaturation,
                uncertaintySizing,
                sizePenalty,
                liquidityDecision,
                maxLossDecision,
                rolloutControls,
                safetyState: nextSafetyState,
                venueMode,
              },
            }),
            allocationPolicyVersion: portfolioAllocationDecision
              ? buildAllocationPolicyVersionLineage({
                  policyId: 'capital-allocation-engine',
                  strategyVariantId: buildStrategyVariantId(signal.strategyVersionId ?? ''),
                  allocationDecisionKey: portfolioAllocationDecision.decisionKey,
                  parameters: portfolioAllocationDecision.evidence,
                })
              : null,
          },
          replay: {
            marketState: {
              signal,
              market,
              orderbook,
              marketSnapshot: snapshot,
            },
            runtimeState: {
              runtimeStatus,
              safetyState: nextSafetyState,
            },
            learningState: {
              calibration,
              executionContext,
              activeExecutionPolicy,
              portfolioAllocationDecision,
              regimeProfitability,
              lastCycleSummary: learningState.lastCycleSummary,
            },
            lineageState: {
              incumbentVariantId: deploymentRegistry.incumbentVariantId,
              activeRollout: deploymentRegistry.activeRollout,
            },
            activeParameterBundle: {
              deploymentTier,
              capitalRamp,
              executableEdge: calibratedExecutableEdge,
              netEdgeDecision,
              netEdgeThreshold,
              executionCostCalibration,
              executionCostAssessment,
              entryTiming,
              opportunityClass,
              noTradeZone,
              halfLife,
              shrinkage,
              regimeHealth,
              regimeProfitability,
              regimeCapitalTreatment,
              regimeDisableDecision,
              tradeFrequencyDecision,
              marginalEdgeCooldown,
              opportunitySaturation,
              uncertaintySizing,
              sizePenalty,
              liquidityDecision,
              maxLossDecision,
              rolloutControls,
              venueAssessment,
            },
            venueMode: venueMode.mode,
            venueUncertainty: venueAssessment.label,
          },
          tags: ['wave5', 'phase12_wave1', 'phase12_wave3', 'signal-execution', 'rejected'],
        });
        rejected += 1;
        continue;
      }

      const decisionId = randomUUID();
      await this.prisma.signalDecision.create({
        data: {
          id: decisionId,
          signalId: signal.id,
          verdict: 'approved',
          reasonCode: 'passed',
          reasonMessage: [
            `tokenId=${resolvedIntent!.tokenId}`,
            `outcome=${resolvedIntent!.outcome}`,
            `action=${resolvedIntent!.action}`,
            `venueSide=${resolvedIntent!.venueSide}`,
            `inventoryEffect=${resolvedIntent!.inventoryEffect}`,
            `safetyState=${nextSafetyState.state}`,
          ].join(','),
          expectedEv: signal.expectedEv,
          positionSize,
          decisionAt: now,
        },
      });

      await this.prisma.signal.update({
        where: { id: signal.id },
        data: { status: 'approved' },
      });
      await this.decisionLogService.record({
        category: 'admission',
        eventType: 'signal.execution_decision',
        summary: `Execution admission approved for signal ${signal.id}.`,
        signalId: signal.id,
        marketId: signal.marketId,
        payload: {
          deploymentTier,
          capitalRamp,
          executableEdge: calibratedExecutableEdge,
          netEdgeDecision,
          netEdgeThreshold,
          executionCostCalibration,
          executionCostAssessment,
          entryTiming,
          opportunityClass,
          noTradeZone,
          halfLife,
          positionSize,
          calibration,
          regimeHealth,
          regimeProfitability,
          regimeCapitalTreatment,
          regimeDisableDecision,
          tradeFrequencyDecision,
          marginalEdgeCooldown,
          opportunitySaturation,
          uncertaintySizing,
          sizePenalty,
          liquidityDecision,
          maxLossDecision,
          shrinkage,
          portfolioAllocationDecision,
          rolloutControls,
          venueAssessment,
          venueMode,
        },
        createdAt: now.toISOString(),
      });
      await this.versionLineageRegistry.recordDecision({
        decisionId,
        decisionType: 'signal_execution',
        recordedAt: now.toISOString(),
        summary: `Execution admission approved for signal ${signal.id}.`,
        signalId: signal.id,
        signalDecisionId: decisionId,
        marketId: signal.marketId,
        strategyVariantId:
          strategyVariantId,
        lineage: {
          strategyVersion: buildStrategyVersionLineage({
            strategyVersionId: signal.strategyVersionId,
            strategyVariantId,
          }),
          featureSetVersion: buildFeatureSetVersionLineage({
            featureSetId: 'btc-five-minute-live-signal',
            parentStrategyVersionId: signal.strategyVersionId,
            parameters: {
              signalShape: 'stored-signal-evaluation',
              regime: signal.regime ?? null,
              outcome: resolvedIntent?.outcome ?? null,
            },
          }),
          calibrationVersion: buildCalibrationVersionLineage(calibration),
          executionPolicyVersion: null,
          riskPolicyVersion: buildRiskPolicyVersionLineage({
            policyId: 'trade-evaluation',
              parameters: {
                runtimeConfig: config,
                deploymentTier,
                capitalRamp,
                netEdgeThreshold,
                executionCostCalibration,
                executionCostAssessment,
                entryTiming,
                regimeProfitability,
                regimeCapitalTreatment,
                regimeDisableDecision,
                tradeFrequencyDecision,
                marginalEdgeCooldown,
                opportunitySaturation,
                uncertaintySizing,
                sizePenalty,
                liquidityDecision,
                maxLossDecision,
                rolloutControls,
                safetyState: nextSafetyState,
                venueMode,
              },
            }),
          allocationPolicyVersion: portfolioAllocationDecision
            ? buildAllocationPolicyVersionLineage({
                policyId: 'capital-allocation-engine',
                strategyVariantId: buildStrategyVariantId(signal.strategyVersionId ?? ''),
                allocationDecisionKey: portfolioAllocationDecision.decisionKey,
                parameters: portfolioAllocationDecision.evidence,
              })
            : null,
        },
        replay: {
          marketState: {
            signal,
            market,
            orderbook,
            marketSnapshot: snapshot,
          },
          runtimeState: {
            runtimeStatus,
            safetyState: nextSafetyState,
          },
          learningState: {
            calibration,
            executionContext,
            activeExecutionPolicy,
            portfolioAllocationDecision,
            regimeProfitability,
            lastCycleSummary: learningState.lastCycleSummary,
          },
          lineageState: {
            incumbentVariantId: deploymentRegistry.incumbentVariantId,
            activeRollout: deploymentRegistry.activeRollout,
          },
          activeParameterBundle: {
            deploymentTier,
            capitalRamp,
            executableEdge: calibratedExecutableEdge,
            netEdgeDecision,
            netEdgeThreshold,
            executionCostCalibration,
            executionCostAssessment,
            entryTiming,
            opportunityClass,
            noTradeZone,
            halfLife,
            positionSize,
            regimeHealth,
            regimeProfitability,
            regimeCapitalTreatment,
            regimeDisableDecision,
            tradeFrequencyDecision,
            marginalEdgeCooldown,
            opportunitySaturation,
            uncertaintySizing,
            sizePenalty,
            liquidityDecision,
            maxLossDecision,
            shrinkage,
            rolloutControls,
            venueAssessment,
          },
          venueMode: venueMode.mode,
          venueUncertainty: venueAssessment.label,
        },
        tags: ['wave5', 'phase12_wave1', 'phase12_wave3', 'signal-execution', 'approved'],
      });

      if (isNewExposure) {
        availableOpenSlots -= 1;
        remainingCapital = Math.max(0, remainingCapital - positionSize);
        newEntriesApproved += 1;
      }
      approved += 1;
    }

    this.logger.debug('Signal evaluation complete.', {
      approved,
      rejected,
      safetyState: nextSafetyState.state,
      safetyReasons: nextSafetyState.reasonCodes,
    });

    return {
      approved,
      rejected,
      killSwitchTriggered: nextSafetyState.haltRequested,
      killSwitchReason: safetyBlockReason,
      safetyState: nextSafetyState.state,
      safetyReasonCodes: nextSafetyState.reasonCodes,
      safetyControls: {
        state: nextSafetyState.state,
        sizeMultiplier: nextSafetyState.sizeMultiplier,
        evaluationCadenceMultiplier: nextSafetyState.evaluationCadenceMultiplier,
        allowAggressiveEntries: nextSafetyState.allowAggressiveEntries,
        allowNewEntries: nextSafetyState.allowNewEntries,
        haltRequested: nextSafetyState.haltRequested,
        maxNewSignalsPerTick: nextSafetyState.maxNewSignalsPerTick,
      },
    };
  }

  private defaultSafetyState(): PersistedSafetyState {
    const controls = controlsForSafetyState('normal');
    return {
      ...controls,
      enteredAt: new Date(0).toISOString(),
      reasonCodes: [],
      evidence: {},
    };
  }

  private buildLossAttributionSummary(input: {
    diagnostics: unknown[];
    auditEvents: unknown[];
    realizedPnlDay: number;
  }) {
    const evidences: LossAttributionEvidence[] = (input.diagnostics ?? [])
      .map((diagnostic) => ({
        pnl: this.readNumberField(diagnostic, 'realizedEv') ?? 0,
        expectedEv: this.readNumberField(diagnostic, 'expectedEv'),
        realizedSlippage: this.readNumberField(diagnostic, 'realizedSlippage'),
        expectedSlippage: this.readNumberField(diagnostic, 'expectedSlippage'),
        staleData: this.readBooleanField(diagnostic, 'staleOrder') ?? false,
        liquidityStress:
          (this.readNumberField(diagnostic, 'realizedSlippage') ?? 0) >
          (this.readNumberField(diagnostic, 'expectedSlippage') ?? 0),
        regime: this.readStringField(diagnostic, 'regime'),
        currentRegime: this.readStringField(diagnostic, 'regime'),
      }))
      .filter((evidence) => evidence.pnl < 0);

    if (evidences.length === 0 && input.realizedPnlDay < 0) {
      const recentReasons = (input.auditEvents ?? [])
        .map((event) => this.readStringField(event, 'eventType'))
        .filter((value): value is string => typeof value === 'string');
      evidences.push({
        pnl: input.realizedPnlDay,
        expectedEv: null,
        realizedSlippage: null,
        expectedSlippage: null,
        staleData: recentReasons.some((reason) => reason.includes('stale')),
        venueFailure: recentReasons.some(
          (reason) => reason.includes('venue') || reason.includes('reject'),
        ),
        executionFailure: recentReasons.some(
          (reason) => reason.includes('cancel_failed') || reason.includes('rejected_on_submit'),
        ),
        liquidityStress: recentReasons.some((reason) => reason.includes('liquidity')),
        regime: null,
        currentRegime: null,
      });
    }

    return this.lossAttributionModel.summarize(evidences);
  }

  private countAuditEvents(events: unknown[], eventType: string): number {
    return (events ?? []).filter(
      (event) => this.readStringField(event, 'eventType') === eventType,
    ).length;
  }

  private countCancelFailuresWithWorkingOrders(events: unknown[]): number {
    return (events ?? []).filter((event) => {
      if (this.readStringField(event, 'eventType') !== 'order.cancel_failed') {
        return false;
      }

      const metadata =
        event && typeof event === 'object' && 'metadata' in (event as Record<string, unknown>)
          ? ((event as Record<string, unknown>).metadata as Record<string, unknown> | null)
          : null;
      const workingOrdersRemaining =
        metadata && typeof metadata === 'object'
          ? Number(metadata.workingOrdersRemaining ?? Number.NaN)
          : Number.NaN;

      return Number.isFinite(workingOrdersRemaining) && workingOrdersRemaining > 0;
    }).length;
  }

  private countStaleDecisionRejections(decisions: unknown[]): number {
    return (decisions ?? []).filter((decision) => {
      const verdict = this.readStringField(decision, 'verdict');
      const reasonCode = this.readStringField(decision, 'reasonCode') ?? '';
      return verdict === 'rejected' && reasonCode.includes('stale');
    }).length;
  }

  private estimateRecentTradeCount(volume: number | null): number {
    if (!Number.isFinite(volume ?? Number.NaN) || (volume ?? 0) <= 0) {
      return 0;
    }

    if ((volume ?? 0) >= 500) {
      return 10;
    }
    if ((volume ?? 0) >= 100) {
      return 5;
    }

    return 1;
  }

  private buildEvaluationMicrostructure(input: {
    signal: {
      posteriorProbability: number;
      marketImpliedProb: number;
      observedAt: Date;
    };
    orderbook:
      | {
          bestBid: number | null;
          bestAsk: number | null;
          spread: number | null;
          bidLevels: unknown;
          askLevels: unknown;
        }
      | null;
    snapshot:
      | {
          expiresAt: Date | null;
        }
      | null;
  }): {
    timeToExpirySeconds: number | null;
    microstructure: ReturnType<EventMicrostructureModel['derive']>;
  } {
    const pseudoFeatures = this.featureBuilder.build({
      candles: {
        symbol: 'BTCUSD',
        timeframe: '5m',
        candles: [
          {
            timestamp: input.signal.observedAt.toISOString(),
            open: 1,
            high: 1.01,
            low: 0.99,
            close: 1,
            volume: 1,
          },
          {
            timestamp: new Date(input.signal.observedAt.getTime() + 60_000).toISOString(),
            open: 1,
            high: 1.01,
            low: 0.99,
            close: 1,
            volume: 1,
          },
          {
            timestamp: new Date(input.signal.observedAt.getTime() + 120_000).toISOString(),
            open: 1,
            high: 1.01,
            low: 0.99,
            close: 1,
            volume: 1,
          },
        ],
      },
      orderbook: input.orderbook
        ? {
            bidLevels: Array.isArray(input.orderbook.bidLevels)
              ? (input.orderbook.bidLevels as Array<{ price: number; size: number }>)
              : [],
            askLevels: Array.isArray(input.orderbook.askLevels)
              ? (input.orderbook.askLevels as Array<{ price: number; size: number }>)
              : [],
            spread: input.orderbook.spread ?? 0,
          }
        : null,
      expiresAt: input.snapshot?.expiresAt?.toISOString() ?? null,
    });

    return {
      timeToExpirySeconds: pseudoFeatures.timeToExpirySeconds,
      microstructure: this.microstructureModel.derive({
        features: pseudoFeatures,
        posteriorProbability: input.signal.posteriorProbability,
        marketImpliedProbability: input.signal.marketImpliedProb,
      }),
    };
  }

  private buildExecutableEdgeEstimate(
    netEdgeDecision: NetEdgeDecision,
    thresholdDecision: NetEdgeThresholdDecision,
    additionalExecutionCost = 0,
  ): ExecutableEdgeEstimate {
    const spreadAdjustedEdge =
      netEdgeDecision.breakdown.grossForecastEdge -
      netEdgeDecision.breakdown.costEstimate.spreadComponent;
    const finalNetEdge = netEdgeDecision.breakdown.finalNetEdge - Math.max(0, additionalExecutionCost);
    return {
      edgeDefinitionVersion: this.edgeDefinitionService.getDefinition().version,
      executionStyle: netEdgeDecision.breakdown.executionStyle,
      rawModelEdge: netEdgeDecision.breakdown.grossForecastEdge,
      spreadAdjustedEdge,
      slippageAdjustedEdge: netEdgeDecision.breakdown.afterSlippageEdge,
      feeAdjustedEdge: netEdgeDecision.breakdown.afterFeesEdge,
      timeoutAdjustedEdge: netEdgeDecision.breakdown.afterAdverseSelectionEdge,
      staleSignalAdjustedEdge: netEdgeDecision.breakdown.afterUncertaintyEdge,
      inventoryAdjustedEdge: finalNetEdge,
      finalNetEdge,
      threshold: thresholdDecision.minimumNetEdge,
      missingInputs: netEdgeDecision.breakdown.missingInputs,
      staleInputs: netEdgeDecision.breakdown.staleInputs,
      paperEdgeBlocked: netEdgeDecision.breakdown.paperEdgeBlocked,
      confidence: netEdgeDecision.breakdown.confidence,
    };
  }

  private resolveCalibrationForSignal(
    calibrationByContext: Record<string, CalibrationState>,
    strategyVariantId: string,
    regime: string | null,
  ): CalibrationState | null {
    const exactKey = buildCalibrationContextKey(strategyVariantId, regime);
    if (calibrationByContext[exactKey]) {
      return calibrationByContext[exactKey] ?? null;
    }

    return calibrationByContext[buildCalibrationContextKey(strategyVariantId, null)] ?? null;
  }

  private resolvePortfolioAllocationDecision(
    learningState: Awaited<ReturnType<LearningStateStore['load']>>,
    strategyVariantId: string,
  ) {
    return learningState.portfolioLearning.allocationDecisions[strategyVariantId] ?? null;
  }

  private resolveExecutionPolicyVersion(
    learningState: Awaited<ReturnType<LearningStateStore['load']>>,
    strategyVariantId: string,
    regime: string | null,
  ) {
    const context = this.resolveExecutionLearningContext(learningState, strategyVariantId, regime);
    const versionId =
      context?.activePolicyVersionId ??
      Object.entries(learningState.executionLearning.activePolicyVersionIds).find(([key]) =>
        key.includes(strategyVariantId) && key.includes(`regime:${regime ?? 'all'}`),
      )?.[1] ??
      null;
    return versionId ? learningState.executionLearning.policyVersions[versionId] ?? null : null;
  }

  private resolveRegimeHealthForSignal(
    learningState: Awaited<ReturnType<LearningStateStore['load']>>,
    strategyVariantId: string,
    regime: string | null,
  ): HealthLabel | null {
    const variant = learningState.strategyVariants[strategyVariantId] ?? null;
    if (!variant) {
      return null;
    }

    const snapshots = Object.values(variant.regimeSnapshots).filter(
      (snapshot) => snapshot.regime === regime,
    );
    if (snapshots.length === 0) {
      return variant.health ?? null;
    }

    const priority: Record<HealthLabel, number> = {
      healthy: 0,
      watch: 1,
      degraded: 2,
      quarantine_candidate: 3,
    };
    return snapshots.reduce<HealthLabel>(
      (worst, snapshot) =>
        priority[snapshot.health] > priority[worst] ? snapshot.health : worst,
      variant.health ?? 'healthy',
    );
  }

  private resolveRegimeSnapshot(
    learningState: Awaited<ReturnType<LearningStateStore['load']>>,
    strategyVariantId: string | null,
    regime: string | null,
  ) {
    if (!strategyVariantId) {
      return null;
    }

    const variant = learningState.strategyVariants[strategyVariantId] ?? null;
    if (!variant) {
      return null;
    }

    const matching = Object.values(variant.regimeSnapshots)
      .filter((snapshot) => snapshot.regime === regime)
      .sort((left, right) => right.sampleCount - left.sampleCount);
    return matching[0] ?? null;
  }

  private resolveExecutionLearningContext(
    learningState: Awaited<ReturnType<LearningStateStore['load']>>,
    strategyVariantId: string | null,
    regime: string | null,
  ) {
    if (!strategyVariantId) {
      return null;
    }

    const variant = learningState.strategyVariants[strategyVariantId] ?? null;
    if (!variant) {
      return null;
    }

    const matching = Object.values(variant.executionLearning.contexts)
      .filter((context) => context.regime === regime)
      .sort((left, right) => right.sampleCount - left.sampleCount);
    return matching[0] ?? null;
  }

  private classifyOpportunityClass(
    finalNetEdge: number,
    minimumNetEdge: number,
  ): OpportunityClass {
    const margin = finalNetEdge - minimumNetEdge;
    if (margin >= Math.max(0.004, minimumNetEdge)) {
      return 'strong_edge';
    }
    if (margin >= 0.0015) {
      return 'tradable_edge';
    }
    if (margin >= 0) {
      return 'marginal_edge';
    }
    return 'weak_edge';
  }

  private filterRecentTradeQualityScores(
    scores: TradeQualityScore[],
    strategyVariantId: string | null,
    regime: string | null,
  ): TradeQualityScore[] {
    return scores.filter(
      (score) =>
        (strategyVariantId == null || score.strategyVariantId === strategyVariantId) &&
        (regime == null || score.regime === regime),
    );
  }

  private selectRecentExecutionCostObservations(
    diagnostics: unknown[],
    strategyVersionId: string | null,
    regime: string | null,
  ) {
    return (diagnostics ?? [])
      .filter(
        (diagnostic) =>
          (strategyVersionId == null ||
            this.readStringField(diagnostic, 'strategyVersionId') === strategyVersionId) &&
          (regime == null || this.readStringField(diagnostic, 'regime') === regime),
      )
      .slice(0, 20)
      .map((diagnostic) => ({
        expectedFee: this.readNumberField(diagnostic, 'expectedFee'),
        realizedFee: this.readNumberField(diagnostic, 'realizedFee'),
        expectedSlippage: this.readNumberField(diagnostic, 'expectedSlippage'),
        realizedSlippage: this.readNumberField(diagnostic, 'realizedSlippage'),
        edgeAtSignal: this.readNumberField(diagnostic, 'edgeAtSignal'),
        edgeAtFill: this.readNumberField(diagnostic, 'edgeAtFill'),
        fillRate: this.readNumberField(diagnostic, 'fillRate'),
        staleOrder: this.readBooleanField(diagnostic, 'staleOrder') ?? false,
        capturedAt:
          this.readDateRecordField(diagnostic, 'capturedAt')?.toISOString() ??
          new Date(0).toISOString(),
      }));
  }

  private calculateCancelFailureRate(auditEvents: unknown[]): number {
    const requested = this.countAuditEvents(auditEvents, 'order.cancel_requested');
    const failed = this.countAuditEvents(auditEvents, 'order.cancel_failed');
    if (requested <= 0) {
      return 0;
    }
    return Math.min(1, failed / requested);
  }

  private additionalExecutionCost(
    netEdgeBreakdown: NetEdgeDecision['breakdown'],
    executionCostAssessment: ReturnType<RealizedCostModel['evaluate']>,
  ): number {
    return Math.max(
      0,
      Math.max(0, executionCostAssessment.breakdown.feeCost - netEdgeBreakdown.costEstimate.feeCost) +
        Math.max(
          0,
          executionCostAssessment.breakdown.slippageCost -
            netEdgeBreakdown.costEstimate.slippageCost,
        ) +
        Math.max(
          0,
          executionCostAssessment.breakdown.adverseSelectionCost -
            netEdgeBreakdown.costEstimate.adverseSelectionCost,
        ) +
        executionCostAssessment.breakdown.fillDecayCost +
        executionCostAssessment.breakdown.cancelReplaceOverheadCost +
        executionCostAssessment.breakdown.missedOpportunityCost,
    );
  }

  private readLatestCapitalLeakReport(auditEvents: unknown[]): CapitalLeakReport | null {
    const candidate = [...(auditEvents ?? [])]
      .filter((event) => this.readStringField(event, 'eventType') === 'capital.leak_review')
      .sort((left, right) => {
        const leftTime =
          this.readDateRecordField(left, 'createdAt')?.getTime() ?? Number.NEGATIVE_INFINITY;
        const rightTime =
          this.readDateRecordField(right, 'createdAt')?.getTime() ?? Number.NEGATIVE_INFINITY;
        return rightTime - leftTime;
      })[0];

    const metadata = this.readMetadata(candidate);
    if (!metadata || typeof metadata.report !== 'object' || metadata.report == null) {
      return null;
    }

    return metadata.report as CapitalLeakReport;
  }

  private findRegimeLeakGroup(
    report: CapitalLeakReport | null,
    regime: string | null,
  ): CapitalLeakReport['byRegime'][number] | null {
    if (!report || !Array.isArray(report.byRegime)) {
      return null;
    }

    return (
      report.byRegime.find((group) => group.groupKey === (regime ?? 'unknown_regime')) ?? null
    );
  }

  private readRecentAdmissionEvents(
    auditEvents: unknown[],
    signalDecisions: unknown[],
  ): RecentAdmissionEvent[] {
    const verdictBySignalId = new Map<string, 'approved' | 'rejected' | 'unknown'>();
    for (const decision of signalDecisions ?? []) {
      const signalId = this.readStringField(decision, 'signalId');
      const verdict = this.readStringField(decision, 'verdict');
      if (!signalId) {
        continue;
      }
      verdictBySignalId.set(
        signalId,
        verdict === 'approved' || verdict === 'rejected' ? verdict : 'unknown',
      );
    }

    return (auditEvents ?? [])
      .filter((event) => this.readStringField(event, 'eventType') === 'signal.execution_decision')
      .map((event) => {
        const metadata = this.readMetadata(event);
        const signalId = this.readStringField(event, 'signalId');
        const threshold = this.readNestedNumber(
          metadata,
          'netEdgeThreshold',
          'minimumNetEdge',
        );
        const finalNetEdge = this.readNestedNumber(
          metadata,
          'netEdgeDecision',
          'breakdown',
          'finalNetEdge',
        );
        const opportunityClass = this.readNestedString(
          metadata,
          'opportunityClass',
        );
        return {
          createdAt:
            this.readDateRecordField(event, 'createdAt')?.toISOString() ??
            new Date(0).toISOString(),
          verdict:
            signalId != null
              ? (verdictBySignalId.get(signalId) ?? this.inferAuditVerdict(event, metadata))
              : this.inferAuditVerdict(event, metadata),
          marginAboveThreshold:
            finalNetEdge != null && threshold != null ? finalNetEdge - threshold : null,
          opportunityClass:
            opportunityClass === 'strong_edge' ||
            opportunityClass === 'tradable_edge' ||
            opportunityClass === 'marginal_edge' ||
            opportunityClass === 'weak_edge'
              ? opportunityClass
              : this.classifyOpportunityClass(finalNetEdge ?? 0, threshold ?? 0),
          reasons: this.readReasonArray(metadata),
        };
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private summarizeMarginalActivity(events: RecentAdmissionEvent[]) {
    const approved = events.filter((event) => event.verdict === 'approved');
    const strongApprovalCount = approved.filter(
      (event) => event.opportunityClass === 'strong_edge',
    ).length;
    const marginalApprovalCount = approved.filter(
      (event) =>
        event.opportunityClass === 'marginal_edge' ||
        event.opportunityClass === 'tradable_edge',
    ).length;
    const weakRejectCount = events.filter(
      (event) =>
        event.verdict === 'rejected' &&
        (event.reasons.includes('weak_net_edge') ||
          event.reasons.includes('low_margin_opportunity') ||
          event.reasons.includes('trade_frequency_governor_blocked')),
    ).length;
    const averageMarginAboveThreshold = this.average(
      approved.map((event) => event.marginAboveThreshold).filter(this.isNumber),
    );

    return {
      approvedCount: approved.length,
      strongApprovalCount,
      marginalApprovalCount,
      weakRejectCount,
      averageMarginAboveThreshold,
    };
  }

  private readDivergenceStatus(
    checkpoint: {
      details?: {
        snapshot?: {
          divergence?: {
            status?: string | null;
          };
        };
      } | null;
    } | null,
  ): 'none' | 'warning' | 'critical' {
    const status = checkpoint?.details?.snapshot?.divergence?.status ?? null;
    if (status === 'critical' || status === 'manual_review') {
      return 'critical';
    }
    if (status === 'warning' || status === 'recoverable') {
      return 'warning';
    }
    return 'none';
  }

  private buildCandidateExposure(input: {
    marketId: string;
    outcome: Outcome;
    expiryAt: Date | string;
    signal: unknown;
    notional: number;
  }): PositionLimitExposure {
    return {
      marketId: input.marketId,
      outcome: input.outcome,
      resolutionBucket: this.resolutionBucket(input.expiryAt),
      thesisKey: this.thesisKey(input.signal, input.outcome),
      notional: Math.max(0, input.notional),
    };
  }

  private buildOpenPositionExposure(
    position: unknown,
    marketById: Map<string, { expiresAt: Date | null }>,
  ): PositionLimitExposure {
    const marketId = this.readStringField(position, 'marketId') ?? 'unknown_market';
    const market = marketById.get(marketId) ?? null;
    const quantity = Math.abs(this.readNumberField(position, 'quantity') ?? 0);
    const entryPrice = Math.abs(this.readNumberField(position, 'entryPrice') ?? 0);
    const outcome = this.readOutcome(position) ?? 'UNKNOWN';

    return {
      marketId,
      outcome,
      resolutionBucket: this.resolutionBucket(market?.expiresAt ?? null),
      thesisKey: this.thesisKey(position, outcome),
      notional: quantity * entryPrice,
    };
  }

  private buildWorkingOrderExposure(
    order: {
      marketId: string;
      outcome?: Outcome | null;
      price: number;
      size: number;
      remainingSize: number | null;
      createdAt?: Date;
      [key: string]: unknown;
    },
    marketById: Map<string, { expiresAt: Date | null }>,
  ): PositionLimitExposure {
    const market = marketById.get(order.marketId) ?? null;
    const remainingSize = Math.max(
      0,
      order.remainingSize != null ? order.remainingSize : order.size,
    );
    const outcome = order.outcome ?? this.readOutcome(order) ?? 'UNKNOWN';

    return {
      marketId: order.marketId,
      outcome,
      resolutionBucket: this.resolutionBucket(market?.expiresAt ?? null),
      thesisKey: this.thesisKey(order, outcome),
      notional: Math.max(0, order.price * remainingSize),
    };
  }

  private thesisKey(source: unknown, fallbackOutcome: Outcome | 'UNKNOWN'): string {
    const side = this.readStringField(source, 'side');
    const signalSide = this.readStringField(source, 'signalSide');
    const outcome = this.readOutcome(source) ?? fallbackOutcome;
    const thesisSide = signalSide ?? side ?? outcome;
    return `btc_5m:${thesisSide}:${outcome}`;
  }

  private resolutionBucket(value: Date | string | null | undefined): string {
    if (!value) {
      return 'unknown_resolution_bucket';
    }

    const timestamp = new Date(value);
    if (Number.isNaN(timestamp.getTime())) {
      return 'unknown_resolution_bucket';
    }

    timestamp.setSeconds(0, 0);
    const bucketMinute = Math.floor(timestamp.getUTCMinutes() / 5) * 5;
    timestamp.setUTCMinutes(bucketMinute);
    return timestamp.toISOString();
  }

  private readOutcome(source: unknown): Outcome | null {
    const outcome = this.readStringField(source, 'outcome');
    return outcome === 'YES' || outcome === 'NO' ? outcome : null;
  }

  private resolveEvaluationIntent(
    signal: unknown,
    market: unknown,
  ): ResolvedEvaluationIntent | null {
    const resolution = this.tradeIntentResolver.resolve({
      market: {
        id: this.readStringField(market, 'id') ?? '',
        tokenIdYes: this.readStringField(market, 'tokenIdYes'),
        tokenIdNo: this.readStringField(market, 'tokenIdNo'),
      },
      signal: {
        marketId: this.readStringField(signal, 'marketId'),
        side: this.readStringField(signal, 'side'),
        venueSide: this.readStringField(signal, 'venueSide'),
        tokenId: this.readStringField(signal, 'tokenId'),
        outcome: this.readStringField(signal, 'outcome'),
        targetOutcome: this.readStringField(signal, 'targetOutcome'),
        action: this.readStringField(signal, 'action'),
        intent: this.readStringField(signal, 'intent'),
      },
    });

    if (!resolution.ok) {
      return null;
    }

    const venueSide: VenueSide = resolution.resolved.venueSide;

    return {
      tokenId: resolution.resolved.tokenId,
      outcome: resolution.resolved.outcome,
      action: resolution.resolved.intent as EvaluationAction,
      venueSide,
      inventoryEffect:
        resolution.resolved.inventoryEffect === 'INCREASE' ? 'increase' : 'decrease',
    };
  }

  private readStringField(source: unknown, key: string): string | null {
    if (!source || typeof source !== 'object') {
      return null;
    }

    const value = (source as Record<string, unknown>)[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  private readNumberField(source: unknown, key: string): number | null {
    if (!source || typeof source !== 'object') {
      return null;
    }

    const value = (source as Record<string, unknown>)[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private readBooleanField(source: unknown, key: string): boolean | null {
    if (!source || typeof source !== 'object') {
      return null;
    }

    const value = (source as Record<string, unknown>)[key];
    return typeof value === 'boolean' ? value : null;
  }

  private readMetadata(source: unknown): Record<string, unknown> | null {
    if (!source || typeof source !== 'object') {
      return null;
    }

    const value = (source as Record<string, unknown>).metadata;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  }

  private readNestedNumber(
    source: Record<string, unknown> | null,
    ...path: string[]
  ): number | null {
    let current: unknown = source;
    for (const segment of path) {
      if (!current || typeof current !== 'object') {
        return null;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return typeof current === 'number' && Number.isFinite(current) ? current : null;
  }

  private readNestedString(
    source: Record<string, unknown> | null,
    ...path: string[]
  ): string | null {
    let current: unknown = source;
    for (const segment of path) {
      if (!current || typeof current !== 'object') {
        return null;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return typeof current === 'string' && current.length > 0 ? current : null;
  }

  private readReasonArray(source: Record<string, unknown> | null): string[] {
    const reasons = source?.reasons;
    if (!Array.isArray(reasons)) {
      return [];
    }

    return reasons.filter((value): value is string => typeof value === 'string');
  }

  private inferAuditVerdict(
    event: unknown,
    metadata: Record<string, unknown> | null,
  ): 'approved' | 'rejected' | 'unknown' {
    const summary = this.readStringField(event, 'message')?.toLowerCase() ?? '';
    if (summary.includes('approved')) {
      return 'approved';
    }
    if (summary.includes('rejected')) {
      return 'rejected';
    }
    return this.readReasonArray(metadata).length > 0 ? 'rejected' : 'unknown';
  }

  private readDateRecordField(source: unknown, key: string): Date | null {
    if (!source || typeof source !== 'object') {
      return null;
    }
    const value = (source as Record<string, unknown>)[key];
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    if (typeof value === 'string' || typeof value === 'number') {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    return null;
  }

  private readNumberRecordField(
    source: Record<string, unknown> | null | undefined,
    key: string,
  ): number | null {
    if (!source) {
      return null;
    }
    const value = source[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private average(values: number[]): number | null {
    if (values.length === 0) {
      return null;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  private isNumber(value: number | null): value is number {
    return typeof value === 'number' && Number.isFinite(value);
  }

  private topLevelDepth(
    orderbook: {
      bidLevels: unknown;
      askLevels: unknown;
    },
    side: VenueSide,
  ): number {
    const levels = side === 'BUY' ? orderbook.askLevels : orderbook.bidLevels;
    if (!Array.isArray(levels) || levels.length === 0) {
      return 0;
    }

    const top = levels[0];
    if (Array.isArray(top) && top.length >= 2) {
      const size = Number(top[1]);
      return Number.isFinite(size) && size > 0 ? size : 0;
    }
    if (typeof top === 'object' && top !== null) {
      const record = top as Record<string, unknown>;
      const size = Number(record.size ?? record.s ?? Number.NaN);
      return Number.isFinite(size) && size > 0 ? size : 0;
    }
    return 0;
  }

  private boundProbability(value: number): number {
    if (!Number.isFinite(value)) {
      return 0.5;
    }
    return Math.min(0.99, Math.max(0.01, value));
  }

  private evaluatePortfolioState(input: {
    latestPortfolio:
      | {
          bankroll: number;
          availableCapital: number;
          realizedPnlDay: number;
          consecutiveLosses: number;
          capturedAt: Date;
        }
      | null;
    maxSnapshotAgeMs: number;
  }): {
    passed: boolean;
    reasonCode: string | null;
  } {
    if (!input.latestPortfolio) {
      return {
        passed: false,
        reasonCode: 'portfolio_snapshot_missing',
      };
    }

    const snapshotAgeMs = Date.now() - input.latestPortfolio.capturedAt.getTime();
    if (snapshotAgeMs > input.maxSnapshotAgeMs) {
      return {
        passed: false,
        reasonCode: 'portfolio_snapshot_stale',
      };
    }

    if (
      !Number.isFinite(input.latestPortfolio.bankroll) ||
      !Number.isFinite(input.latestPortfolio.availableCapital)
    ) {
      return {
        passed: false,
        reasonCode: 'portfolio_snapshot_invalid',
      };
    }

    return {
      passed: true,
      reasonCode: null,
    };
  }

  private maxPortfolioSnapshotAgeMs(config: RuntimeLiveConfig): number {
    return Math.max(config.portfolioRefreshIntervalMs * 2, 15_000);
  }

  private evaluateOperationalTruth(input: {
    runtimeState: string | null;
    latestOpenOrdersCheckpoint:
      | {
          status?: string | null;
          processedAt?: Date | null;
        }
      | null;
    latestFillCheckpoint:
      | {
          status?: string | null;
          processedAt?: Date | null;
        }
      | null;
    latestExternalPortfolioCheckpoint:
      | {
          status?: string | null;
          processedAt?: Date | null;
          details?: {
            snapshot?: {
              tradingPermissions?: {
                allowNewEntries?: boolean;
              };
            };
          } | null;
        }
      | null;
    maxAgeMs: number;
  }): {
    venueHealthy: boolean;
    reconciliationHealthy: boolean;
  } {
    const runtimeHealthy =
      input.runtimeState === null ||
      input.runtimeState === 'running' ||
      input.runtimeState === 'starting';

    const checkpointFresh = (
      checkpoint:
        | {
            status?: string | null;
            processedAt?: Date | null;
          }
        | null,
    ): boolean =>
      !!checkpoint?.processedAt &&
      checkpoint.status !== 'failed' &&
      Date.now() - checkpoint.processedAt.getTime() <= input.maxAgeMs;

    const venueHealthy = runtimeHealthy && checkpointFresh(input.latestOpenOrdersCheckpoint);
    const reconciliationHealthy =
      checkpointFresh(input.latestFillCheckpoint) &&
      checkpointFresh(input.latestExternalPortfolioCheckpoint) &&
      input.latestExternalPortfolioCheckpoint?.details?.snapshot?.tradingPermissions
        ?.allowNewEntries !== false;

    return {
      venueHealthy,
      reconciliationHealthy,
    };
  }
}

function createDefaultVenueHealthLearningStore(
  learningStateStore?: LearningStateStore,
): VenueHealthLearningStore {
  if (learningStateStore) {
    return new VenueHealthLearningStore(
      path.join(learningStateStore.getPaths().rootDir, '..', 'venue-health'),
    );
  }

  if (process.env.DATABASE_URL === 'postgresql://test') {
    return new VenueHealthLearningStore(
      path.join(os.tmpdir(), `venue-health-${randomUUID()}`),
    );
  }

  return new VenueHealthLearningStore();
}
