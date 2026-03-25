import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { AppLogger } from '@worker/common/logger';
import { appEnv } from '@worker/config/env';
import { BotRuntimeState } from '@worker/runtime/bot-state';
import { permissionsForRuntimeState } from '@worker/runtime/runtime-state-machine';
import { BtcReferenceSnapshot } from './syncBtcReference.job';
import {
  FeatureBuilder,
  SignalFeatures,
  type ToxicityTrendPoint,
} from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { BtcFiveMinuteTradeableUniverse } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { MarketEligibilityService } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { PriorModel } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { PosteriorUpdate } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { RegimeClassifier } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { RegimeConditionedEdgeModel } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { ExecutableEvModel } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { WalkForwardSample, WalkForwardValidator } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import {
  ExecutableEdgeEstimate,
  TradeAdmissionGate,
} from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { BookFreshnessFilter } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { NoTradeNearExpiryFilter } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { LateWindowFilter } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { SpreadFilter } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { LiquidityFilter } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { VolatilityFilter } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { EdgeDefinitionService } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { EventMicrostructureModel } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { StrategyFamilyPolicy } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { NoTradeZonePolicy } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { EdgeHalfLifePolicy } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { ResearchGovernancePolicy } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { RobustnessSuite } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { MultiObjectivePromotionScore } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { ToxicityPolicy } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { createAlphaAttribution } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import {
  buildStrategyVariantId,
  type LearningState,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { DecisionLogService } from '@worker/runtime/decision-log.service';
import { LearningStateStore } from '@worker/runtime/learning-state-store';
import { StrategyDeploymentRegistry } from '@worker/runtime/strategy-deployment-registry';
import { StrategyRolloutController } from '@worker/runtime/strategy-rollout-controller';
import {
  VersionLineageRegistry,
  buildCalibrationVersionLineage,
  buildFeatureSetVersionLineage,
  buildRiskPolicyVersionLineage,
  buildStrategyVersionLineage,
} from '@worker/runtime/version-lineage-registry';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveCalibrationSnapshot(
  learningState: LearningState,
  strategyVersionId: string,
  regime: string | null,
) {
  const strategyVariantId = buildStrategyVariantId(strategyVersionId);
  const exact = Object.values(learningState.calibration).find(
    (calibration) =>
      calibration.strategyVariantId === strategyVariantId &&
      calibration.regime === regime,
  );
  if (exact) {
    return exact;
  }

  return (
    Object.values(learningState.calibration).find(
      (calibration) =>
        calibration.strategyVariantId === strategyVariantId && calibration.regime == null,
    ) ?? null
  );
}

const MAX_SIGNAL_REBUILD_INTERVAL_MS = 20_000;
const MAX_SIGNAL_SPREAD = 0.06;
const MIN_DEPTH = 25;
const MIN_TOP_LEVEL_DEPTH = 20;
const MIN_REALIZED_VOL = 0.00005;
const MAX_REALIZED_VOL = 0.05;
const MIN_RECENT_TRADE_COUNT = 1;
const DEFAULT_FEE_RATE = 0.005;

export class BuildSignalsJob {
  private readonly logger = new AppLogger('BuildSignalsJob');
  private readonly featureBuilder = new FeatureBuilder();
  private readonly universe = new BtcFiveMinuteTradeableUniverse();
  private readonly marketEligibility = new MarketEligibilityService();
  private readonly priorModel = new PriorModel();
  private readonly posteriorUpdate = new PosteriorUpdate();
  private readonly regimeClassifier = new RegimeClassifier();
  private readonly regimeConditionedEdgeModel = new RegimeConditionedEdgeModel();
  private readonly executableEvModel = new ExecutableEvModel();
  private readonly edgeDefinitionService = new EdgeDefinitionService();
  private readonly microstructureModel = new EventMicrostructureModel();
  private readonly strategyFamilyPolicy = new StrategyFamilyPolicy();
  private readonly noTradeZonePolicy = new NoTradeZonePolicy();
  private readonly edgeHalfLifePolicy = new EdgeHalfLifePolicy();
  private readonly researchGovernancePolicy = new ResearchGovernancePolicy();
  private readonly robustnessSuite = new RobustnessSuite();
  private readonly promotionScore = new MultiObjectivePromotionScore();
  private readonly toxicityPolicy = new ToxicityPolicy();
  private readonly walkForwardValidator = new WalkForwardValidator();
  private readonly tradeAdmissionGate = new TradeAdmissionGate();
  private readonly bookFreshnessFilter = new BookFreshnessFilter();
  private readonly noTradeNearExpiryFilter = new NoTradeNearExpiryFilter();
  private readonly lateWindowFilter = new LateWindowFilter();
  private readonly spreadFilter = new SpreadFilter();
  private readonly liquidityFilter = new LiquidityFilter();
  private readonly volatilityFilter = new VolatilityFilter();
  private readonly decisionLogService: DecisionLogService;
  private readonly strategyDeploymentRegistry: StrategyDeploymentRegistry;
  private readonly strategyRolloutController = new StrategyRolloutController();
  private readonly learningStateStore: LearningStateStore;
  private readonly versionLineageRegistry: VersionLineageRegistry;

  constructor(
    private readonly prisma: PrismaClient,
    strategyDeploymentRegistry?: StrategyDeploymentRegistry,
    learningStateStore?: LearningStateStore,
    versionLineageRegistry?: VersionLineageRegistry,
  ) {
    this.decisionLogService = new DecisionLogService(prisma);
    this.strategyDeploymentRegistry =
      strategyDeploymentRegistry ?? new StrategyDeploymentRegistry();
    this.learningStateStore = learningStateStore ?? new LearningStateStore();
    this.versionLineageRegistry =
      versionLineageRegistry ?? new VersionLineageRegistry();
  }

  async run(
    btcReference: BtcReferenceSnapshot | null,
    options?: { runtimeState?: BotRuntimeState },
  ): Promise<{ created: number }> {
    if (
      options?.runtimeState &&
      !permissionsForRuntimeState(options.runtimeState).allowStrategyEvaluation
    ) {
      return { created: 0 };
    }

    if (!btcReference || btcReference.candles.length < 3) {
      return { created: 0 };
    }

    const snapshotAgeMs = Date.now() - new Date(btcReference.observedAt).getTime();
    if (snapshotAgeMs > appEnv.BOT_MAX_BTC_SNAPSHOT_AGE_MS) {
      this.logger.warn('Skipping signal build due to stale BTC snapshot.', {
        snapshotAgeMs,
      });
      return { created: 0 };
    }

    const strategyVersionModel = (this.prisma as any).strategyVersion;
    const strategyVersions = strategyVersionModel?.findMany
      ? ((await strategyVersionModel.findMany({
          orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
        })) as Array<{ id: string; isActive: boolean; updatedAt: Date }>)
      : strategyVersionModel?.findFirst
        ? [await strategyVersionModel.findFirst({
            where: {
              isActive: true,
            },
            orderBy: {
              updatedAt: 'desc',
            },
          })].filter(Boolean)
        : [];
    const strategyVersionById = new Map(
      strategyVersions.map((version) => [version.id, version]),
    );
    const deploymentRegistry = await this.strategyDeploymentRegistry.load();
    const configuredIncumbentStrategyVersionId =
      deploymentRegistry.incumbentVariantId != null
        ? deploymentRegistry.variants[deploymentRegistry.incumbentVariantId]?.strategyVersionId ??
          null
        : null;
    const activeStrategyVersion =
      (configuredIncumbentStrategyVersionId
        ? strategyVersionById.get(configuredIncumbentStrategyVersionId)
        : null) ??
      strategyVersions.find((version) => version.isActive) ??
      strategyVersions[0] ??
      null;

    if (!activeStrategyVersion) {
      this.logger.warn(
        'Skipping signal build because no active strategy version is configured.',
      );
      return { created: 0 };
    }

    const markets = await this.prisma.market.findMany({
      where: { status: 'active' },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    const prismaAny = this.prisma as any;
    const recentAuditEvents = prismaAny.auditEvent?.findMany
      ? ((await prismaAny.auditEvent.findMany({
          orderBy: { createdAt: 'desc' },
          take: 120,
        })) as unknown[])
      : [];

    let created = 0;
    const now = new Date();
    const learningState = await this.learningStateStore.load();

    for (const market of markets) {
      const yesTokenId = market.tokenIdYes ?? market.tokenIdNo;
      if (!yesTokenId) {
        continue;
      }

      const latestOrderbook = await this.prisma.orderbook.findFirst({
        where: {
          marketId: market.id,
          tokenId: yesTokenId,
        },
        orderBy: { observedAt: 'desc' },
      });

      if (!latestOrderbook) {
        continue;
      }

      const latestSnapshot = await this.prisma.marketSnapshot.findFirst({
        where: {
          marketId: market.id,
        },
        orderBy: { observedAt: 'desc' },
      });

      if (!latestSnapshot) {
        continue;
      }

      const freshnessCheck = this.bookFreshnessFilter.evaluate({
        observedAt: new Date(latestOrderbook.observedAt).toISOString(),
        maxAgeMs: appEnv.BOT_MAX_ORDERBOOK_AGE_MS,
        now: now.toISOString(),
      });
      if (!freshnessCheck.passed) {
        continue;
      }

      const latestSignal = await this.prisma.signal.findFirst({
        where: { marketId: market.id },
        orderBy: { observedAt: 'desc' },
      });

      if (
        latestSignal &&
        now.getTime() - new Date(latestSignal.observedAt).getTime() <
          MAX_SIGNAL_REBUILD_INTERVAL_MS
      ) {
        continue;
      }

      const orderbook = this.normalizeOrderbook(latestOrderbook);
      if (!orderbook) {
        continue;
      }

      const features = this.featureBuilder.build({
        candles: {
          symbol: btcReference.symbol,
          timeframe: '5m',
          candles: btcReference.candles,
        },
        orderbook,
        expiresAt: market.expiresAt ? new Date(market.expiresAt).toISOString() : null,
      });
      const strategyAssignment = this.strategyRolloutController.resolveSignalAssignment(
        deploymentRegistry,
        {
          marketId: market.id,
          observedAt: now.toISOString(),
        },
      );
      const selectedStrategyVersion =
        (strategyAssignment.strategyVersionId
          ? strategyVersionById.get(strategyAssignment.strategyVersionId)
          : null) ??
        (deploymentRegistry.incumbentVariantId == null ? activeStrategyVersion : null);
      if (!selectedStrategyVersion) {
        continue;
      }
      const regime = this.regimeClassifier.classify(features);
      const toxicity = this.toxicityPolicy.evaluate({
        features,
        regimeLabel: regime.label,
        structuralToxicityBias: regime.toxicityBias,
        signalAgeMs: 0,
        recentHistory: this.selectRecentToxicityHistory(recentAuditEvents, market.id),
      });

      const expiryCheck = this.noTradeNearExpiryFilter.evaluate({
        timeToExpirySeconds: features.timeToExpirySeconds,
        blockedWindowSeconds: appEnv.NO_TRADE_WINDOW_SECONDS,
      });
      const lateWindowCheck = this.lateWindowFilter.evaluate({
        timeToExpirySeconds: features.timeToExpirySeconds,
        minimumRequiredSeconds: appEnv.NO_TRADE_WINDOW_SECONDS + 5,
      });
      const spreadCheck = this.spreadFilter.evaluate({
        spread: features.spread,
        maxSpread: MAX_SIGNAL_SPREAD,
      });
      const liquidityCheck = this.liquidityFilter.evaluate({
        bidDepth: features.bidDepth,
        askDepth: features.askDepth,
        minDepth: MIN_DEPTH,
      });
      const volatilityCheck = this.volatilityFilter.evaluate({
        realizedVolatility: features.realizedVolatility,
        minVolatility: MIN_REALIZED_VOL,
        maxVolatility: MAX_REALIZED_VOL,
      });
      const universeDecision = this.universe.assessContinuation({
        market: {
          id: market.id,
          slug: market.slug,
          title: market.title,
          question: market.title,
          active: market.status === 'active',
          closed: market.status === 'closed',
          tradable: true,
          tokenIdYes: market.tokenIdYes,
          tokenIdNo: market.tokenIdNo,
          expiresAt: market.expiresAt ? new Date(market.expiresAt).toISOString() : null,
          negativeRisk:
            ((latestOrderbook as unknown as Record<string, unknown>).negRisk as
              | boolean
              | undefined) ?? false,
        },
        spread: orderbook.spread,
        bidDepth: features.bidDepth,
        askDepth: features.askDepth,
        topLevelDepth: features.topLevelDepth,
        orderbookObservedAt: new Date(latestOrderbook.observedAt).toISOString(),
        marketObservedAt: new Date(latestSnapshot.observedAt).toISOString(),
        recentTradeCount: this.estimateRecentTradeCount(latestSnapshot.volume),
        maxOrderbookAgeMs: appEnv.BOT_MAX_ORDERBOOK_AGE_MS,
        maxMarketAgeMs: appEnv.BOT_MAX_MARKET_SNAPSHOT_AGE_MS,
        noTradeWindowSeconds: appEnv.NO_TRADE_WINDOW_SECONDS,
        minCombinedDepth: MIN_DEPTH * 2,
        minTopLevelDepth: MIN_TOP_LEVEL_DEPTH,
        maxSpread: MAX_SIGNAL_SPREAD,
        minRecentTradeCount: MIN_RECENT_TRADE_COUNT,
      });
      const eligibility = this.marketEligibility.evaluate({
        market: {
          id: market.id,
          slug: market.slug,
          title: market.title,
          question: market.title,
          active: market.status === 'active',
          closed: market.status === 'closed',
          tradable: true,
          tokenIdYes: market.tokenIdYes,
          tokenIdNo: market.tokenIdNo,
          expiresAt: market.expiresAt ? new Date(market.expiresAt).toISOString() : null,
          negativeRisk:
            ((latestOrderbook as unknown as Record<string, unknown>).negRisk as
              | boolean
              | undefined) ?? false,
          enableOrderBook: true,
        },
        spread: orderbook.spread,
        bidDepth: features.bidDepth,
        askDepth: features.askDepth,
        topLevelDepth: features.topLevelDepth,
        tickSize:
          ((latestOrderbook as unknown as Record<string, unknown>).tickSize as
            | number
            | null
            | undefined) ?? null,
        orderbookObservedAt: new Date(latestOrderbook.observedAt).toISOString(),
        marketObservedAt: new Date(latestSnapshot.observedAt).toISOString(),
        recentTradeCount: this.estimateRecentTradeCount(latestSnapshot.volume),
        maxOrderbookAgeMs: appEnv.BOT_MAX_ORDERBOOK_AGE_MS,
        maxMarketAgeMs: appEnv.BOT_MAX_MARKET_SNAPSHOT_AGE_MS,
        noTradeWindowSeconds: appEnv.NO_TRADE_WINDOW_SECONDS,
      });

      const edgeDefinition = this.edgeDefinitionService.getDefinition();
      const prior = this.priorModel.evaluate(features, regime);
      const posterior = this.posteriorUpdate.apply({
        priorProbability: prior.probabilityUp,
        features,
        regime,
        toxicityPenalty: toxicity.posteriorPenalty,
      });
      const marketImpliedProb = this.marketImpliedProbability(orderbook);
      const microstructure = this.microstructureModel.derive({
        features,
        posteriorProbability: posterior.posteriorProbability,
        marketImpliedProbability: marketImpliedProb,
      });
      const strategyFamily = this.strategyFamilyPolicy.classify({
        regime,
        features,
        microstructure,
      });
      const edge = this.regimeConditionedEdgeModel.evaluate({
        priorProbability: prior.probabilityUp,
        posteriorProbability: posterior.posteriorProbability,
        marketImpliedProbability: marketImpliedProb,
        features,
        regime,
      });
      const executableEv = this.executableEvModel.calculate({
        directionalEdge: Math.abs(edge.edge),
        rawDirectionalEdge: Math.abs(edge.rawEdge),
        marketImpliedProbability: marketImpliedProb,
        features,
        regime,
        feeRate: DEFAULT_FEE_RATE,
      });
      const walkForward = this.walkForwardValidator.validate({
        samples: this.buildWalkForwardSamples({
          candles: btcReference.candles,
          orderbook,
          expiresAt: market.expiresAt ? new Date(market.expiresAt).toISOString() : null,
          marketImpliedProb,
        }),
      });
      const researchGovernance = this.researchGovernancePolicy.evaluate({
        strategyVersionId: selectedStrategyVersion.id,
        edgeDefinitionVersion: edgeDefinition.version,
        validation: walkForward,
      });
      const robustness = this.robustnessSuite.evaluate({
        realizedVsExpected: walkForward.aggregate.realizedVsExpected,
        worstWindowEv: walkForward.aggregate.worstWindowEv,
        calibrationGap: walkForward.maxCalibrationGap,
        segmentCoverage: walkForward.segmentCoverage,
      });
      const halfLife = this.edgeHalfLifePolicy.evaluate({
        rawEdge: Math.abs(edge.edge),
        signalAgeMs: 0,
        timeToExpirySeconds: features.timeToExpirySeconds,
        microstructure,
      });
      const executableEdge = this.buildExecutableEdgeEstimate({
        edgeDefinitionVersion: edgeDefinition.version,
        rawEdge: Math.abs(edge.rawEdge),
        executableEv,
        features,
        halfLifeMultiplier: halfLife.decayMultiplier,
        freshnessHealthy: freshnessCheck.passed,
        threshold:
          edgeDefinition.admissionThresholdPolicy.minimumNetEdge * toxicity.thresholdMultiplier,
      });
      const signalDirectionSign = edge.edge < 0 ? -1 : 1;
      const phaseTwoContext = {
        flowImbalanceProxy: features.flowImbalanceProxy,
        flowIntensity: features.flowIntensity,
        bookUpdateStress: features.bookUpdateStress,
        btcMoveTransmission: features.btcMoveTransmission,
        btcLinkageConfidence: features.btcLinkageConfidence,
        laggedBtcMoveTransmission: features.laggedBtcMoveTransmission,
        nonlinearBtcMoveSensitivity: features.nonlinearBtcMoveSensitivity,
        btcPathDivergence: features.btcPathDivergence,
        transmissionConsistency: features.transmissionConsistency,
        imbalancePersistence: features.imbalancePersistence,
        imbalanceReversalProbability: features.imbalanceReversalProbability,
        quoteInstabilityBeforeMove: features.quoteInstabilityBeforeMove,
        depthDepletionAsymmetry: features.depthDepletionAsymmetry,
        signalDecayPressure: features.signalDecayPressure,
        marketStateTransition: features.marketStateTransition,
        marketStateTransitionStrength: features.marketStateTransitionStrength,
        marketArchetype: features.marketArchetype,
        marketArchetypeConfidence: features.marketArchetypeConfidence,
        prior,
        posterior,
        regimeReasonCodes: regime.reasonCodes,
      };
      const alphaAttribution = createAlphaAttribution({
        rawForecastProbability: posterior.posteriorProbability,
        marketImpliedProbability: marketImpliedProb,
        confidenceAdjustedEdge: edge.edge,
        paperEdge: signalDirectionSign * halfLife.effectiveEdge,
        expectedExecutionCost: {
          feeCost: executableEv.expectedFee,
          slippageCost: Math.max(0, features.spread) + executableEv.expectedSlippage,
          adverseSelectionCost:
            executableEv.expectedAdverseSelectionCost +
            this.expectedImpact(features) * 0.5,
          fillDecayCost: executableEv.expectedMissedFillCost,
          cancelReplaceOverheadCost: executableEv.expectedCancellationCost,
          missedOpportunityCost: 0,
          venuePenalty: 0,
        },
        expectedNetEdge:
          executableEdge.finalNetEdge != null
            ? signalDirectionSign * executableEdge.finalNetEdge
            : null,
        capturedAt: now.toISOString(),
      });
      const noTradeZone = this.noTradeZonePolicy.evaluate({
        timeToExpirySeconds: features.timeToExpirySeconds,
        noTradeWindowSeconds: appEnv.NO_TRADE_WINDOW_SECONDS,
        btcFresh: snapshotAgeMs <= appEnv.BOT_MAX_BTC_SNAPSHOT_AGE_MS,
        orderbookFresh: freshnessCheck.passed,
        spread: features.spread,
        topLevelDepth: features.topLevelDepth,
        microstructure,
        governanceHealthy: researchGovernance.promotionEligible,
        edgeHalfLifeHealthy: !halfLife.expired,
      });
      const promotion = this.promotionScore.evaluate({
        governanceConfidence: researchGovernance.confidence,
        robustnessScore: robustness.score,
        realizedVsExpected: walkForward.aggregate.realizedVsExpected,
        calibrationGap: walkForward.maxCalibrationGap,
        auditCoverage: 1,
      });
      const admission = this.tradeAdmissionGate.evaluate({
        edgeDefinitionVersion: edgeDefinition.version,
        signalPresent: edge.allowed && strategyFamily.allowed,
        directionalEdge: Math.abs(halfLife.effectiveEdge),
        executableEv: executableEdge.finalNetEdge,
        signalConfidence: Math.min(
          edge.confidence,
          executableEv.confidence,
          strategyFamily.confidence,
        ),
        walkForwardConfidence: walkForward.confidence,
        liquidityHealthy:
          universeDecision.admitted &&
          eligibility.eligible &&
          spreadCheck.passed &&
          liquidityCheck.passed &&
          features.topLevelDepth >= MIN_TOP_LEVEL_DEPTH,
        freshnessHealthy: freshnessCheck.passed,
        venueHealthy: universeDecision.admitted && eligibility.eligible,
        reconciliationHealthy:
          walkForward.sufficientSamples &&
          walkForward.leakagePrevented &&
          walkForward.tradeAllowed &&
          researchGovernance.promotionEligible &&
          robustness.passed &&
          promotion.promoted,
        riskHealthy:
          expiryCheck.passed && lateWindowCheck.passed && volatilityCheck.passed,
        regimeAllowed: regime.tradingAllowed && !toxicity.temporarilyBlockRegime,
        noTradeZoneBlocked: noTradeZone.blocked,
        halfLifeExpired: halfLife.expired,
        paperEdgeDetected:
          (executableEdge.rawModelEdge ?? 0) > executableEdge.threshold &&
          (executableEdge.finalNetEdge ?? 0) <= executableEdge.threshold,
        admissionThreshold: executableEdge.threshold,
        executableEdge,
        minimumConfidence: edgeDefinition.admissionThresholdPolicy.minimumConfidence,
      });

      await this.persistResearchGovernance(selectedStrategyVersion.id, {
        edgeDefinitionVersion: edgeDefinition.version,
        governance: researchGovernance,
        robustness,
        promotion,
      });
      await this.decisionLogService.record({
        category: 'edge',
        eventType: 'signal.edge_assessed',
        summary: `Edge assessed for market ${market.id}.`,
        marketId: market.id,
        payload: {
          edgeDefinition,
          phaseTwoContext,
          toxicity,
          alphaAttribution,
          regime,
          strategyFamily,
          microstructure,
          halfLife,
          executableEdge,
          researchGovernance,
          robustness,
          promotion,
          strategyAssignment,
        },
        createdAt: now.toISOString(),
      });

      if (!admission.admitted) {
        const noTradeDecision = await this.recordNoTradeDecision({
          marketId: market.id,
          strategyVersionId: selectedStrategyVersion.id,
          priorProbability: prior.probabilityUp,
          posteriorProbability: posterior.posteriorProbability,
          marketImpliedProb,
          edge: edge.edge,
          expectedEv: executableEv.expectedEv,
          regime: regime.label,
          observedAt: now,
          reasonCode: admission.reasonCode,
          reasonMessage: [
            admission.reasonMessage,
            `family=${strategyFamily.family}`,
            `noTrade=${noTradeZone.reasons.join('|') || 'none'}`,
          ].join(','),
          marketArchetype: features.marketArchetype,
          marketStateTransition: features.marketStateTransition,
          toxicityState: toxicity.toxicityState,
          expectedRetainedEdge: alphaAttribution.expectedNetEdge,
        });
        const phaseSevenEvidenceTags = [
          `archetype:${features.marketArchetype}`,
          `toxicity:${toxicity.toxicityState}`,
          `transition:${features.marketStateTransition}`,
        ];
        await this.versionLineageRegistry.recordDecision({
          decisionId: noTradeDecision.signalDecisionId ?? noTradeDecision.signalId,
          decisionType: 'signal_build',
          recordedAt: now.toISOString(),
          summary: `Signal build rejected for market ${market.id}.`,
          signalId: noTradeDecision.signalId,
          signalDecisionId: noTradeDecision.signalDecisionId,
          marketId: market.id,
          strategyVariantId:
            strategyAssignment.variantId ??
            buildStrategyVariantId(selectedStrategyVersion.id),
          lineage: {
            strategyVersion: buildStrategyVersionLineage({
              strategyVersionId: selectedStrategyVersion.id,
              strategyVariantId:
                strategyAssignment.variantId ??
                buildStrategyVariantId(selectedStrategyVersion.id),
            }),
            featureSetVersion: buildFeatureSetVersionLineage({
              featureSetId: 'btc-five-minute-core',
              parentStrategyVersionId: selectedStrategyVersion.id,
              parameters: {
                edgeDefinitionVersion: edgeDefinition.version,
                family: strategyFamily.family,
                regimeClassifier: 'RegimeClassifier',
                executableEvModel: 'ExecutableEvModel',
                marketEligibility: 'MarketEligibilityService',
              },
            }),
            calibrationVersion: buildCalibrationVersionLineage(
              resolveCalibrationSnapshot(
                learningState,
                selectedStrategyVersion.id,
                regime.label,
              ),
            ),
            executionPolicyVersion: null,
            riskPolicyVersion: buildRiskPolicyVersionLineage({
              policyId: 'signal-admission',
              parameters: {
                edgeDefinitionVersion: edgeDefinition.version,
                admission,
                noTradeWindowSeconds: appEnv.NO_TRADE_WINDOW_SECONDS,
                toxicity,
              },
            }),
            allocationPolicyVersion: null,
          },
          replay: {
            marketState: {
              market,
              orderbook: latestOrderbook,
              marketSnapshot: latestSnapshot,
              features,
              regime,
              strategyAssignment,
            },
            runtimeState: {
              runtimeState: options?.runtimeState ?? null,
            },
            learningState: {
              lastCycleSummary: learningState.lastCycleSummary,
              calibration: resolveCalibrationSnapshot(
                learningState,
                selectedStrategyVersion.id,
                regime.label,
              ),
            },
            lineageState: {
              incumbentVariantId: deploymentRegistry.incumbentVariantId,
              activeRollout: deploymentRegistry.activeRollout,
            },
            activeParameterBundle: {
              edgeDefinition,
              phaseTwoContext,
              toxicity,
              alphaAttribution,
              admission,
              researchGovernance,
              robustness,
              promotion,
              noTradeZone,
            },
            venueMode: null,
            venueUncertainty: null,
          },
          tags: ['wave5', 'signal-build', 'rejected', ...phaseSevenEvidenceTags],
        });
        await this.decisionLogService.record({
          category: 'admission',
          eventType: 'signal.admission_decision',
          summary: `Signal rejected for market ${market.id}.`,
          marketId: market.id,
          payload: {
            admitted: false,
            reasonCode: admission.reasonCode,
            reasonMessage: admission.reasonMessage,
            phaseTwoContext,
            toxicity,
            alphaAttribution,
            executableEdge: admission.executableEdge,
            strategyFamily,
            noTradeZone,
            researchGovernance,
            robustness,
            strategyAssignment,
          },
          createdAt: now.toISOString(),
        });
        await this.persistWalkForwardDiagnostics(selectedStrategyVersion.id, walkForward);
        continue;
      }

      const signalDirection = edge.edge >= 0 ? 'YES' : 'NO';
      const tokenId =
        signalDirection === 'YES' ? market.tokenIdYes : market.tokenIdNo;
      if (!tokenId) {
        continue;
      }

      const signalId = randomUUID();
      const phaseSevenEvidenceTags = [
        `archetype:${features.marketArchetype}`,
        `toxicity:${toxicity.toxicityState}`,
        `transition:${features.marketStateTransition}`,
      ];
      await (this.prisma as any).signal.create({
        data: {
          id: signalId,
          marketId: market.id,
          strategyVersionId: selectedStrategyVersion.id,
          side: 'BUY',
          tokenId,
          outcome: signalDirection,
          intent: 'ENTER',
          inventoryEffect: 'INCREASE',
          priorProbability: prior.probabilityUp,
          posteriorProbability: posterior.posteriorProbability,
          marketImpliedProb,
          edge: edge.edge,
          expectedEv: executableEv.expectedEv,
          regime: regime.label,
          status: 'created',
          observedAt: now,
        },
      });
      await this.versionLineageRegistry.recordDecision({
        decisionId: signalId,
        decisionType: 'signal_build',
        recordedAt: now.toISOString(),
        summary: `Signal build admitted for market ${market.id}.`,
        signalId,
        marketId: market.id,
        strategyVariantId:
          strategyAssignment.variantId ?? buildStrategyVariantId(selectedStrategyVersion.id),
        lineage: {
          strategyVersion: buildStrategyVersionLineage({
            strategyVersionId: selectedStrategyVersion.id,
            strategyVariantId:
              strategyAssignment.variantId ?? buildStrategyVariantId(selectedStrategyVersion.id),
          }),
          featureSetVersion: buildFeatureSetVersionLineage({
            featureSetId: 'btc-five-minute-core',
            parentStrategyVersionId: selectedStrategyVersion.id,
            parameters: {
              edgeDefinitionVersion: edgeDefinition.version,
              family: strategyFamily.family,
              regimeClassifier: 'RegimeClassifier',
              executableEvModel: 'ExecutableEvModel',
              marketEligibility: 'MarketEligibilityService',
            },
          }),
          calibrationVersion: buildCalibrationVersionLineage(
            resolveCalibrationSnapshot(
              learningState,
              selectedStrategyVersion.id,
              regime.label,
            ),
          ),
          executionPolicyVersion: null,
          riskPolicyVersion: buildRiskPolicyVersionLineage({
            policyId: 'signal-admission',
              parameters: {
                edgeDefinitionVersion: edgeDefinition.version,
                executableEdge: admission.executableEdge,
                noTradeWindowSeconds: appEnv.NO_TRADE_WINDOW_SECONDS,
                toxicity,
              },
            }),
          allocationPolicyVersion: null,
        },
        replay: {
          marketState: {
            market,
            orderbook: latestOrderbook,
            marketSnapshot: latestSnapshot,
            features,
            regime,
            strategyAssignment,
          },
          runtimeState: {
            runtimeState: options?.runtimeState ?? null,
          },
          learningState: {
            lastCycleSummary: learningState.lastCycleSummary,
            calibration: resolveCalibrationSnapshot(
              learningState,
              selectedStrategyVersion.id,
              regime.label,
            ),
          },
          lineageState: {
            incumbentVariantId: deploymentRegistry.incumbentVariantId,
            activeRollout: deploymentRegistry.activeRollout,
          },
          activeParameterBundle: {
              edgeDefinition,
              phaseTwoContext,
              toxicity,
              alphaAttribution,
              admission,
            researchGovernance,
            robustness,
            promotion,
            noTradeZone,
          },
          venueMode: null,
          venueUncertainty: null,
        },
        tags: ['wave5', 'signal-build', 'admitted', ...phaseSevenEvidenceTags],
      });
      await this.decisionLogService.record({
        category: 'admission',
        eventType: 'signal.admission_decision',
        summary: `Signal admitted for market ${market.id}.`,
        marketId: market.id,
        signalId,
        payload: {
          admitted: true,
          phaseTwoContext,
          toxicity,
          alphaAttribution,
          executableEdge: admission.executableEdge,
          strategyFamily,
          noTradeZone,
          researchGovernance,
          robustness,
          promotion,
          strategyAssignment,
        },
        createdAt: now.toISOString(),
      });

      await this.persistWalkForwardDiagnostics(selectedStrategyVersion.id, walkForward);

      created += 1;
    }

    this.logger.debug('Signals built.', {
      created,
    });

    return { created };
  }

  private marketImpliedProbability(orderbook: {
    bestBid: number;
    bestAsk: number;
  }): number {
    return clamp(
      orderbook.bestAsk > 0 ? orderbook.bestAsk : (orderbook.bestBid + orderbook.bestAsk) / 2,
      0.01,
      0.99,
    );
  }

  private expectedImpact(features: SignalFeatures): number {
    const passiveDepth = Math.max(1, Math.min(features.bidDepth, features.askDepth));
    return clamp(1 / (passiveDepth * 20), 0.0005, 0.02);
  }

  private buildWalkForwardSamples(params: {
    candles: BtcReferenceSnapshot['candles'];
    orderbook: {
      bidLevels: Array<{ price: number; size: number }>;
      askLevels: Array<{ price: number; size: number }>;
      spread: number;
      bestBid: number;
      bestAsk: number;
    };
    expiresAt: string | null;
    marketImpliedProb: number;
  }): WalkForwardSample[] {
    const samples: WalkForwardSample[] = [];

    for (let index = 6; index < params.candles.length - 1; index += 1) {
      const window = params.candles.slice(index - 6, index + 1);
      const nextCandle = params.candles[index + 1];
      if (!nextCandle) {
        continue;
      }

      const features = this.featureBuilder.build({
        candles: {
          symbol: 'BTCUSD',
          timeframe: '5m',
          candles: window,
        },
        orderbook: params.orderbook,
        expiresAt: params.expiresAt,
      });
      const regime = this.regimeClassifier.classify(features);
      const toxicity = this.toxicityPolicy.evaluate({
        features,
        regimeLabel: regime.label,
        structuralToxicityBias: regime.toxicityBias,
        signalAgeMs: 0,
        recentHistory: [],
      });
      const prior = this.priorModel.evaluate(features, regime);
      const posterior = this.posteriorUpdate.apply({
        priorProbability: prior.probabilityUp,
        features,
        regime,
        toxicityPenalty: toxicity.posteriorPenalty,
      });
      const edge = this.regimeConditionedEdgeModel.evaluate({
        priorProbability: prior.probabilityUp,
        posteriorProbability: posterior.posteriorProbability,
        marketImpliedProbability: params.marketImpliedProb,
        features,
        regime,
      });
      const executableEv = this.executableEvModel.calculate({
        directionalEdge: Math.abs(edge.edge),
        rawDirectionalEdge: Math.abs(edge.rawEdge),
        marketImpliedProbability: params.marketImpliedProb,
        features,
        regime,
        feeRate: DEFAULT_FEE_RATE,
      });
      const microstructure = this.microstructureModel.derive({
        features,
        posteriorProbability: posterior.posteriorProbability,
        marketImpliedProbability: params.marketImpliedProb,
      });
      const latestClose = window[window.length - 1]?.close ?? 0;
      const rawReturn =
        latestClose > 0 ? (nextCandle.close - latestClose) / latestClose : 0;
      const realizedReturn = rawReturn * (edge.edge >= 0 ? 1 : -1);
      const observedOutcome = nextCandle.close > latestClose ? 1 : 0;

      samples.push({
        observedAt: window[window.length - 1]?.timestamp ?? new Date().toISOString(),
        expectedEdge: Math.abs(edge.edge),
        executableEv: executableEv.expectedEv,
        regime: regime.label,
        realizedReturn,
        fillRate: executableEv.fillProbability,
        predictedProbability: posterior.posteriorProbability,
        realizedOutcome: observedOutcome,
        eventType: microstructure.eventType,
        liquidityBucket: this.liquidityBucket(features.topLevelDepth, features.spread),
        timeBucket: this.timeBucket(window[window.length - 1]?.timestamp ?? ''),
        marketStructureBucket: microstructure.structureBucket,
        costAdjustedEv: executableEv.expectedEv,
      });
    }

    return samples;
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

  private async recordNoTradeDecision(input: {
    marketId: string;
    strategyVersionId: string;
    priorProbability: number;
    posteriorProbability: number;
    marketImpliedProb: number;
    edge: number;
    expectedEv: number;
    regime: string;
    observedAt: Date;
    reasonCode: string;
    reasonMessage: string;
    marketArchetype: SignalFeatures['marketArchetype'];
    marketStateTransition: SignalFeatures['marketStateTransition'];
    toxicityState: ReturnType<ToxicityPolicy['evaluate']>['toxicityState'];
    expectedRetainedEdge: number | null;
  }): Promise<{ signalId: string; signalDecisionId: string | null }> {
    const signalId = randomUUID();
    let signalDecisionId: string | null = null;

    await (this.prisma as any).signal.create({
      data: {
        id: signalId,
        marketId: input.marketId,
        strategyVersionId: input.strategyVersionId,
        side: 'BUY',
        priorProbability: input.priorProbability,
        posteriorProbability: input.posteriorProbability,
        marketImpliedProb: input.marketImpliedProb,
        edge: input.edge,
        expectedEv: input.expectedEv,
        regime: input.regime,
        status: 'rejected',
        observedAt: input.observedAt,
      },
    });

    const signalDecisionModel = (this.prisma as unknown as {
      signalDecision?: {
        create?: (args: {
          data: {
            id: string;
            signalId: string;
            verdict: string;
            reasonCode: string;
            reasonMessage: string;
            expectedEv: number;
            positionSize: null;
            decisionAt: Date;
          };
        }) => Promise<unknown>;
      };
    }).signalDecision;

    if (signalDecisionModel?.create) {
      signalDecisionId = randomUUID();
      await signalDecisionModel.create({
        data: {
          id: signalDecisionId,
          signalId,
          verdict: 'rejected',
          reasonCode: input.reasonCode,
          reasonMessage: [
            input.reasonMessage,
            `archetype=${input.marketArchetype}`,
            `transition=${input.marketStateTransition}`,
            `toxicity=${input.toxicityState}`,
            `expectedRetainedEdge=${
              input.expectedRetainedEdge != null
                ? input.expectedRetainedEdge.toFixed(6)
                : 'unknown'
            }`,
          ].join(','),
          expectedEv: input.expectedEv,
          positionSize: null,
          decisionAt: input.observedAt,
        },
      });
    }

    return {
      signalId,
      signalDecisionId,
    };
  }

  private async persistWalkForwardDiagnostics(
    strategyVersionId: string,
    validation: ReturnType<WalkForwardValidator['validate']>,
  ): Promise<void> {
    const prisma = this.prisma as unknown as {
      evDriftDiagnostic?: {
        create?: (args: {
          data: {
            strategyVersionId: string;
            windowLabel: string;
            expectedEvSum: number;
            realizedEvSum: number;
            evDrift: number;
            realizedVsExpected: number;
            capturedAt: Date;
          };
        }) => Promise<unknown>;
      };
      regimeDiagnostic?: {
        create?: (args: {
          data: {
            strategyVersionId: string;
            regime: string;
            tradeCount: number;
            winRate: number | null;
            expectedEvAvg: number;
            realizedEvAvg: number;
            fillRate: number;
            capturedAt: Date;
          };
        }) => Promise<unknown>;
      };
    };

    if (prisma.evDriftDiagnostic?.create) {
      for (const window of validation.windows.slice(-3)) {
        await prisma.evDriftDiagnostic.create({
          data: {
            strategyVersionId,
            windowLabel: window.label,
            expectedEvSum: window.expectedEvSum,
            realizedEvSum: window.realizedEvSum,
            evDrift: window.realizedEvSum - window.expectedEvSum,
            realizedVsExpected:
              Math.abs(window.expectedEvSum) > 1e-9
                ? window.realizedEvSum / window.expectedEvSum
                : 0,
            capturedAt: new Date(validation.capturedAt),
          },
        });
      }
    }

    if (prisma.regimeDiagnostic?.create) {
      for (const regime of validation.regimePerformance.slice(0, 5)) {
        await prisma.regimeDiagnostic.create({
          data: {
            strategyVersionId,
            regime: regime.regime,
            tradeCount: regime.tradeCount,
            winRate: regime.realizedEvAvg > 0 ? 1 : 0,
            expectedEvAvg: regime.expectedEvAvg,
            realizedEvAvg: regime.realizedEvAvg,
            fillRate: regime.fillRate,
            capturedAt: new Date(validation.capturedAt),
          },
        });
      }
    }
  }

  private async persistResearchGovernance(
    strategyVersionId: string,
    input: {
      edgeDefinitionVersion: string;
      governance: ReturnType<ResearchGovernancePolicy['evaluate']>;
      robustness: ReturnType<RobustnessSuite['evaluate']>;
      promotion: ReturnType<MultiObjectivePromotionScore['evaluate']>;
    },
  ): Promise<void> {
    const prismaAny = this.prisma as any;
    if (prismaAny.reconciliationCheckpoint?.create) {
      await prismaAny.reconciliationCheckpoint.create({
        data: {
          cycleKey: `research-governance:${strategyVersionId}:${Date.now()}`,
          source: 'research_governance_validation',
          status: input.governance.promotionEligible ? 'passed' : 'blocked',
          details: {
            strategyVersionId,
            edgeDefinitionVersion: input.edgeDefinitionVersion,
            governance: input.governance,
            robustness: input.robustness,
            promotion: input.promotion,
          },
          processedAt: new Date(),
        },
      });
    }
  }

  private buildExecutableEdgeEstimate(input: {
    edgeDefinitionVersion: string;
    rawEdge: number;
    executableEv: ReturnType<ExecutableEvModel['calculate']>;
    features: SignalFeatures;
    halfLifeMultiplier: number;
    freshnessHealthy: boolean;
    threshold: number;
  }): ExecutableEdgeEstimate {
    const spreadAdjustedEdge = input.rawEdge - Math.max(0, input.features.spread);
    const slippageAdjustedEdge =
      spreadAdjustedEdge - Math.max(0, input.executableEv.expectedSlippage);
    const feeAdjustedEdge =
      slippageAdjustedEdge - Math.max(0, input.executableEv.expectedFee);
    const timeoutAdjustedEdge =
      feeAdjustedEdge -
      Math.max(0, input.executableEv.expectedMissedFillCost) -
      Math.max(0, input.executableEv.expectedCancellationCost);
    const staleSignalAdjustedEdge =
      timeoutAdjustedEdge * input.halfLifeMultiplier -
      Math.max(0, input.executableEv.expectedAdverseSelectionCost);
    const inventoryAdjustedEdge =
      staleSignalAdjustedEdge - this.expectedImpact(input.features) * 0.5;

    return {
      edgeDefinitionVersion: input.edgeDefinitionVersion,
      executionStyle: 'hybrid',
      rawModelEdge: input.rawEdge,
      spreadAdjustedEdge,
      slippageAdjustedEdge,
      feeAdjustedEdge,
      timeoutAdjustedEdge,
      staleSignalAdjustedEdge,
      inventoryAdjustedEdge,
      finalNetEdge: inventoryAdjustedEdge,
      threshold: input.threshold,
      missingInputs: Number.isFinite(input.executableEv.expectedEv) ? [] : ['expected_ev'],
      staleInputs: input.freshnessHealthy ? [] : ['orderbook'],
      paperEdgeBlocked:
        input.rawEdge >
          this.edgeDefinitionService.getDefinition().admissionThresholdPolicy.minimumNetEdge &&
        inventoryAdjustedEdge <=
          this.edgeDefinitionService.getDefinition().admissionThresholdPolicy.minimumNetEdge,
      confidence: input.executableEv.confidence,
    };
  }

  private liquidityBucket(topLevelDepth: number, spread: number): string {
    if (topLevelDepth < 20 || spread > 0.04) {
      return 'thin';
    }
    if (topLevelDepth < 40 || spread > 0.02) {
      return 'medium';
    }
    return 'deep';
  }

  private timeBucket(timestamp: string): string {
    const date = new Date(timestamp);
    const hour = Number.isNaN(date.getTime()) ? 0 : date.getUTCHours();
    if (hour < 8) {
      return 'asia';
    }
    if (hour < 16) {
      return 'europe';
    }
    return 'us';
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
    return selected
      .slice(0, 8)
      .map((entry) => ({
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
      capturedAt:
        record.createdAt instanceof Date
          ? record.createdAt.toISOString()
          : typeof record.createdAt === 'string'
            ? record.createdAt
            : null,
      marketId: typeof record.marketId === 'string' ? record.marketId : null,
    };
  }

  private normalizeOrderbook(orderbook: {
    bidLevels: unknown;
    askLevels: unknown;
    bestBid: number | null;
    bestAsk: number | null;
    spread: number | null;
  }): {
    bidLevels: Array<{ price: number; size: number }>;
    askLevels: Array<{ price: number; size: number }>;
    spread: number;
    bestBid: number;
    bestAsk: number;
  } | null {
    const bidLevels = this.parseLevels(orderbook.bidLevels, 'bid');
    const askLevels = this.parseLevels(orderbook.askLevels, 'ask');
    const bestBid = orderbook.bestBid ?? bidLevels[0]?.price ?? 0;
    const bestAsk = orderbook.bestAsk ?? askLevels[0]?.price ?? 0;
    const spread = orderbook.spread ?? Math.max(0, bestAsk - bestBid);

    if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) {
      return null;
    }

    return {
      bidLevels,
      askLevels,
      spread: Number.isFinite(spread) ? Math.max(0, spread) : 0,
      bestBid,
      bestAsk,
    };
  }

  private parseLevels(
    levelsJson: unknown,
    side: 'bid' | 'ask',
  ): Array<{ price: number; size: number }> {
    if (!Array.isArray(levelsJson)) {
      return [];
    }

    return levelsJson
      .map((level) => {
        if (Array.isArray(level) && level.length >= 2) {
          const price = Number(level[0]);
          const size = Number(level[1]);
          if (
            Number.isFinite(price) &&
            Number.isFinite(size) &&
            price >= 0 &&
            price <= 1 &&
            size > 0
          ) {
            return { price, size };
          }
        }

        if (typeof level !== 'object' || level === null) {
          return null;
        }

        const record = level as Record<string, unknown>;
        const price = Number(record.price ?? record.p ?? Number.NaN);
        const size = Number(record.size ?? record.s ?? Number.NaN);
        if (
          Number.isFinite(price) &&
          Number.isFinite(size) &&
          price >= 0 &&
          price <= 1 &&
          size > 0
        ) {
          return { price, size };
        }

        return null;
      })
      .filter((level): level is { price: number; size: number } => level !== null)
      .sort((left, right) => (side === 'bid' ? right.price - left.price : left.price - right.price));
  }
}
