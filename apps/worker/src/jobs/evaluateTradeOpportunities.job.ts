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
import { TradeIntentResolver } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import {
  buildCalibrationContextKey,
  ConfidenceShrinkagePolicy,
  ExecutableEdgeEstimate,
  LiveCalibrationStore,
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
import { DecisionLogService } from '@worker/runtime/decision-log.service';
import { LearningStateStore } from '@worker/runtime/learning-state-store';
import type { CalibrationState } from '@polymarket-btc-5m-agentic-bot/domain';

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
  private readonly edgeHalfLifePolicy = new EdgeHalfLifePolicy();
  private readonly microstructureModel = new EventMicrostructureModel();
  private readonly featureBuilder = new FeatureBuilder();
  private readonly deploymentTierPolicy = new DeploymentTierPolicyService();
  private readonly capitalRampPolicy = new CapitalRampPolicyService();
  private readonly accountStateService: AccountStateService;
  private readonly marketEligibility = new MarketEligibilityService();
  private readonly decisionLogService: DecisionLogService;
  private readonly learningStateStore = new LearningStateStore();
  private readonly liveCalibrationStore = new LiveCalibrationStore({
    loadState: () => this.learningStateStore.load(),
    saveState: (state) => this.learningStateStore.save(state),
  });
  private readonly confidenceShrinkagePolicy = new ConfidenceShrinkagePolicy();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly runtimeControl?: RuntimeControlRepository,
  ) {
    this.accountStateService = new AccountStateService(prisma);
    this.decisionLogService = new DecisionLogService(prisma);
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
    const calibrationByContext = await this.liveCalibrationStore.getAll();

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
          reasons.push('orderbook_stale');
        }
      }

      if (!snapshot) {
        reasons.push('market_snapshot_missing');
      } else {
        const snapshotAgeMs = now.getTime() - new Date(snapshot.observedAt).getTime();
        if (snapshotAgeMs > appEnv.BOT_MAX_MARKET_SNAPSHOT_AGE_MS) {
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
      const calibration =
        signal.strategyVersionId != null
          ? this.resolveCalibrationForSignal(
              calibrationByContext,
              signal.strategyVersionId,
              signal.regime,
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
      const positionSize = Math.max(
        0,
        contraction.adjustedSize *
          (isNewExposure
            ? nextSafetyState.sizeMultiplier *
              shrinkage.sizeMultiplier *
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
      if (positionSize <= 0) {
        reasons.push('position_size_zero');
      }

      if (resolvedIntent && orderbook && venueSide) {
        const topLevelDepth = this.topLevelDepth(orderbook, venueSide);
        if (topLevelDepth <= 0) {
          reasons.push('top_level_liquidity_missing');
        }

        const referencePrice =
          venueSide === 'BUY' ? (orderbook.bestAsk ?? 0) : (orderbook.bestBid ?? 0);

        if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
          reasons.push('reference_price_missing');
        } else {
          const estimatedSizeUnits = positionSize / referencePrice;
          if (!Number.isFinite(estimatedSizeUnits) || estimatedSizeUnits <= 0) {
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
              notional: positionSize,
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

      const liquidityHealthy =
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

      const regimeAllowed =
        signal.regime !== 'illiquid_noisy_book' &&
        signal.regime !== 'near_resolution_microstructure_chaos';
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
      const noTradeZone = this.noTradeZonePolicy.evaluate({
        timeToExpirySeconds: evaluationMicrostructure.timeToExpirySeconds,
        noTradeWindowSeconds: config.noTradeWindowSeconds,
        btcFresh: true,
        orderbookFresh: !reasons.includes('orderbook_stale'),
        spread: orderbook?.spread ?? Number.POSITIVE_INFINITY,
        topLevelDepth: orderbook ? this.topLevelDepth(orderbook, venueSide ?? 'BUY') : 0,
        microstructure: evaluationMicrostructure.microstructure,
        governanceHealthy: researchGovernanceHealthy,
        edgeHalfLifeHealthy: !halfLife.expired,
      });
      const executableEdge = this.buildExecutableEdgeEstimate({
        rawEdge: Math.abs(signal.edge ?? 0),
        expectedEv: signal.expectedEv,
        spread: orderbook?.spread ?? null,
        signalAgeMs,
        halfLifeMultiplier: halfLife.decayMultiplier,
        freshnessHealthy,
        availableCapital: remainingCapital,
      });
      const calibratedExecutableEdge: ExecutableEdgeEstimate = {
        ...executableEdge,
        threshold: executableEdge.threshold * shrinkage.thresholdMultiplier,
      };

      const admission = this.tradeAdmissionGate.evaluate({
        edgeDefinitionVersion: this.edgeDefinitionService.getDefinition().version,
        signalPresent: reasons.length === 0 || !reasons.includes('market_missing'),
        directionalEdge: Math.abs(halfLife.effectiveEdge ?? signal.edge ?? 0),
        executableEv: calibratedExecutableEdge.finalNetEdge,
        signalConfidence: this.boundProbability(Math.abs(signal.posteriorProbability - 0.5) * 2),
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
        paperEdgeDetected:
          (calibratedExecutableEdge.rawModelEdge ?? 0) > calibratedExecutableEdge.threshold &&
          (calibratedExecutableEdge.finalNetEdge ?? 0) <= calibratedExecutableEdge.threshold,
        admissionThreshold: calibratedExecutableEdge.threshold,
        executableEdge: calibratedExecutableEdge,
        minimumConfidence:
          this.edgeDefinitionService.getDefinition().admissionThresholdPolicy.minimumConfidence,
      });

      if (reasons.length === 0 && !admission.admitted) {
        reasons.push(admission.reasonCode);
      }

      if (reasons.length > 0) {
        await this.prisma.signalDecision.create({
          data: {
            id: randomUUID(),
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
            noTradeZone,
            halfLife,
            auditCoverage,
            calibration,
            shrinkage,
          },
          createdAt: now.toISOString(),
        });
        rejected += 1;
        continue;
      }

      await this.prisma.signalDecision.create({
        data: {
          id: randomUUID(),
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
          noTradeZone,
          halfLife,
          positionSize,
          calibration,
          shrinkage,
        },
        createdAt: now.toISOString(),
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

  private buildExecutableEdgeEstimate(input: {
    rawEdge: number;
    expectedEv: number;
    spread: number | null;
    signalAgeMs: number;
    halfLifeMultiplier: number;
    freshnessHealthy: boolean;
    availableCapital: number;
  }): ExecutableEdgeEstimate {
    const threshold = this.edgeDefinitionService.getDefinition().admissionThresholdPolicy.minimumNetEdge;
    const spreadAdjustedEdge = input.rawEdge - Math.max(0, input.spread ?? 0);
    const slippageAdjustedEdge = spreadAdjustedEdge - Math.max(0, (input.spread ?? 0) * 0.5);
    const feeAdjustedEdge = slippageAdjustedEdge - DEFAULT_FEE_RATE;
    const timeoutAdjustedEdge = feeAdjustedEdge - Math.min(0.01, input.signalAgeMs / 100_000);
    const staleSignalAdjustedEdge = timeoutAdjustedEdge * input.halfLifeMultiplier;
    const inventoryAdjustedEdge =
      staleSignalAdjustedEdge -
      (input.availableCapital <= 0 ? threshold : 0);

    return {
      edgeDefinitionVersion: this.edgeDefinitionService.getDefinition().version,
      executionStyle: 'hybrid',
      rawModelEdge: input.rawEdge,
      spreadAdjustedEdge,
      slippageAdjustedEdge,
      feeAdjustedEdge,
      timeoutAdjustedEdge,
      staleSignalAdjustedEdge,
      inventoryAdjustedEdge,
      finalNetEdge: inventoryAdjustedEdge,
      threshold,
      missingInputs: Number.isFinite(input.expectedEv) ? [] : ['expected_ev'],
      staleInputs: input.freshnessHealthy ? [] : ['stale_market_inputs'],
      paperEdgeBlocked: input.rawEdge > threshold && inventoryAdjustedEdge <= threshold,
      confidence: input.expectedEv > threshold ? 0.7 : 0.3,
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
