import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { AppLogger } from '@worker/common/logger';
import { BotRuntimeState } from '@worker/runtime/bot-state';
import { appEnv } from '@worker/config/env';
import {
  AdaptiveMakerTakerPolicy,
  EntryTimingEfficiencyScorer,
  ExecutionCostCalibrator,
  ExecutionPolicyVersionStore,
  RealizedCostModel,
  SizeVsLiquidityPolicy,
  OrderIntentService,
} from '@polymarket-btc-5m-agentic-bot/execution-engine';
import {
  buildStrategyVariantId,
  type TradingOperatingMode,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { SignerHealth } from '@polymarket-btc-5m-agentic-bot/signing-engine';
import {
  LiveTradeGuard,
  LiveSizingFeedbackPolicy,
  MaxLossPerOpportunityPolicy,
} from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { PreTradeFundingValidator } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { MarketableLimit } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { DuplicateExposureGuard } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { MakerQualityPolicy } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { NegativeRiskPolicy } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { OrderPlanner } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { SlippageEstimator } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { TradeIntentResolver } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { VenueFeeModel } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { VenueOrderValidator } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import { ExecutionDiagnostics } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import {
  OfficialPolymarketTradingClient,
  VenueRewardMarket,
} from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';
import {
  PolymarketVenueError,
  PolymarketNormalizedVenueError,
} from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';
import { RuntimeControlRepository } from '@worker/runtime/runtime-control.repository';
import { DecisionLogService } from '@worker/runtime/decision-log.service';
import { LearningStateStore } from '@worker/runtime/learning-state-store';
import { SentinelStateStore } from '@worker/runtime/sentinel-state-store';
import { SentinelTradeSimulator } from '@worker/runtime/sentinel-trade-simulator';
import { SentinelLearningService } from '@worker/runtime/sentinel-learning-service';
import { SentinelReadinessService } from '@worker/runtime/sentinel-readiness-service';
import { AccountStateService } from '@worker/portfolio/account-state.service';
import {
  OrderIntentRepository,
  PersistedOrderIntentRecord,
} from '@worker/runtime/order-intent.repository';
import {
  ExternalPortfolioService,
  ExternalPortfolioSnapshot,
} from '@worker/portfolio/external-portfolio.service';
import { permissionsForRuntimeState } from '@worker/runtime/runtime-state-machine';
import {
  MarketEligibilityService,
  LossAttributionClassifier,
  ToxicityPolicy,
  type ToxicityTrendPoint,
  createAlphaAttribution,
} from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { VenueOperationalPolicyService } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import {
  VenueHealthLearningStore,
  VenueModePolicy,
  VenueUncertaintyDetector,
} from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';
import {
  VersionLineageRegistry,
  buildLossAttributionTags,
  buildCalibrationVersionLineage,
  buildExecutionPolicyVersionLineage,
  buildFeatureSetVersionLineage,
  buildRiskPolicyVersionLineage,
  buildStrategyVersionLineage,
} from '@worker/runtime/version-lineage-registry';

type Outcome = 'YES' | 'NO';
type VenueSide = 'BUY' | 'SELL';
type ExecutionAction = 'ENTER' | 'REDUCE' | 'EXIT';
type ExecutionStyle = 'rest' | 'cross';
type InventoryEffect = 'increase' | 'decrease';

interface ResolvedExecutionIntent {
  tokenId: string;
  outcome: Outcome;
  venueSide: VenueSide;
  action: ExecutionAction;
  inventoryEffect: InventoryEffect;
}

export class ExecuteOrdersJob {
  private readonly logger = new AppLogger('ExecuteOrdersJob');
  private readonly signerHealth = new SignerHealth();
  private readonly liveTradeGuard = new LiveTradeGuard();
  private readonly fundingValidator = new PreTradeFundingValidator();
  private readonly marketableLimit = new MarketableLimit();
  private readonly duplicateExposureGuard = new DuplicateExposureGuard();
  private readonly makerQualityPolicy = new MakerQualityPolicy();
  private readonly negativeRiskPolicy = new NegativeRiskPolicy();
  private readonly orderPlanner = new OrderPlanner();
  private readonly slippageEstimator = new SlippageEstimator();
  private readonly tradeIntentResolver = new TradeIntentResolver();
  private readonly venueFeeModel = new VenueFeeModel();
  private readonly venueOrderValidator = new VenueOrderValidator();
  private readonly executionDiagnostics = new ExecutionDiagnostics();
  private readonly marketEligibility = new MarketEligibilityService();
  private readonly toxicityPolicy = new ToxicityPolicy();
  private readonly orderIntentService = new OrderIntentService();
  private readonly operationalPolicy = new VenueOperationalPolicyService();
  private readonly adaptiveMakerTakerPolicy = new AdaptiveMakerTakerPolicy();
  private readonly executionCostCalibrator = new ExecutionCostCalibrator();
  private readonly realizedCostModel = new RealizedCostModel();
  private readonly sizeVsLiquidityPolicy = new SizeVsLiquidityPolicy();
  private readonly entryTimingEfficiencyScorer = new EntryTimingEfficiencyScorer();
  private readonly maxLossPerOpportunityPolicy = new MaxLossPerOpportunityPolicy();
  private readonly liveSizingFeedbackPolicy = new LiveSizingFeedbackPolicy();
  private readonly lossAttributionClassifier = new LossAttributionClassifier();
  private readonly versionLineageRegistry: VersionLineageRegistry;
  private readonly venueHealthLearningStore: VenueHealthLearningStore;
  private readonly venueUncertaintyDetector = new VenueUncertaintyDetector();
  private readonly venueModePolicy = new VenueModePolicy();
  private readonly tradingClient = new OfficialPolymarketTradingClient({
    host: appEnv.POLY_CLOB_HOST,
    chainId: appEnv.POLY_CHAIN_ID,
    privateKey: appEnv.POLY_PRIVATE_KEY ?? '',
    apiKey: appEnv.POLY_API_KEY ?? '',
    apiSecret: appEnv.POLY_API_SECRET ?? '',
    apiPassphrase: appEnv.POLY_API_PASSPHRASE ?? '',
    signatureType: appEnv.POLY_SIGNATURE_TYPE,
    funder: appEnv.POLY_FUNDER ?? null,
    geoBlockToken: appEnv.POLY_GEO_BLOCK_TOKEN ?? null,
    useServerTime: appEnv.POLY_USE_SERVER_TIME,
    maxClockSkewMs: appEnv.POLY_MAX_CLOCK_SKEW_MS,
  });
  private readonly runtimeControl: RuntimeControlRepository;
  private readonly learningStateStore: LearningStateStore | null;
  private readonly executionPolicyVersionStore: ExecutionPolicyVersionStore | null;
  private readonly externalPortfolioService: ExternalPortfolioService;
  private readonly accountStateService: Pick<AccountStateService, 'capture'>;
  private readonly decisionLogService: DecisionLogService;
  private readonly sentinelStateStore: SentinelStateStore;
  private readonly sentinelTradeSimulator: SentinelTradeSimulator;
  private readonly sentinelLearningService: SentinelLearningService;
  private readonly sentinelReadinessService: SentinelReadinessService;
  private readonly orderIntentRepository: Pick<
    OrderIntentRepository,
    'record' | 'loadLatest'
  >;

  constructor(
    private readonly prisma: PrismaClient,
    runtimeControl?: RuntimeControlRepository,
    learningStateStore?: LearningStateStore,
    versionLineageRegistry?: VersionLineageRegistry,
    venueHealthLearningStore?: VenueHealthLearningStore,
    sentinelStateStore?: SentinelStateStore,
  ) {
    this.runtimeControl =
      runtimeControl ??
      new RuntimeControlRepository(this.prisma, {
        maxOpenPositions: appEnv.MAX_OPEN_POSITIONS,
        maxDailyLossPct: appEnv.MAX_DAILY_LOSS_PCT,
        maxPerTradeRiskPct: appEnv.MAX_PER_TRADE_RISK_PCT,
        maxKellyFraction: appEnv.MAX_KELLY_FRACTION,
        maxConsecutiveLosses: appEnv.MAX_CONSECUTIVE_LOSSES,
        noTradeWindowSeconds: appEnv.NO_TRADE_WINDOW_SECONDS,
        evaluationIntervalMs: appEnv.BOT_EVALUATION_INTERVAL_MS,
        orderReconcileIntervalMs: appEnv.BOT_ORDER_RECONCILE_INTERVAL_MS,
        portfolioRefreshIntervalMs: appEnv.BOT_PORTFOLIO_REFRESH_INTERVAL_MS,
      });
    this.learningStateStore = learningStateStore ?? null;
    this.executionPolicyVersionStore = this.learningStateStore
      ? new ExecutionPolicyVersionStore({
          loadState: () => this.learningStateStore!.load(),
          saveState: (state) => this.learningStateStore!.save(state),
        })
      : null;
    this.versionLineageRegistry =
      versionLineageRegistry ?? new VersionLineageRegistry();
    this.venueHealthLearningStore =
      venueHealthLearningStore ?? createDefaultVenueHealthLearningStore(this.learningStateStore);
    this.decisionLogService = new DecisionLogService(this.prisma);
    this.sentinelStateStore = sentinelStateStore ?? new SentinelStateStore();
    this.sentinelTradeSimulator = new SentinelTradeSimulator();
    this.sentinelLearningService = new SentinelLearningService(this.sentinelStateStore);
    this.sentinelReadinessService = new SentinelReadinessService(this.sentinelStateStore);
    this.externalPortfolioService = new ExternalPortfolioService(
      this.prisma,
      this.tradingClient,
    );
    this.accountStateService = new AccountStateService(
      this.prisma,
      this.externalPortfolioService,
    );
    this.orderIntentRepository = new OrderIntentRepository(this.prisma);
  }

  async run(options?: {
    canSubmit?: () => boolean;
    runtimeState?: BotRuntimeState;
    operatingMode?: TradingOperatingMode;
  }): Promise<{ submitted: number; rejected: number }> {
    const canSubmit = options?.canSubmit ?? (() => true);
    const operatingMode = options?.operatingMode ?? 'live_trading';
    if (
      options?.runtimeState &&
      !permissionsForRuntimeState(options.runtimeState).allowOrderSubmit
    ) {
      return { submitted: 0, rejected: 0 };
    }

    const liveConfig = await (this.prisma as any).liveConfig.findUnique({
      where: { id: 'live' },
    });

    if (!canSubmit()) {
      return { submitted: 0, rejected: 0 };
    }

    const executionReadiness = await this.assessExecutionReadiness();
    if (!executionReadiness.ready) {
      await this.prisma.auditEvent.create({
        data: {
          eventType: 'execution.runtime_freshness_veto',
          message:
            'Execution blocked because runtime heartbeat, reconciliation, or portfolio truth is stale.',
          metadata: {
            reasonCode: executionReadiness.reasonCode,
          } as object,
        },
      });
      this.logger.warn('Execution cycle blocked by stale runtime truth.', {
        reasonCode: executionReadiness.reasonCode,
      });
      return { submitted: 0, rejected: 0 };
    }

    const activeSafetyState = await this.runtimeControl.getLatestSafetyState();
    const venueMetrics = await this.venueHealthLearningStore.getCurrentMetrics();
    const venueAssessment = this.venueUncertaintyDetector.evaluate(venueMetrics);
    const venueMode = this.venueModePolicy.decide(venueAssessment);
    await this.venueHealthLearningStore.setOperationalAssessment({
      activeMode: venueMode.mode,
      uncertaintyLabel: venueAssessment.label,
    });
    if (activeSafetyState.haltRequested) {
      await this.prisma.auditEvent.create({
        data: {
          eventType: 'execution.safety_halt_veto',
          message: 'Execution blocked because the graded safety state machine is halted.',
          metadata: {
            safetyState: activeSafetyState.state,
            reasonCodes: activeSafetyState.reasonCodes,
          } as object,
        },
      });
      return { submitted: 0, rejected: 0 };
    }

    const approvedSignals = await this.prisma.signal.findMany({
      where: {
        status: 'approved',
      },
      orderBy: {
        observedAt: 'asc',
      },
      take: 20,
    });
    const prismaAny = this.prisma as any;
    const [recentExecutionDiagnostics, recentAuditEvents, learningState] = await Promise.all([
      prismaAny.executionDiagnostic?.findMany
        ? prismaAny.executionDiagnostic.findMany({
            orderBy: { capturedAt: 'desc' },
            take: 80,
          })
        : Promise.resolve([]),
      prismaAny.auditEvent?.findMany
        ? prismaAny.auditEvent.findMany({
            orderBy: { createdAt: 'desc' },
            take: 80,
          })
        : Promise.resolve([]),
      this.learningStateStore ? this.learningStateStore.load() : Promise.resolve(null),
    ]);
    const latestAlphaAttributionReview =
      this.readLatestAlphaAttributionReview(recentAuditEvents);

    let submitted = 0;
    let rejected = 0;

    for (const signal of approvedSignals) {
      if (!canSubmit()) {
        this.logger.warn('Execution stopped before signal submit due to runtime veto.');
        break;
      }

      const existingOrder = await this.prisma.order.findFirst({
        where: {
          signalId: signal.id,
          status: {
            in: ['submitted', 'acknowledged', 'partially_filled'],
          },
        },
      });
      if (existingOrder) {
        continue;
      }

      const decision = await this.prisma.signalDecision.findFirst({
        where: { signalId: signal.id, verdict: 'approved' },
        orderBy: { decisionAt: 'desc' },
      });

      if (!decision || !decision.positionSize || decision.positionSize <= 0) {
        await this.rejectSignal(signal.id, 'position_size_missing');
        rejected += 1;
        continue;
      }
      const upstreamEvaluationDecision =
        await this.versionLineageRegistry.getLatestForSignalDecision(decision.id);
      const upstreamEvaluationEvidence =
        this.readUpstreamEvaluationEvidence(upstreamEvaluationDecision);

      if (!signal.strategyVersionId) {
        await this.rejectSignal(signal.id, 'strategy_version_missing');
        rejected += 1;
        continue;
      }

      const market = await this.prisma.market.findUnique({
        where: { id: signal.marketId },
      });

      if (!market) {
        await this.rejectSignal(signal.id, 'market_missing');
        rejected += 1;
        continue;
      }

      const executionIntent = this.resolveExecutionIntent(signal, market);
      if (!executionIntent) {
        await this.rejectSignal(signal.id, 'ambiguous_execution_intent');
        rejected += 1;
        continue;
      }

      const { tokenId, outcome, venueSide, action, inventoryEffect } = executionIntent;
      const isNewExposure = inventoryEffect === 'increase';

      if (!venueMode.allowOrderSubmit) {
        await this.rejectSignal(signal.id, `venue_mode_${venueMode.mode}`);
        rejected += 1;
        continue;
      }

      if (isNewExposure && venueMode.blockNewEntries) {
        await this.rejectSignal(signal.id, `venue_mode_${venueMode.mode}`);
        rejected += 1;
        continue;
      }

      if (isNewExposure && !activeSafetyState.allowNewEntries) {
        await this.rejectSignal(signal.id, 'safety_state_no_new_entries');
        rejected += 1;
        continue;
      }

      const signalAgeMs = Date.now() - new Date(signal.observedAt).getTime();
      if (signalAgeMs > appEnv.BOT_MAX_SIGNAL_AGE_MS) {
        await this.rejectSignal(signal.id, 'signal_stale');
        rejected += 1;
        continue;
      }

      const snapshot = await this.prisma.marketSnapshot.findFirst({
        where: { marketId: market.id },
        orderBy: { observedAt: 'desc' },
      });
      if (!snapshot) {
        await this.rejectSignal(signal.id, 'market_snapshot_missing');
        rejected += 1;
        continue;
      }

      const snapshotAgeMs = Date.now() - new Date(snapshot.observedAt).getTime();
      if (snapshotAgeMs > appEnv.BOT_MAX_MARKET_SNAPSHOT_AGE_MS) {
        await this.venueHealthLearningStore.recordStaleDataInterval(snapshotAgeMs);
        await this.rejectSignal(signal.id, 'market_snapshot_stale');
        rejected += 1;
        continue;
      }

      const expiryAt = snapshot.expiresAt ?? market.expiresAt;
      if (!expiryAt) {
        await this.rejectSignal(signal.id, 'expiry_unknown');
        rejected += 1;
        continue;
      }

      const noTradeWindowSeconds =
        liveConfig?.noTradeWindowSeconds ?? appEnv.NO_TRADE_WINDOW_SECONDS;
      if (noTradeWindowSeconds >= 0) {
        const secondsToExpiry = Math.floor(
          (new Date(expiryAt).getTime() - Date.now()) / 1000,
        );
        if (secondsToExpiry <= noTradeWindowSeconds) {
          await this.rejectSignal(signal.id, 'no_trade_near_expiry');
          rejected += 1;
          continue;
        }
      }

      const orderbook = await this.prisma.orderbook.findFirst({
        where: {
          marketId: market.id,
          tokenId,
        },
        orderBy: { observedAt: 'desc' },
      });
      if (!orderbook) {
        await this.rejectSignal(signal.id, 'orderbook_missing');
        rejected += 1;
        continue;
      }

      const orderbookAgeMs = Date.now() - new Date(orderbook.observedAt).getTime();
      if (orderbookAgeMs > appEnv.BOT_MAX_ORDERBOOK_AGE_MS) {
        await this.venueHealthLearningStore.recordStaleDataInterval(orderbookAgeMs);
        await this.rejectSignal(signal.id, 'orderbook_stale');
        rejected += 1;
        continue;
      }

      const tickSize = this.normalizePositiveNumber(
        (orderbook as Record<string, unknown>).tickSize as number | null | undefined,
      );
      if (tickSize === null) {
        await this.rejectSignal(signal.id, 'orderbook_tick_size_missing');
        rejected += 1;
        continue;
      }

      const minOrderSize = this.normalizePositiveNumber(
        (orderbook as Record<string, unknown>).minOrderSize as number | null | undefined,
      );
      if (minOrderSize === null) {
        await this.rejectSignal(signal.id, 'orderbook_min_order_size_missing');
        rejected += 1;
        continue;
      }

      const negRiskRaw = (orderbook as Record<string, unknown>).negRisk;
      const negRisk = typeof negRiskRaw === 'boolean' ? negRiskRaw : null;
      if (negRisk === null) {
        await this.rejectSignal(signal.id, 'orderbook_neg_risk_missing');
        rejected += 1;
        continue;
      }

      const negRiskVerdict = this.negativeRiskPolicy.evaluate({
        negRisk,
      });
      if (!negRiskVerdict.allowed) {
        await this.rejectSignal(signal.id, negRiskVerdict.reasonCode);
        rejected += 1;
        continue;
      }

      const eligibility = this.marketEligibility.evaluate({
        market: {
          id: market.id,
          slug: this.readStringField(market, 'slug'),
          title: this.readStringField(market, 'title'),
          question: this.readStringField(market, 'title'),
          active: this.readStringField(market, 'status') !== 'closed',
          closed: this.readStringField(market, 'status') === 'closed',
          tradable: true,
          tokenIdYes: this.readStringField(market, 'tokenIdYes'),
          tokenIdNo: this.readStringField(market, 'tokenIdNo'),
          expiresAt: expiryAt ? new Date(expiryAt).toISOString() : null,
          negativeRisk: negRisk,
          enableOrderBook: true,
        },
        spread: orderbook.spread ?? null,
        bidDepth: this.topLevelDepth(orderbook, 'SELL'),
        askDepth: this.topLevelDepth(orderbook, 'BUY'),
        topLevelDepth: this.topLevelDepth(orderbook, venueSide),
        tickSize,
        orderbookObservedAt: orderbook.observedAt,
        marketObservedAt: snapshot.observedAt,
        recentTradeCount: this.estimateRecentTradeCount(snapshot.volume ?? null),
        maxOrderbookAgeMs: appEnv.BOT_MAX_ORDERBOOK_AGE_MS,
        maxMarketAgeMs: appEnv.BOT_MAX_MARKET_SNAPSHOT_AGE_MS,
        noTradeWindowSeconds,
      });
      if (!eligibility.eligible) {
        await this.rejectSignal(signal.id, eligibility.reasonMessage ?? eligibility.reasonCode);
        rejected += 1;
        continue;
      }

      const signerHealth = this.signerHealth.check({
        privateKey: appEnv.POLY_PRIVATE_KEY,
        apiKey: appEnv.POLY_API_KEY,
        apiSecret: appEnv.POLY_API_SECRET,
        apiPassphrase: appEnv.POLY_API_PASSPHRASE,
      });
      const guard = this.liveTradeGuard.evaluate({
        botState: canSubmit() ? 'running' : 'cancel_only',
        signerHealthy:
          operatingMode === 'sentinel_simulation' ? true : signerHealth.checks.privateKey,
        credentialsHealthy:
          operatingMode === 'sentinel_simulation'
            ? true
            : signerHealth.checks.apiKey &&
              signerHealth.checks.apiSecret &&
              signerHealth.checks.apiPassphrase,
        marketDataFresh:
          signalAgeMs <= appEnv.BOT_MAX_SIGNAL_AGE_MS &&
          orderbookAgeMs <= appEnv.BOT_MAX_ORDERBOOK_AGE_MS &&
          snapshotAgeMs <= appEnv.BOT_MAX_MARKET_SNAPSHOT_AGE_MS,
      });
      if (!guard.passed) {
        await this.rejectSignal(signal.id, guard.reasonCode);
        rejected += 1;
        continue;
      }

      const bestBid = orderbook.bestBid ?? 0;
      const bestAsk = orderbook.bestAsk ?? 0;
      const urgency = this.executionUrgency(expiryAt, noTradeWindowSeconds);
      const topLevelDepth = this.topLevelDepth(orderbook, venueSide);
      const strategyVariantId = buildStrategyVariantId(signal.strategyVersionId);
      const activeExecutionPolicy = this.executionPolicyVersionStore
        ? await this.executionPolicyVersionStore.getActiveVersionForStrategy(
            strategyVariantId,
            signal.regime ?? null,
          )
        : null;
      const executionContext =
        activeExecutionPolicy?.contextKey && learningState
          ? learningState.executionLearning.contexts[activeExecutionPolicy.contextKey] ?? null
          : null;
      const calibration =
        signal.strategyVersionId && learningState
          ? this.resolveCalibrationForSignal(
              learningState,
              strategyVariantId,
              signal.regime ?? null,
            )
          : null;
      const regimeSnapshot =
        signal.strategyVersionId && learningState
          ? this.resolveRegimeSnapshot(learningState, strategyVariantId, signal.regime ?? null)
          : null;
      const regimeHealth = regimeSnapshot?.health ?? null;
      const toxicity = this.buildExecutionToxicity({
        signalAgeMs,
        signal,
        orderbook,
        expiryAt,
        recentToxicityHistory: this.selectRecentToxicityHistory(
          recentAuditEvents,
          signal.marketId,
        ),
      });
      const executionCostCalibration = this.executionCostCalibrator.calibrate({
        activePolicyVersion: activeExecutionPolicy,
        executionContext,
        recentObservations: this.selectRecentExecutionCostObservations(
          recentExecutionDiagnostics,
          signal.strategyVersionId,
          signal.regime ?? null,
        ),
        cancelFailureRate: 0,
        venueUncertaintyLabel: venueAssessment.label,
      });
      const executionDrift = this.averageExecutionDrift(
        recentExecutionDiagnostics,
        signal.strategyVersionId,
        signal.regime ?? null,
      );
      const liveSizingFeedback = this.liveSizingFeedbackPolicy.evaluate({
        retentionRatio: latestAlphaAttributionReview?.averageRetentionRatio ?? null,
        calibrationHealth: calibration?.health ?? null,
        executionDrift,
        regimeDegradation: regimeHealth,
        toxicityState: toxicity.toxicityState,
        venueUncertainty: venueAssessment.label,
        realizedVsExpected:
          regimeSnapshot?.realizedVsExpected ??
          latestAlphaAttributionReview?.realizedVsExpected ??
          null,
      });
      const liveSizingRecoveryProbationState =
        typeof liveSizingFeedback.recoveryProbationState === 'string'
          ? liveSizingFeedback.recoveryProbationState
          : 'none';
      const liveSizingUpshiftEligibility =
        typeof liveSizingFeedback.upshiftEligibility === 'string'
          ? liveSizingFeedback.upshiftEligibility
          : 'eligible';
      const liveSizingReasonCodes = Array.isArray(liveSizingFeedback.sizingReasonCodes)
        ? liveSizingFeedback.sizingReasonCodes
        : Array.isArray(liveSizingFeedback.reasonCodes)
          ? liveSizingFeedback.reasonCodes
          : [];
      let adaptiveExecution = this.adaptiveMakerTakerPolicy.decide({
        activePolicyVersion: activeExecutionPolicy,
        marketContext: {
          strategyVariantId,
          regime: signal.regime ?? null,
          action,
          urgency,
          spread:
            typeof orderbook.spread === 'number' && Number.isFinite(orderbook.spread)
              ? orderbook.spread
              : null,
          topLevelDepth,
        },
      });
      if (
        isNewExposure &&
        toxicity.passiveOnly &&
        adaptiveExecution.executionStyle === 'cross'
      ) {
        adaptiveExecution = {
          ...adaptiveExecution,
          mode: activeExecutionPolicy?.mode ?? adaptiveExecution.mode,
          route: 'maker',
          executionStyle: 'rest',
          preferResting: true,
          rationale: [...adaptiveExecution.rationale, ...toxicity.aggressionReasonCodes],
        };
      }
      if (
        isNewExposure &&
        liveSizingFeedback.aggressionCap === 'passive_only' &&
        adaptiveExecution.executionStyle === 'cross'
      ) {
        adaptiveExecution = {
          ...adaptiveExecution,
          mode: activeExecutionPolicy?.mode ?? adaptiveExecution.mode,
          route: 'maker',
          executionStyle: 'rest',
          preferResting: true,
          rationale: [...adaptiveExecution.rationale, 'live_sizing_feedback_passive_only'],
        };
      }
      if (
        isNewExposure &&
        liveSizingRecoveryProbationState !== 'none'
      ) {
        adaptiveExecution = {
          ...adaptiveExecution,
          rationale: Array.from(
            new Set([
              ...adaptiveExecution.rationale,
              `live_sizing_feedback_recovery_probation_${liveSizingRecoveryProbationState}`,
              `live_sizing_feedback_upshift_${liveSizingUpshiftEligibility}`,
              ...liveSizingReasonCodes,
            ]),
          ),
        };
      }
      if (isNewExposure && toxicity.temporarilyBlockRegime) {
        await this.rejectSignal(signal.id, 'toxicity_temporarily_blocks_regime');
        rejected += 1;
        continue;
      }
      if (
        isNewExposure &&
        liveSizingFeedback.regimePermissionOverride === 'block_new_entries'
      ) {
        await this.rejectSignal(signal.id, 'live_sizing_feedback_blocks_new_entries');
        rejected += 1;
        continue;
      }
      if (
        isNewExposure &&
        liveSizingFeedback.regimePermissionOverride === 'reduce_only'
      ) {
        await this.rejectSignal(signal.id, 'live_sizing_feedback_reduce_only');
        rejected += 1;
        continue;
      }
      if (
        isNewExposure &&
        (toxicity.executionAggressionLock === 'passive_only' ||
          !activeSafetyState.allowAggressiveEntries) &&
        adaptiveExecution.executionStyle === 'cross'
      ) {
        await this.rejectSignal(
          signal.id,
          toxicity.executionAggressionLock === 'passive_only'
            ? 'toxicity_passive_only_lock'
            : 'safety_state_passive_only',
        );
        rejected += 1;
        continue;
      }
      const entryTiming = this.entryTimingEfficiencyScorer.score({
        signalAgeMs,
        timeToExpirySeconds: Math.max(
          0,
          Math.floor((new Date(expiryAt).getTime() - Date.now()) / 1000),
        ),
        halfLifeMultiplier: Math.max(
          0.1,
          1 - signalAgeMs / Math.max(appEnv.BOT_MAX_SIGNAL_AGE_MS, 1),
        ),
        halfLifeExpired: signalAgeMs >= appEnv.BOT_MAX_SIGNAL_AGE_MS,
        expectedFillDelayMs: executionCostCalibration.expectedFillDelayMs,
        microstructureDecayPressure:
          orderbook.spread != null ? Math.min(1, orderbook.spread / 0.05) : 0.5,
      });

      const marketable = this.marketableLimit.calculate({
        side: venueSide,
        bestBid: bestBid > 0 ? bestBid : null,
        bestAsk: bestAsk > 0 ? bestAsk : null,
        aggressionBps: urgency === 'high' ? 15 : urgency === 'medium' ? 8 : 3,
      });

      const rawPrice = this.clampPrice(marketable.price);
      if (!Number.isFinite(rawPrice) || rawPrice <= 0) {
        await this.rejectSignal(signal.id, 'invalid_price');
        rejected += 1;
        continue;
      }

      const price = this.quantizeToTick(rawPrice, tickSize);
      if (!Number.isFinite(price) || price <= 0) {
        await this.rejectSignal(signal.id, 'invalid_price');
        rejected += 1;
        continue;
      }

      if (!this.isOnTick(price, tickSize)) {
        await this.rejectSignal(signal.id, 'price_not_on_tick');
        rejected += 1;
        continue;
      }

      const capitalAwareDecisionSize =
        decision.positionSize *
        (isNewExposure
          ? activeSafetyState.sizeMultiplier *
            venueMode.sizeMultiplier *
            toxicity.sizeMultiplier *
            liveSizingFeedback.sizeMultiplier
          : 1);
      const initialSize = Math.max(0, capitalAwareDecisionSize / price);
      const liquidityDecision = this.sizeVsLiquidityPolicy.evaluate({
        desiredNotional: capitalAwareDecisionSize,
        desiredSizeUnits: initialSize,
        price,
        topLevelDepth,
        spread: orderbook.spread ?? null,
        expectedSlippage: Math.max(
          executionCostCalibration.slippageCost,
          this.slippageEstimator.estimate({
            side: venueSide,
            bestBid: bestBid > 0 ? bestBid : null,
            bestAsk: bestAsk > 0 ? bestAsk : null,
            targetSize: initialSize,
            topLevelDepth,
          }).expectedSlippage,
        ),
        route: adaptiveExecution.route,
      });
      const lossCapDecision = this.maxLossPerOpportunityPolicy.evaluate({
        candidatePositionSize: Math.max(0, liquidityDecision.allowedNotional),
        bankroll: Math.max(decision.positionSize, capitalAwareDecisionSize, 1) * 100,
        availableCapital: Math.max(capitalAwareDecisionSize, 0) * 100,
        maxPerTradeRiskPct: appEnv.MAX_PER_TRADE_RISK_PCT,
        opportunityClass:
          signal.expectedEv >= 0.03
            ? 'strong_edge'
            : signal.expectedEv >= 0.015
              ? 'tradable_edge'
              : signal.expectedEv > 0
                ? 'marginal_edge'
                : 'weak_edge',
        signalConfidence: Math.max(0.2, Math.min(1, Math.abs(signal.posteriorProbability - 0.5) * 2)),
      });
      const size = Math.max(
        0,
        Math.min(
          liquidityDecision.allowedSizeUnits,
          lossCapDecision.maxAllowedPositionSize / Math.max(price, 1e-9),
        ) * entryTiming.sizeMultiplier,
      );

      if (!Number.isFinite(size) || size <= 0) {
        await this.rejectSignal(signal.id, 'invalid_size');
        rejected += 1;
        continue;
      }

      if (size < minOrderSize) {
        await this.rejectSignal(signal.id, 'size_below_min_order_size');
        rejected += 1;
        continue;
      }

      const slippage = this.slippageEstimator.estimate({
        side: venueSide,
        bestBid: bestBid > 0 ? bestBid : null,
        bestAsk: bestAsk > 0 ? bestAsk : null,
        targetSize: size,
        topLevelDepth,
      });
      const executionCostAssessment = this.realizedCostModel.evaluate({
        grossEdge: signal.expectedEv,
        feeCost: executionCostCalibration.feeCost,
        slippageCost: Math.max(slippage.expectedSlippage, executionCostCalibration.slippageCost),
        adverseSelectionCost: executionCostCalibration.adverseSelectionCost,
        fillDelayMs: signalAgeMs + (executionCostCalibration.expectedFillDelayMs ?? 0),
        expectedFillDelayMs: executionCostCalibration.expectedFillDelayMs,
        cancelReplaceOverheadCost: executionCostCalibration.cancelReplaceOverheadCost,
        missedOpportunityCost: executionCostCalibration.missedOpportunityCost,
      });
      if (entryTiming.blockTrade) {
        await this.rejectSignal(signal.id, 'entry_timing_blocks_opportunity');
        rejected += 1;
        continue;
      }
      if (liquidityDecision.blockTrade) {
        await this.rejectSignal(signal.id, 'liquidity_policy_blocks_size');
        rejected += 1;
        continue;
      }
      if (lossCapDecision.blockTrade && lossCapDecision.maxAllowedPositionSize <= 0) {
        await this.rejectSignal(signal.id, 'max_loss_per_opportunity_blocked');
        rejected += 1;
        continue;
      }
      if (slippage.severity === 'high' && signal.expectedEv <= slippage.expectedSlippage) {
        await this.rejectSignal(signal.id, 'expected_slippage_exceeds_edge');
        rejected += 1;
        continue;
      }

      const feeSnapshot = await this.resolveVenueFeeSnapshot(tokenId);
      let orderPlan;
      try {
        orderPlan = this.orderPlanner.plan({
          resolvedIntent: {
            tokenId,
            outcome,
            intent: action,
            venueSide,
            inventoryEffect: inventoryEffect === 'increase' ? 'INCREASE' : 'DECREASE',
          },
          price,
          size,
          urgency,
          expiryAt: new Date(expiryAt).toISOString(),
          noTradeWindowSeconds,
          partialFillTolerance:
            action === 'ENTER' && urgency === 'high' ? 'all_or_nothing' : 'allow_partial',
          preferResting: adaptiveExecution.preferResting,
          executionStyle: adaptiveExecution.executionStyle,
          venueConstraints: {
            tickSize,
            minOrderSize,
            negRisk,
          },
          liquidity: {
            topLevelDepth,
            executableDepth: topLevelDepth,
            recentMatchedVolume: snapshot.volume ?? 0,
            restingSizeAhead: topLevelDepth,
            bestBid: bestBid > 0 ? bestBid : null,
            bestAsk: bestAsk > 0 ? bestAsk : null,
            spread: orderbook.spread ?? null,
          },
          regime: signal.regime ?? null,
          venueUncertaintyLabel: venueAssessment.label,
          feeRateBpsEstimate: feeSnapshot?.feeRateBps ?? 20,
        });
      } catch (error) {
        await this.rejectSignal(
          signal.id,
          error instanceof Error ? 'order_planning_failed' : 'order_planning_failed',
        );
        rejected += 1;
        continue;
      }

      if (
        isNewExposure &&
        (toxicity.executionAggressionLock === 'passive_only' ||
          !activeSafetyState.allowAggressiveEntries) &&
        orderPlan.executionStyle === 'cross'
      ) {
        await this.rejectSignal(
          signal.id,
          toxicity.executionAggressionLock === 'passive_only'
            ? 'toxicity_passive_only_lock'
            : 'safety_state_passive_only',
        );
        rejected += 1;
        continue;
      }

      const venueValidation = this.venueOrderValidator.validate({
        tokenId: orderPlan.tokenId,
        side: orderPlan.side,
        price: orderPlan.price,
        size: orderPlan.size,
        orderType: orderPlan.orderType,
        metadata: {
          tickSize,
          minOrderSize,
          negRisk,
        },
        executionStyle: orderPlan.executionStyle,
        expiration: orderPlan.expiration,
        postOnly: false,
        normalizePriceToTick: false,
      });
      if (!venueValidation.valid) {
        await this.rejectSignal(
          signal.id,
          venueValidation.reasonCode ?? 'venue_order_validation_failed',
        );
        rejected += 1;
        continue;
      }

      if ((orderPlan.orderType === 'FOK' || orderPlan.orderType === 'FAK') && topLevelDepth <= 0) {
        await this.rejectSignal(signal.id, 'immediate_execution_liquidity_missing');
        rejected += 1;
        continue;
      }

      const feeModel = this.venueFeeModel.evaluate({
        tokenId,
        route: orderPlan.route,
        price: orderPlan.price,
        size: orderPlan.size,
        venueFeeRateBps: feeSnapshot?.feeRateBps ?? null,
        venueFeeFetchedAt: feeSnapshot?.fetchedAt ?? null,
        source: feeSnapshot ? 'venue_live' : 'fallback',
      });
      const plannerFillProbabilityEstimate = (orderPlan as Record<string, any>).fillProbabilityEstimate;
      const plannerQueueEstimate = (orderPlan as Record<string, any>).queueEstimate;
      const plannerSlippageEstimate = (orderPlan as Record<string, any>).slippageEstimate;
      const executionPlannerAssumptions = {
        expectedFillProbability: orderPlan.expectedFillProbability,
        expectedFillFraction: orderPlan.expectedFillFraction,
        expectedQueueDelayMs: orderPlan.expectedQueueDelayMs,
        expectedQueueDelayProfile:
          plannerFillProbabilityEstimate?.expectedQueueDelayProfile ?? {
            averageMs: orderPlan.expectedQueueDelayMs ?? null,
            p50Ms: orderPlan.expectedQueueDelayMs ?? null,
            p90Ms: orderPlan.expectedQueueDelayMs ?? null,
          },
        expectedRealizedCostBps: Math.max(
          orderPlan.expectedRealizedCostBps,
          feeModel.netFeeBps +
            (plannerSlippageEstimate?.finalExpectedSlippageBps ?? 0) +
            orderPlan.expectedAdverseSelectionPenaltyBps,
        ),
        expectedAdverseSelectionPenaltyBps: orderPlan.expectedAdverseSelectionPenaltyBps,
        recommendedOrderStyleRationale: orderPlan.recommendedOrderStyleRationale,
        executionBucketContext: orderPlan.executionBucketContext,
        fillProbabilityByHorizon: plannerFillProbabilityEstimate?.fillProbabilityByHorizon ?? null,
        fillProbabilityConfidence: plannerFillProbabilityEstimate?.confidence ?? null,
        fillProbabilityEvidenceCount: plannerFillProbabilityEstimate?.evidenceCount ?? 0,
        queueEstimate: {
          centralEstimateMs: plannerQueueEstimate?.centralEstimateMs ?? orderPlan.expectedQueueDelayMs,
          lowerBoundMs: plannerQueueEstimate?.lowerBoundMs ?? orderPlan.expectedQueueDelayMs,
          upperBoundMs: plannerQueueEstimate?.upperBoundMs ?? orderPlan.expectedQueueDelayMs,
          confidence: plannerQueueEstimate?.confidence ?? null,
          evidenceCount: plannerQueueEstimate?.evidenceCount ?? 0,
        },
        slippageEstimate: {
          geometryBasedComponent: plannerSlippageEstimate?.geometryBasedComponent ?? null,
          empiricalAdjustmentComponent: plannerSlippageEstimate?.empiricalAdjustmentComponent ?? null,
          finalExpectedSlippageBps: plannerSlippageEstimate?.finalExpectedSlippageBps ?? null,
          evidenceStrength: plannerSlippageEstimate?.evidenceStrength ?? null,
          evidenceCount: plannerSlippageEstimate?.evidenceCount ?? 0,
        },
        postFillToxicitySummary:
          (orderPlan as Record<string, any>).postFillToxicitySummary ?? null,
        feeRateBpsEstimate: feeModel.netFeeBps,
      };
      const executionAdjustedEdge =
        signal.expectedEv -
        Math.max(0, executionCostAssessment.breakdown.totalCost - executionCostCalibration.feeCost);
      const retainedEdgeExpectation = this.buildRetentionDiagnostics({
        upstreamExpectedNetEdge:
          upstreamEvaluationEvidence.alphaAttribution?.expectedNetEdge ?? null,
        executionAdjustedEdge,
        marketArchetype: upstreamEvaluationEvidence.marketArchetype,
        toxicityState:
          upstreamEvaluationEvidence.toxicityState ?? toxicity.toxicityState,
      });
      if (
        liveSizingFeedback.thresholdAdjustment > 0 &&
        executionAdjustedEdge <= liveSizingFeedback.thresholdAdjustment
      ) {
        await this.rejectSignal(signal.id, 'live_sizing_feedback_threshold_not_met');
        rejected += 1;
        continue;
      }
      if (
        retainedEdgeExpectation.reasonCodes.includes('retained_edge_expectation_not_met')
      ) {
        await this.rejectSignal(signal.id, 'retained_edge_expectation_not_met');
        rejected += 1;
        continue;
      }
      if (executionAdjustedEdge <= 0) {
        await this.rejectSignal(signal.id, 'execution_cost_adjusted_edge_non_positive');
        rejected += 1;
        continue;
      }
      if (signal.expectedEv <= slippage.expectedSlippage + feeModel.expectedFeePerUnit) {
        await this.rejectSignal(signal.id, 'fee_adjusted_edge_non_positive');
        rejected += 1;
        continue;
      }

      const rewardsMarkets =
        orderPlan.route === 'maker' ? await this.resolveVenueRewardsMarkets() : [];
      const makerQuality = this.makerQualityPolicy.evaluate({
        route: orderPlan.route,
        tokenId,
        side: orderPlan.side,
        price: orderPlan.price,
        size: orderPlan.size,
        bestBid: bestBid > 0 ? bestBid : null,
        bestAsk: bestAsk > 0 ? bestAsk : null,
        tickSize,
        rewardsMarkets,
      });

      if (operatingMode === 'sentinel_simulation') {
        await this.simulateSentinelTrade({
          signal,
          market,
          tokenId,
          strategyVariantId,
          orderPlan,
          feeModel,
          executionPlannerAssumptions,
          executionAdjustedEdge,
          slippage,
          makerQuality,
        });
        await this.prisma.signal.update({
          where: { id: signal.id },
          data: { status: 'sentinel_simulated' },
        });
        submitted += 1;
        continue;
      }

      const localOrderId = randomUUID();
      const intentEpoch = await this.resolveIntentEpoch(signal.id);
      const orderIdentity = this.orderIntentService.identify({
        source: `${signal.id}:epoch:${intentEpoch}:${signal.strategyVersionId ?? 'unknown'}`,
        marketId: market.id,
        tokenId,
        side: orderPlan.side,
        intent:
          action === 'EXIT'
            ? 'EXIT'
            : action === 'REDUCE'
              ? 'REDUCE'
              : 'ENTER',
        price: orderPlan.price,
        size: orderPlan.size,
        orderType: orderPlan.orderType,
        expiration: orderPlan.expiration,
      });
      const idempotencyKey = orderIdentity.intentId;
      const priorIntent = await this.orderIntentRepository.loadLatest(orderIdentity.intentId);
      if (this.shouldBlockIntentReplay(priorIntent)) {
        await this.prisma.auditEvent.create({
          data: {
            marketId: market.id,
            signalId: signal.id,
            eventType: 'order.intent.truth_pending',
            message:
              'Order intent replay was blocked because prior submit truth is already recorded.',
            metadata: {
              intentId: orderIdentity.intentId,
              clientOrderId: orderIdentity.clientOrderId,
              priorIntent,
            } as object,
          },
        });
        continue;
      }
      const inventoryEffectValue: 'INCREASE' | 'DECREASE' =
        inventoryEffect === 'increase' ? 'INCREASE' : 'DECREASE';
      const payload = {
        tokenId,
        side: orderPlan.side,
        outcome,
        intent: action,
        inventoryEffect: inventoryEffectValue,
        tickSize,
        minOrderSize,
        negRisk,
        price: orderPlan.price,
        size: orderPlan.size,
        orderType: orderPlan.orderType,
        expiration: orderPlan.expiration,
        clientOrderId: orderIdentity.clientOrderId,
      };

      let postedStatus = 'submitted';
      let venueOrderId: string | null = null;
      let lastError: string | null = null;
      let lastVenueStatus: string | null = null;
      let externalPortfolioSnapshot: ExternalPortfolioSnapshot | null = null;
      let duplicateExposureVerdict: ReturnType<DuplicateExposureGuard['evaluate']> | null = null;
      let terminalRejectReason: string | null = null;

      if (appEnv.BOT_LIVE_EXECUTION_ENABLED) {
        if (!canSubmit()) {
          await this.rejectSignal(signal.id, 'runtime_not_running');
          rejected += 1;
          continue;
        }

        try {
          externalPortfolioSnapshot =
            await this.externalPortfolioService.capture({
              cycleKey: `pretrade:${signal.id}:${Date.now()}`,
              source: 'external_portfolio_reconcile',
            });
          const accountState = await this.accountStateService.capture({
            persist: false,
            externalSnapshot: externalPortfolioSnapshot,
            marketStreamHealthy: true,
            userStreamHealthy: true,
          });
          if (orderPlan.price * orderPlan.size > accountState.deployableRiskNow + 1e-9) {
            await this.rejectSignal(signal.id, 'deployable_risk_exhausted');
            rejected += 1;
            continue;
          }
          const fundingVerdict = this.fundingValidator.validate({
            tokenId,
            side: orderPlan.side,
            price: orderPlan.price,
            size: orderPlan.size,
            snapshot: externalPortfolioSnapshot,
          });
          if (!fundingVerdict.passed) {
            await this.rejectSignal(
              signal.id,
              fundingVerdict.reasonCode ?? 'external_portfolio_truth_missing',
            );
            rejected += 1;
            continue;
          }

          const currentPositionSize =
            externalPortfolioSnapshot.inventories.find((inventory) => inventory.tokenId === tokenId)
              ?.positionQuantity ?? 0;
          const localWorkingOrders =
            (this.prisma.order as any)?.findMany
              ? await (this.prisma.order as any).findMany({
                  where: {
                    marketId: market.id,
                    tokenId,
                    status: {
                      in: ['submitted', 'acknowledged', 'partially_filled'],
                    },
                  },
                  orderBy: {
                    createdAt: 'asc',
                  },
                  take: 20,
                })
              : [];
          duplicateExposureVerdict = this.duplicateExposureGuard.evaluate({
            marketId: market.id,
            tokenId,
            side: orderPlan.side,
            inventoryEffect: inventoryEffectValue,
            desiredSize: orderPlan.size,
            currentPositionSize,
            localWorkingOrders: localWorkingOrders
              .filter((order: any) => typeof order.tokenId === 'string' && order.tokenId.length > 0)
              .map((order: any) => ({
                id: order.id,
                signalId: order.signalId,
                tokenId: order.tokenId as string,
                side: order.side as 'BUY' | 'SELL',
                size: order.size,
                remainingSize: order.remainingSize,
                status: order.status,
              })),
            venueWorkingOrders: externalPortfolioSnapshot.openOrders.map((order) => ({
              id: order.id,
              tokenId: order.tokenId,
              side: order.side === 'SELL' ? 'SELL' : 'BUY',
              size: order.size,
              matchedSize: order.matchedSize,
              status: order.status,
            })),
          });
          if (!duplicateExposureVerdict.allowed) {
            await this.rejectSignal(signal.id, duplicateExposureVerdict.reasonCode);
            rejected += 1;
            continue;
          }
        } catch (error) {
          await this.rejectSignal(signal.id, 'external_portfolio_truth_unhealthy');
          rejected += 1;
          this.logger.error('External portfolio truth fetch failed before submit.', undefined, {
            signalId: signal.id,
            error: error instanceof Error ? error.message : String(error),
            tokenId,
            venueSide: orderPlan.side,
          });
          continue;
        }

        await this.orderIntentRepository.record({
          intentId: orderIdentity.intentId,
          status: 'prepared',
          fingerprint: orderIdentity.fingerprint,
          clientOrderId: orderIdentity.clientOrderId,
          signalId: signal.id,
          marketId: market.id,
          tokenId,
          attempts: (priorIntent?.attempts ?? 0) + 1,
          details: {
            executionPlannerAssumptions,
            feeModel,
          },
        });
        const submitStartedAtMs = Date.now();
        try {
          const response = await this.tradingClient.postOrder(payload);
          await this.venueHealthLearningStore.recordRequest({
            latencyMs: Date.now() - submitStartedAtMs,
          });

          venueOrderId = response.orderId;
          lastVenueStatus = response.status;
          postedStatus = response.success
            ? this.normalizeVenueStatus(lastVenueStatus)
            : 'rejected';

          if (!response.success) {
            lastError = `order_rejected:${response.status}`;
            terminalRejectReason = this.reasonCodeFromVenueStatus(response.status);
          }

          this.logger.debug('Order post response received from Polymarket adapter.', {
            signalId: signal.id,
            venueOrderId,
            venueStatus: lastVenueStatus,
            tokenId,
            outcome,
            action,
            venueSide: orderPlan.side,
            orderType: orderPlan.orderType,
            route: orderPlan.route,
            timeDiscipline: orderPlan.timeDiscipline,
            partialFillTolerance: orderPlan.partialFillTolerance,
            tickSize,
            minOrderSize,
            negRisk,
            policyReasonCode: orderPlan.policyReasonCode,
            feeModel,
            makerQuality,
            negRiskVerdict,
            duplicateExposureVerdict,
            externalPortfolioAvailableCapital:
              externalPortfolioSnapshot?.availableCapital ?? null,
            externalPortfolioReservedCash:
              externalPortfolioSnapshot?.reservedCash ?? null,
            externalPortfolioAvailableInventory:
              externalPortfolioSnapshot?.inventories.find(
                (inventory) => inventory.tokenId === tokenId,
              )?.availableQuantity ?? null,
          });
        } catch (error) {
          const normalized = this.normalizeVenueError(error);
          await this.applyOperationalDecision(normalized);
          lastError = error instanceof Error ? error.message : String(error);
          await this.venueHealthLearningStore.recordRequest({
            latencyMs: Date.now() - submitStartedAtMs,
            failureCategory: normalized?.category ?? normalized?.reasonCode ?? 'unknown',
          });
          if (this.isUncertainSubmitError(normalized)) {
            await this.orderIntentRepository.record({
              intentId: orderIdentity.intentId,
              status: 'unknown_visibility',
              fingerprint: orderIdentity.fingerprint,
              clientOrderId: orderIdentity.clientOrderId,
              signalId: signal.id,
              marketId: market.id,
              tokenId,
              orderId: localOrderId,
              attempts: (priorIntent?.attempts ?? 0) + 1,
              details: {
                error: lastError,
                reasonCode: normalized?.reasonCode ?? 'submit_unknown_visibility',
                executionPlannerAssumptions,
              },
            });
            await this.prisma.auditEvent.create({
              data: {
                marketId: market.id,
                signalId: signal.id,
                eventType: 'order.submit_truth_pending',
                message:
                  'Submit visibility is uncertain; replay protection blocked blind resubmission.',
                metadata: {
                  intentId: orderIdentity.intentId,
                  clientOrderId: orderIdentity.clientOrderId,
                  error: lastError,
                  reasonCode: normalized?.reasonCode ?? 'submit_unknown_visibility',
                } as object,
              },
            });
            rejected += 1;
            continue;
          }
          postedStatus = 'rejected';
          terminalRejectReason =
            normalized?.reasonCode ?? 'venue_submit_failed';
          this.logger.error('Order post failed via Polymarket adapter.', undefined, {
            signalId: signal.id,
            error: lastError,
            tokenId,
            outcome,
            action,
            venueSide: orderPlan.side,
            orderType: orderPlan.orderType,
            tickSize,
            minOrderSize,
            negRisk,
            externalPortfolioAvailableCapital:
              externalPortfolioSnapshot?.availableCapital ?? null,
            externalPortfolioAvailableInventory:
              externalPortfolioSnapshot?.inventories.find(
                (inventory) => inventory.tokenId === tokenId,
              )?.availableQuantity ?? null,
            });
        }
      } else {
        await this.orderIntentRepository.record({
          intentId: orderIdentity.intentId,
          status: 'prepared',
          fingerprint: orderIdentity.fingerprint,
          clientOrderId: orderIdentity.clientOrderId,
          signalId: signal.id,
          marketId: market.id,
          tokenId,
          attempts: (priorIntent?.attempts ?? 0) + 1,
          details: {
            executionPlannerAssumptions,
            feeModel,
          },
        });
        postedStatus = 'submitted';
        venueOrderId = localOrderId;
        lastVenueStatus = 'simulated';
      }

      try {
        const initialFilledSize = postedStatus === 'filled' ? size : 0;
        const initialRemainingSize = postedStatus === 'filled' ? 0 : size;

        await this.prisma.order.create({
          data: {
            id: localOrderId,
            marketId: market.id,
            tokenId,
            signalId: signal.id,
            strategyVersionId: signal.strategyVersionId,
            idempotencyKey,
            venueOrderId,
            status: postedStatus,
            side: orderPlan.side,
            outcome,
            intent: action,
            inventoryEffect: inventoryEffectValue,
            price: orderPlan.price,
            size: orderPlan.size,
            expectedEv: signal.expectedEv,
            lastError,
            filledSize: initialFilledSize,
            remainingSize: initialRemainingSize,
            avgFillPrice: null,
            lastVenueStatus,
            lastVenueSyncAt: new Date(),
            postedAt: new Date(),
            acknowledgedAt:
              postedStatus === 'submitted' || postedStatus === 'acknowledged'
                ? new Date()
                : null,
            canceledAt: null,
          } as never,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.toLowerCase().includes('unique constraint')
        ) {
          continue;
        }
        throw error;
      }

      await this.orderIntentRepository.record({
        intentId: orderIdentity.intentId,
        status: postedStatus === 'rejected' || postedStatus === 'filled' ? 'terminal' : 'submitted',
        fingerprint: orderIdentity.fingerprint,
        orderId: localOrderId,
        venueOrderId,
        clientOrderId: orderIdentity.clientOrderId,
        signalId: signal.id,
        marketId: market.id,
        tokenId,
        attempts: (priorIntent?.attempts ?? 0) + 1,
        details: {
          postedStatus,
          lastError,
        },
      });

      const signalDirectionSign = (signal.edge ?? 0) < 0 ? -1 : 1;
      const alphaAttribution = createAlphaAttribution({
        rawForecastProbability: signal.posteriorProbability,
        marketImpliedProbability: signal.marketImpliedProb,
        confidenceAdjustedEdge: signal.edge,
        paperEdge:
          upstreamEvaluationEvidence.alphaAttribution?.paperEdge ??
          (signal.expectedEv != null
            ? signalDirectionSign * Math.abs(signal.expectedEv)
            : signal.edge),
        expectedExecutionCost: {
          ...executionCostAssessment.breakdown,
          venuePenalty: venueAssessment.label === 'unsafe' ? 0.004 : 0,
        },
        expectedNetEdge: signalDirectionSign * executionAdjustedEdge,
        realizedExecutionCost:
          postedStatus === 'filled'
            ? {
                feeCost: feeModel.expectedFee,
                slippageCost: slippage.expectedSlippage,
                adverseSelectionCost: 0,
                fillDecayCost: 0,
                cancelReplaceOverheadCost: 0,
                missedOpportunityCost: 0,
                venuePenalty: venueAssessment.label === 'unsafe' ? 0.004 : 0,
              }
            : null,
        realizedNetEdge:
          postedStatus === 'filled'
            ? signalDirectionSign *
              (signal.expectedEv - feeModel.expectedFee - slippage.expectedSlippage)
            : null,
        capturedAt: new Date().toISOString(),
      });
      const realizedRetentionDiagnostics = this.buildRetentionDiagnostics({
        upstreamExpectedNetEdge:
          upstreamEvaluationEvidence.alphaAttribution?.expectedNetEdge ?? null,
        executionAdjustedEdge,
        realizedNetEdge: alphaAttribution.realizedNetEdge,
        marketArchetype: upstreamEvaluationEvidence.marketArchetype,
        toxicityState:
          upstreamEvaluationEvidence.toxicityState ?? toxicity.toxicityState,
      });
      const realizedFillRate =
        postedStatus === 'filled'
          ? 1
          : postedStatus === 'partially_filled'
            ? 0.5
            : 0;
      const expectedFillRate = this.estimateExpectedFillRate({
        route: orderPlan.route,
        executionStyle: orderPlan.executionStyle,
        orderType: orderPlan.orderType,
        partialFillTolerance: orderPlan.partialFillTolerance,
      });
      const lossAttribution = this.lossAttributionClassifier.classify({
        alphaAttribution,
        signalAgeMs,
        fillRate: realizedFillRate,
        expectedFillRate,
        toxicityState: toxicity.toxicityState,
        regimeHealth,
        sizeToDepthRatio: topLevelDepth > 0 ? size / topLevelDepth : null,
        liquidityReductionRatio:
          initialSize > 0 ? Math.max(0, 1 - size / initialSize) : null,
        entryTimingLabel: entryTiming.label,
        retainedEdgeReasonCodes: realizedRetentionDiagnostics.reasonCodes,
      });

      if (prismaAny.executionDiagnostic?.create) {
        const snapshot = this.executionDiagnostics.create({
          orderId: localOrderId,
          strategyVersionId: signal.strategyVersionId,
          expectedEv: signal.expectedEv,
          realizedEv: postedStatus === 'filled'
            ? signal.expectedEv - feeModel.expectedFee - slippage.expectedSlippage
            : null,
          expectedFee: feeModel.expectedFee,
          realizedFee: postedStatus === 'filled' ? feeModel.expectedFee : null,
          expectedSlippage: slippage.expectedSlippage,
          realizedSlippage: postedStatus === 'filled' ? slippage.expectedSlippage : null,
          edgeAtSignal: signal.edge ?? null,
          edgeAtFill: postedStatus === 'filled' ? signal.edge ?? null : null,
          fillRate: postedStatus === 'filled' ? 1 : 0,
          staleOrder: signalAgeMs > appEnv.BOT_MAX_SIGNAL_AGE_MS,
          regime: signal.regime ?? null,
        });

        await prismaAny.executionDiagnostic.create({
          data: {
            orderId: snapshot.orderId,
            strategyVersionId: snapshot.strategyVersionId,
            expectedEv: snapshot.expectedEv,
            realizedEv: snapshot.realizedEv,
            evDrift: snapshot.evDrift,
            expectedFee: snapshot.expectedFee,
            realizedFee: snapshot.realizedFee,
            expectedSlippage: snapshot.expectedSlippage,
            realizedSlippage: snapshot.realizedSlippage,
            edgeAtSignal: snapshot.edgeAtSignal,
            edgeAtFill: snapshot.edgeAtFill,
            fillRate: snapshot.fillRate,
            staleOrder: snapshot.staleOrder,
            regime: snapshot.regime,
            capturedAt: new Date(snapshot.capturedAt),
          },
        });
      }

      const submitSucceeded =
        postedStatus === 'submitted' ||
        postedStatus === 'acknowledged' ||
        postedStatus === 'partially_filled' ||
        postedStatus === 'filled';

      const auditEventId = randomUUID();
      await this.prisma.auditEvent.create({
        data: {
          id: auditEventId,
          marketId: market.id,
          signalId: signal.id,
          orderId: localOrderId,
          eventType: submitSucceeded
            ? 'order.submitted'
            : 'order.rejected_on_submit',
          message: submitSucceeded
            ? 'Order submitted.'
            : 'Order rejected during submit.',
          metadata: {
            idempotencyKey,
            venueOrderId,
            tokenId,
            outcome,
            action,
            inventoryEffect,
            venueSide: orderPlan.side,
            signalSide: this.readStringField(signal, 'side'),
            size: orderPlan.size,
            orderType: orderPlan.orderType,
            urgency,
            executionStyle: orderPlan.executionStyle,
            route: orderPlan.route,
            timeDiscipline: orderPlan.timeDiscipline,
            partialFillTolerance: orderPlan.partialFillTolerance,
            policyReasonCode: orderPlan.policyReasonCode,
            policyReasonMessage: orderPlan.policyReasonMessage,
            learnedExecutionPolicyVersionId: adaptiveExecution.policyVersionId,
            learnedExecutionMode: adaptiveExecution.mode,
            learnedExecutionRationale: adaptiveExecution.rationale,
            learnedExecutionStrategyVariantId: strategyVariantId,
            allowedOrderTypes: orderPlan.allowedOrderTypes,
            tickSize,
            minOrderSize,
            negRisk,
            feeModel,
            executionPlannerAssumptions,
            executionCostCalibration,
            executionCostAssessment,
            toxicity,
            liveSizingFeedback,
            alphaAttribution,
            lossAttribution,
            retainedEdgeExpectation: realizedRetentionDiagnostics,
            upstreamEvaluationEvidence,
            liquidityDecision,
            entryTiming,
            lossCapDecision,
            makerQuality,
            negRiskVerdict,
            duplicateExposureVerdict,
            externalPortfolioAvailableCapital:
              externalPortfolioSnapshot?.availableCapital ?? null,
            externalPortfolioReservedCash:
              externalPortfolioSnapshot?.reservedCash ?? null,
            externalPortfolioAvailableInventory:
              externalPortfolioSnapshot?.inventories.find(
                (inventory) => inventory.tokenId === tokenId,
              )?.availableQuantity ?? null,
            expectedSlippage: slippage.expectedSlippage,
            safetyState: activeSafetyState.state,
            safetyReasonCodes: activeSafetyState.reasonCodes,
            venueMode: venueMode.mode,
            venueUncertainty: venueAssessment.label,
            executionAdjustedEdge,
            liveExecutionEnabled: appEnv.BOT_LIVE_EXECUTION_ENABLED,
            error: lastError,
          } as object,
        },
      });
      await this.versionLineageRegistry.recordDecision({
        decisionId: auditEventId,
        decisionType: 'order_execution',
        recordedAt: new Date().toISOString(),
        summary: submitSucceeded
          ? `Order submitted for signal ${signal.id}.`
          : `Order rejected on submit for signal ${signal.id}.`,
        signalId: signal.id,
        orderId: localOrderId,
        marketId: market.id,
        strategyVariantId: buildStrategyVariantId(signal.strategyVersionId),
        lineage: {
          strategyVersion: buildStrategyVersionLineage({
            strategyVersionId: signal.strategyVersionId,
            strategyVariantId: buildStrategyVariantId(signal.strategyVersionId),
          }),
          featureSetVersion: buildFeatureSetVersionLineage({
            featureSetId: 'btc-five-minute-execution',
            parentStrategyVersionId: signal.strategyVersionId,
            parameters: {
              action,
              urgency,
              route: orderPlan.route,
              executionStyle: orderPlan.executionStyle,
            },
          }),
          calibrationVersion: buildCalibrationVersionLineage(calibration),
          executionPolicyVersion: buildExecutionPolicyVersionLineage(activeExecutionPolicy),
          riskPolicyVersion: buildRiskPolicyVersionLineage({
            policyId: 'order-execution',
            parameters: {
              activeSafetyState,
              venueMode,
              signerHealth,
              guard,
              executionCostCalibration,
              executionCostAssessment,
              toxicity,
              liveSizingFeedback,
              alphaAttribution,
              lossAttribution,
              retainedEdgeExpectation: realizedRetentionDiagnostics,
              upstreamEvaluationEvidence,
              liquidityDecision,
              entryTiming,
              lossCapDecision,
            },
          }),
          allocationPolicyVersion: null,
        },
        replay: {
          marketState: {
            signal,
            market,
            marketSnapshot: snapshot,
            orderbook,
          },
          runtimeState: {
            activeSafetyState,
          },
          learningState: learningState
            ? {
                calibration,
                executionLearning: learningState.executionLearning,
              }
            : null,
          lineageState: {
            activeExecutionPolicy,
            adaptiveExecution,
          },
          activeParameterBundle: {
            payload,
            orderPlan,
            feeModel,
            executionCostCalibration,
            executionCostAssessment,
            alphaAttribution,
            lossAttribution,
            toxicity,
            liveSizingFeedback,
            liquidityDecision,
            entryTiming,
            lossCapDecision,
            executionAdjustedEdge,
            retainedEdgeExpectation: realizedRetentionDiagnostics,
            upstreamEvaluationEvidence,
            makerQuality,
            slippage,
            duplicateExposureVerdict,
          },
          venueMode: venueMode.mode,
          venueUncertainty: venueAssessment.label,
        },
        tags: [
          'wave5',
          'phase12_wave4',
          'order-execution',
          `archetype:${realizedRetentionDiagnostics.marketArchetype ?? 'unknown'}`,
          `toxicity:${realizedRetentionDiagnostics.toxicityState ?? 'unknown'}`,
          ...buildLossAttributionTags(lossAttribution),
          submitSucceeded ? 'submitted' : 'rejected',
        ],
      });
      await this.decisionLogService.record({
        createdAt: new Date().toISOString(),
        category: 'post_trade',
        eventType: 'trade.loss_attribution_classified',
        summary: `Loss attribution classified for order ${localOrderId}.`,
        marketId: market.id,
        signalId: signal.id,
        orderId: localOrderId,
        payload: {
          lossAttribution,
          alphaAttribution,
          retainedEdgeExpectation: realizedRetentionDiagnostics,
          toxicity,
          liveSizingFeedback,
        },
      });

      if (submitSucceeded) {
        submitted += 1;
      } else {
        if (terminalRejectReason) {
          await this.rejectSignal(signal.id, terminalRejectReason);
        }
        rejected += 1;
      }
    }

    this.logger.debug('Order execution cycle complete.', {
      submitted,
      rejected,
      operatingMode,
      liveExecutionEnabled: appEnv.BOT_LIVE_EXECUTION_ENABLED,
    });

    return { submitted, rejected };
  }

  private async rejectSignal(signalId: string, reasonCode: string): Promise<void> {
    await this.prisma.signal.update({
      where: { id: signalId },
      data: { status: 'rejected' },
    });

    await this.prisma.signalDecision.create({
      data: {
        id: randomUUID(),
        signalId,
        verdict: 'rejected',
        reasonCode,
        reasonMessage: reasonCode,
        expectedEv: null,
        positionSize: null,
        decisionAt: new Date(),
      },
    });
  }

  private async simulateSentinelTrade(input: {
    signal: {
      id: string;
      marketId: string;
      strategyVersionId: string | null;
      regime: string | null;
    };
    market: {
      id: string;
    };
    tokenId: string;
    strategyVariantId: string;
    orderPlan: {
      side: 'BUY' | 'SELL';
      expectedFillProbability: number | null;
      expectedFillFraction: number | null;
      expectedQueueDelayMs: number | null;
      recommendedOrderStyleRationale?: unknown[];
    };
    feeModel: {
      netFeeBps: number;
    };
    executionPlannerAssumptions: {
      slippageEstimate?: {
        finalExpectedSlippageBps?: number | null;
      } | null;
    };
    executionAdjustedEdge: number;
    slippage: {
      expectedSlippage: number;
    };
    makerQuality: unknown;
  }): Promise<void> {
    await this.sentinelStateStore.ensureBaselineKnowledge('sentinel_simulation');
    const previousReadiness = await this.sentinelStateStore.readLatestReadiness();
    const trade = this.sentinelTradeSimulator.simulate({
      signalId: input.signal.id,
      marketId: input.market.id,
      tokenId: input.tokenId,
      strategyVersionId: input.signal.strategyVersionId,
      strategyVariantId: input.strategyVariantId,
      regime: input.signal.regime,
      side: input.orderPlan.side,
      operatingMode: 'sentinel_simulation',
      expectedFillProbability: input.orderPlan.expectedFillProbability,
      expectedFillFraction: input.orderPlan.expectedFillFraction,
      expectedQueueDelayMs: input.orderPlan.expectedQueueDelayMs,
      expectedFeeBps: input.feeModel.netFeeBps,
      expectedSlippageBps:
        input.executionPlannerAssumptions.slippageEstimate?.finalExpectedSlippageBps ??
        input.slippage.expectedSlippage * 10_000,
      expectedNetEdgeAfterCostsBps: input.executionAdjustedEdge * 10_000,
      rationale: (input.orderPlan.recommendedOrderStyleRationale ?? []).map((value) =>
        typeof value === 'string'
          ? value
          : value && typeof value === 'object' && 'reasonCode' in value
            ? String((value as { reasonCode?: unknown }).reasonCode ?? 'sentinel_style')
            : 'sentinel_style',
      ),
      evidenceRefs: [this.sentinelStateStore.getPaths().tradesPath],
    });
    await this.sentinelStateStore.appendSimulatedTrade(trade);
    await this.decisionLogService.recordSentinelTradeEvidence({ trade });
    await this.prisma.auditEvent.create({
      data: {
        marketId: input.market.id,
        signalId: input.signal.id,
        eventType: 'sentinel.trade_simulated',
        message: 'Trade was simulated through sentinel mode.',
        metadata: {
          operatingMode: 'sentinel_simulation',
          sentinelTrade: trade,
          makerQuality: input.makerQuality,
        } as object,
      },
    });
    await this.sentinelLearningService.learnFromTrade(trade);
    const readiness = await this.sentinelReadinessService.recompute('sentinel_simulation');
    await this.decisionLogService.recordSentinelRecommendationTransition({
      previous: previousReadiness,
      next: readiness,
    });
  }

  private resolveExecutionIntent(
    signal: unknown,
    market: unknown,
  ): ResolvedExecutionIntent | null {
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

    return {
      tokenId: resolution.resolved.tokenId,
      outcome: resolution.resolved.outcome,
      action: resolution.resolved.intent as ExecutionAction,
      venueSide: resolution.resolved.venueSide,
      inventoryEffect:
        resolution.resolved.inventoryEffect === 'INCREASE'
          ? 'increase'
          : 'decrease',
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

  private readDateField(source: unknown, key: string): Date | null {
    if (!source || typeof source !== 'object') {
      return null;
    }

    const value = (source as Record<string, unknown>)[key];
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    if (typeof value === 'string' || typeof value === 'number') {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    return null;
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
          this.readDateField(diagnostic, 'capturedAt')?.toISOString() ??
          new Date(0).toISOString(),
      }));
  }

  private averageExecutionDrift(
    diagnostics: unknown[],
    strategyVersionId: string | null,
    regime: string | null,
  ): number | null {
    const values = (diagnostics ?? [])
      .filter(
        (diagnostic) =>
          (strategyVersionId == null ||
            this.readStringField(diagnostic, 'strategyVersionId') === strategyVersionId) &&
          (regime == null || this.readStringField(diagnostic, 'regime') === regime),
      )
      .map((diagnostic) => this.readNumberField(diagnostic, 'evDrift'))
      .filter((value): value is number => value != null && Number.isFinite(value));

    if (values.length === 0) {
      return null;
    }

    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  private readLatestAlphaAttributionReview(auditEvents: unknown[]): {
    averageRetentionRatio: number | null;
    realizedVsExpected: number | null;
  } | null {
    const candidate = [...(auditEvents ?? [])]
      .filter((event) => this.readStringField(event, 'eventType') === 'learning.alpha_attribution_review')
      .sort((left, right) => {
        const leftTime = this.readDateField(left, 'createdAt')?.getTime() ?? Number.NEGATIVE_INFINITY;
        const rightTime =
          this.readDateField(right, 'createdAt')?.getTime() ?? Number.NEGATIVE_INFINITY;
        return rightTime - leftTime;
      })[0];

    if (!candidate || typeof candidate !== 'object') {
      return null;
    }

    const metadata =
      'metadata' in candidate && candidate.metadata && typeof candidate.metadata === 'object'
        ? (candidate.metadata as Record<string, unknown>)
        : {};
    const averageExpectedNetEdge =
      typeof metadata.averageExpectedNetEdge === 'number' &&
      Number.isFinite(metadata.averageExpectedNetEdge)
        ? metadata.averageExpectedNetEdge
        : null;
    const averageRealizedNetEdge =
      typeof metadata.averageRealizedNetEdge === 'number' &&
      Number.isFinite(metadata.averageRealizedNetEdge)
        ? metadata.averageRealizedNetEdge
        : null;
    const averageRetentionRatio =
      typeof metadata.averageRetentionRatio === 'number' &&
      Number.isFinite(metadata.averageRetentionRatio)
        ? metadata.averageRetentionRatio
        : null;

    return {
      averageRetentionRatio,
      realizedVsExpected:
        averageExpectedNetEdge != null && Math.abs(averageExpectedNetEdge) > 1e-9
          ? (averageRealizedNetEdge ?? 0) / averageExpectedNetEdge
          : null,
    };
  }

  private selectRecentToxicityHistory(
    auditEvents: unknown[],
    marketId: string,
  ): ToxicityTrendPoint[] {
    const entries = (auditEvents ?? [])
      .map((event) => this.extractToxicityHistoryEntry(event))
      .filter(
        (
          entry,
        ): entry is ToxicityTrendPoint & {
          marketId: string | null;
        } => entry != null,
      );
    const byMarket = entries.filter((entry) => entry.marketId === marketId);
    const selected = byMarket.length >= 3 ? byMarket : entries;
    return selected.slice(0, 8).map((entry) => ({
      toxicityScore: entry.toxicityScore,
      toxicityState: entry.toxicityState,
      recommendedAction: entry.recommendedAction,
      capturedAt: entry.capturedAt,
    }));
  }

  private extractToxicityHistoryEntry(
    event: unknown,
  ): (ToxicityTrendPoint & { marketId: string | null }) | null {
    if (!event || typeof event !== 'object') {
      return null;
    }

    const record = event as Record<string, unknown>;
    const metadata =
      record.metadata && typeof record.metadata === 'object'
        ? (record.metadata as Record<string, unknown>)
        : null;
    const toxicity =
      metadata?.toxicity && typeof metadata.toxicity === 'object'
        ? (metadata.toxicity as Record<string, unknown>)
        : null;
    const toxicityScore =
      toxicity && typeof toxicity.toxicityScore === 'number' ? toxicity.toxicityScore : null;
    if (toxicityScore == null) {
      return null;
    }

    return {
      toxicityScore,
      toxicityState:
        toxicity && typeof toxicity.toxicityState === 'string'
          ? toxicity.toxicityState
          : null,
      recommendedAction:
        toxicity && typeof toxicity.recommendedAction === 'string'
          ? toxicity.recommendedAction
          : null,
      capturedAt: this.readDateField(event, 'createdAt')?.toISOString() ?? null,
      marketId: this.readStringField(event, 'marketId'),
    };
  }

  private readUpstreamEvaluationEvidence(
    record: Awaited<ReturnType<VersionLineageRegistry['getLatestForSignalDecision']>>,
  ): {
    alphaAttribution: {
      expectedNetEdge: number | null;
      paperEdge: number | null;
    } | null;
    marketArchetype: string | null;
    toxicityState: string | null;
  } {
    const bundle =
      record?.replay?.activeParameterBundle &&
      typeof record.replay.activeParameterBundle === 'object'
        ? (record.replay.activeParameterBundle as Record<string, unknown>)
        : null;
    const alpha =
      bundle?.alphaAttribution && typeof bundle.alphaAttribution === 'object'
        ? (bundle.alphaAttribution as Record<string, unknown>)
        : null;
    const upstream =
      bundle?.upstreamSignalBuildEvidence &&
      typeof bundle.upstreamSignalBuildEvidence === 'object'
        ? (bundle.upstreamSignalBuildEvidence as Record<string, unknown>)
        : null;
    const retained =
      bundle?.retainedEdgeExpectation &&
      typeof bundle.retainedEdgeExpectation === 'object'
        ? (bundle.retainedEdgeExpectation as Record<string, unknown>)
        : null;

    return {
      alphaAttribution: alpha
        ? {
            expectedNetEdge: this.readNumberField(alpha, 'expectedNetEdge'),
            paperEdge: this.readNumberField(alpha, 'paperEdge'),
          }
        : null,
      marketArchetype:
        this.readStringField(retained, 'marketArchetype') ??
        this.readStringField(upstream, 'marketArchetype'),
      toxicityState:
        this.readStringField(retained, 'toxicityState') ??
        this.readStringField(upstream, 'toxicityState'),
    };
  }

  private buildRetentionDiagnostics(input: {
    upstreamExpectedNetEdge: number | null;
    executionAdjustedEdge: number | null;
    realizedNetEdge?: number | null;
    marketArchetype: string | null;
    toxicityState: string | null;
  }): {
    upstreamExpectedNetEdge: number | null;
    currentExpectedNetEdge: number | null;
    realizedNetEdge: number | null;
    expectedRetentionRatio: number | null;
    realizedRetentionRatio: number | null;
    marketArchetype: string | null;
    toxicityState: string | null;
    reasonCodes: string[];
  } {
    const expectedRetentionRatio =
      input.upstreamExpectedNetEdge != null &&
      Math.abs(input.upstreamExpectedNetEdge) > 1e-9 &&
      input.executionAdjustedEdge != null
        ? input.executionAdjustedEdge / input.upstreamExpectedNetEdge
        : null;
    const realizedRetentionRatio =
      input.upstreamExpectedNetEdge != null &&
      Math.abs(input.upstreamExpectedNetEdge) > 1e-9 &&
      input.realizedNetEdge != null
        ? input.realizedNetEdge / input.upstreamExpectedNetEdge
        : null;
    const reasonCodes: string[] = [];
    if (expectedRetentionRatio != null && expectedRetentionRatio < 0.35) {
      reasonCodes.push('retained_edge_expectation_not_met');
    }
    if (realizedRetentionRatio != null && realizedRetentionRatio < 0.5) {
      reasonCodes.push('realized_retention_below_expectation');
    }
    return {
      upstreamExpectedNetEdge: input.upstreamExpectedNetEdge,
      currentExpectedNetEdge: input.executionAdjustedEdge,
      realizedNetEdge: input.realizedNetEdge ?? null,
      expectedRetentionRatio,
      realizedRetentionRatio,
      marketArchetype: input.marketArchetype,
      toxicityState: input.toxicityState,
      reasonCodes,
    };
  }

  private estimateExpectedFillRate(input: {
    route: string;
    executionStyle: string;
    orderType: string;
    partialFillTolerance: string | null;
  }): number {
    let expectedFillRate = 0.78;
    if (input.route === 'cross') {
      expectedFillRate += 0.14;
    }
    if (input.executionStyle === 'cross') {
      expectedFillRate += 0.04;
    }
    if (input.orderType === 'FOK') {
      expectedFillRate -= 0.16;
    }
    if (input.orderType === 'FAK') {
      expectedFillRate -= 0.05;
    }
    if (input.partialFillTolerance === 'none') {
      expectedFillRate -= 0.08;
    }
    if (input.partialFillTolerance === 'aggressive') {
      expectedFillRate += 0.03;
    }
    return Math.max(0.15, Math.min(0.98, expectedFillRate));
  }

  private resolveCalibrationForSignal(
    learningState: Awaited<ReturnType<LearningStateStore['load']>>,
    strategyVariantId: string,
    regime: string | null,
  ) {
    return (
      Object.values(learningState.calibration).find(
        (candidate) =>
          candidate.strategyVariantId === strategyVariantId && candidate.regime === regime,
      ) ??
      Object.values(learningState.calibration).find(
        (candidate) =>
          candidate.strategyVariantId === strategyVariantId && candidate.regime == null,
      ) ??
      null
    );
  }

  private resolveRegimeSnapshot(
    learningState: Awaited<ReturnType<LearningStateStore['load']>>,
    strategyVariantId: string,
    regime: string | null,
  ) {
    const variant = learningState.strategyVariants[strategyVariantId] ?? null;
    if (!variant) {
      return null;
    }

    const matching = Object.values(variant.regimeSnapshots)
      .filter((snapshot) => snapshot.regime === regime)
      .sort((left, right) => right.sampleCount - left.sampleCount);
    return matching[0] ?? null;
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

  private clampPrice(price: number): number {
    if (!Number.isFinite(price)) {
      return 0;
    }

    return Math.min(0.999, Math.max(0.001, price));
  }

  private buildExecutionToxicity(input: {
    signalAgeMs: number;
    signal: {
      regime: string | null;
      observedAt: Date;
    };
    orderbook: {
      bestBid: number | null;
      bestAsk: number | null;
      spread: number | null;
      bidLevels: unknown;
      askLevels: unknown;
    };
    expiryAt: Date;
    recentToxicityHistory: ToxicityTrendPoint[];
  }) {
    const bidDepth = this.topLevelDepth(input.orderbook, 'SELL');
    const askDepth = this.topLevelDepth(input.orderbook, 'BUY');
    const totalDepth = bidDepth + askDepth;
    const spread = Math.max(0, input.orderbook.spread ?? 0);
    const imbalance =
      totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : 0;
    const flowIntensity = clamp01(spread / 0.04 + Math.abs(imbalance) * 0.5);
    const micropriceBias = imbalance * clamp01(spread / 0.02);

    return this.toxicityPolicy.evaluate({
      features: {
        lastReturnPct: imbalance * 0.002,
        rollingReturnPct: imbalance * 0.001,
        micropriceBias,
        flowImbalanceProxy: imbalance,
        flowIntensity,
        btcMoveTransmission: 0,
        signalDecayPressure: clamp01(
          input.signalAgeMs / Math.max(appEnv.BOT_MAX_SIGNAL_AGE_MS, 1),
        ),
        bookUpdateStress: clamp01(spread / 0.05),
        orderbookNoiseScore: clamp01(spread / 0.06),
        spread,
        spreadToDepthRatio: spread / Math.max(1, totalDepth),
        topLevelDepth: Math.max(bidDepth, askDepth),
        timeToExpirySeconds: Math.max(
          0,
          Math.floor((new Date(input.expiryAt).getTime() - Date.now()) / 1000),
        ),
        marketStateTransition: spread >= 0.03 ? 'stress_transition' : 'range_balance',
      },
      regimeLabel: input.signal.regime,
      signalAgeMs: input.signalAgeMs,
      recentHistory: input.recentToxicityHistory,
    });
  }

  private normalizeVenueStatus(status: string | null): string {
    const normalized = (status ?? '').toLowerCase();
    if (normalized.includes('part')) {
      return 'partially_filled';
    }
    if (normalized.includes('fill')) {
      return 'filled';
    }
    if (normalized.includes('cancel')) {
      return 'canceled';
    }
    if (normalized.includes('ack')) {
      return 'acknowledged';
    }
    if (normalized.includes('reject')) {
      return 'rejected';
    }
    return 'submitted';
  }

  private executionUrgency(
    expiryAt: Date | string,
    noTradeWindowSeconds: number,
  ): 'low' | 'medium' | 'high' {
    const expiryTs = new Date(expiryAt).getTime();
    if (!Number.isFinite(expiryTs)) {
      return 'medium';
    }

    const secondsToExpiry = Math.floor((expiryTs - Date.now()) / 1000);
    if (secondsToExpiry <= noTradeWindowSeconds + 20) {
      return 'high';
    }
    if (secondsToExpiry <= noTradeWindowSeconds + 90) {
      return 'medium';
    }
    return 'low';
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

  private normalizePositiveNumber(value: number | null | undefined): number | null {
    return Number.isFinite(value) && (value as number) > 0 ? (value as number) : null;
  }

  private quantizeToTick(price: number, tickSize: number): number {
    const rounded = Math.round(price / tickSize) * tickSize;
    return Number(rounded.toFixed(this.decimalPlaces(tickSize)));
  }

  private isOnTick(price: number, tickSize: number): boolean {
    const scaled = price / tickSize;
    return Math.abs(scaled - Math.round(scaled)) <= 1e-9;
  }

  private decimalPlaces(value: number): number {
    const asString = value.toString();
    const idx = asString.indexOf('.');
    return idx === -1 ? 0 : asString.length - idx - 1;
  }

  private async assessExecutionReadiness(): Promise<{
    ready: boolean;
    reasonCode: string | null;
  }> {
    const prismaAny = this.prisma as any;
    const [freshness, runtimeStatus] = await Promise.all([
      this.runtimeControl.assessOperationalFreshness(),
      prismaAny.botRuntimeStatus?.findUnique
        ? prismaAny.botRuntimeStatus.findUnique({ where: { id: 'live' } })
        : Promise.resolve(null),
    ]);

    if (!freshness.healthy) {
      return {
        ready: false,
        reasonCode: freshness.reasonCode,
      };
    }

    if (!runtimeStatus?.lastHeartbeatAt) {
      return {
        ready: false,
        reasonCode: 'runtime_heartbeat_missing',
      };
    }

    const heartbeatMaxAgeMs = Math.max(appEnv.BOT_PORTFOLIO_REFRESH_INTERVAL_MS * 2, 15_000);
    const heartbeatAgeMs = Date.now() - new Date(runtimeStatus.lastHeartbeatAt).getTime();
    if (heartbeatAgeMs > heartbeatMaxAgeMs) {
      return {
        ready: false,
        reasonCode: 'runtime_heartbeat_stale',
      };
    }

    return {
      ready: true,
      reasonCode: null,
    };
  }

  private async resolveVenueFeeSnapshot(tokenId: string): Promise<{
    feeRateBps: number;
    fetchedAt: string;
  } | null> {
    if (this.shouldSkipVenueSemanticsLookups()) {
      return null;
    }

    try {
      const feeRate = await this.tradingClient.getFeeRate(tokenId);
      return {
        feeRateBps: feeRate.feeRateBps,
        fetchedAt: feeRate.fetchedAt,
      };
    } catch {
      return null;
    }
  }

  private async resolveVenueRewardsMarkets(): Promise<VenueRewardMarket[]> {
    if (this.shouldSkipVenueSemanticsLookups()) {
      return [];
    }

    try {
      return await this.tradingClient.getCurrentRewards();
    } catch {
      return [];
    }
  }

  private shouldSkipVenueSemanticsLookups(): boolean {
    return (
      appEnv.IS_TEST ||
      /(^https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?$/i.test(appEnv.POLY_CLOB_HOST.trim())
    );
  }

  private async resolveIntentEpoch(signalId: string): Promise<number> {
    const prismaAny = this.prisma as any;
    if (!signalId || !prismaAny.order?.count) {
      return 0;
    }

    return prismaAny.order.count({
      where: {
        signalId,
        status: 'canceled',
      },
    });
  }

  private shouldBlockIntentReplay(
    priorIntent: PersistedOrderIntentRecord | null,
  ): boolean {
    return priorIntent !== null;
  }

  private normalizeVenueError(error: unknown): PolymarketNormalizedVenueError | null {
    if (error instanceof PolymarketVenueError) {
      return error.normalized;
    }
    if (
      error &&
      typeof error === 'object' &&
      'normalized' in error &&
      (error as Record<string, unknown>).normalized &&
      typeof (error as Record<string, unknown>).normalized === 'object'
    ) {
      return (error as { normalized: PolymarketNormalizedVenueError }).normalized;
    }
    return null;
  }

  private isUncertainSubmitError(
    normalized: PolymarketNormalizedVenueError | null,
  ): boolean {
    return (
      normalized?.reasonCode === 'rate_limited' ||
      normalized?.reasonCode === 'network_unavailable' ||
      normalized?.reasonCode === 'server_unavailable' ||
      normalized?.reasonCode === 'venue_unknown_error'
    );
  }

  private async applyOperationalDecision(
    normalized: PolymarketNormalizedVenueError | null,
  ): Promise<void> {
    if (!normalized) {
      return;
    }

    const recentRejectCount = await this.countRecentOperationalRejects(
      normalized.reasonCode,
    );
    const decision = this.operationalPolicy.evaluate({
      reasonCode: normalized.reasonCode,
      recentRejectCount,
    });

    if (!decision.transitionTo) {
      return;
    }

    await this.runtimeControl.updateRuntimeStatus(
      decision.transitionTo,
      decision.reasonCode,
    );
    await this.prisma.auditEvent.create({
      data: {
        eventType: 'runtime.operational_transition',
        message: 'Venue operational policy forced a runtime transition.',
        metadata: {
          normalized,
          decision,
          recentRejectCount,
        } as object,
      },
    });
  }

  private async countRecentOperationalRejects(reasonCode: string): Promise<number> {
    const prismaAny = this.prisma as any;
    if (!prismaAny.auditEvent?.count) {
      return 0;
    }

    return prismaAny.auditEvent.count({
      where: {
        eventType: 'order.rejected_on_submit',
        createdAt: {
          gte: new Date(Date.now() - 5 * 60 * 1000),
        },
      },
    }).then((count: number) =>
      reasonCode === 'venue_validation_failed' ? count : 1,
    );
  }

  private reasonCodeFromVenueStatus(status: string | null): string {
    const searchable = (status ?? '').toLowerCase();
    if (searchable.includes('closed')) {
      return 'venue_closed_only';
    }
    if (searchable.includes('geo')) {
      return 'venue_geoblocked';
    }
    if (searchable.includes('auth')) {
      return 'auth_failed';
    }
    if (searchable.includes('clock') || searchable.includes('time')) {
      return 'clock_skew_detected';
    }
    return 'venue_submit_rejected';
  }
}

function createDefaultVenueHealthLearningStore(
  learningStateStore?: LearningStateStore | null,
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

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}
