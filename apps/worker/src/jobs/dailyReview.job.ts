import os from 'os';
import path from 'path';
import type { PrismaClient } from '@prisma/client';
import { AppLogger } from '@worker/common/logger';
import {
  type ExecutionStyle,
  type LearningEvent,
  type LearningCycleSummary,
  type LearningState,
  type LearningTradeSide,
  type PortfolioAllocationDecisionRecord,
  type TradeQualityScore,
  buildStrategyVariantId,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { createDefaultStrategyVariantState } from '@polymarket-btc-5m-agentic-bot/domain';
import {
  ExecutionPolicyUpdater,
  ExecutionPolicyVersionStore,
  type ExecutionLearningObservation,
} from '@polymarket-btc-5m-agentic-bot/execution-engine';
import {
  BenchmarkRelativeSizing,
  CapitalGrowthMetricsCalculator,
  CapitalAllocationEngine,
  LiveSizingFeedbackPolicy,
  PortfolioLearningStateBuilder,
  buildRegimeLocalSizingSummary,
  RegimeProfitabilityRanker,
  StrategyCorrelationMonitor,
  TradeQualityHistoryStore,
  applyPortfolioAllocationDecisions,
  type CapitalLeakReport,
  type PortfolioLearningObservation,
} from '@polymarket-btc-5m-agentic-bot/risk-engine';
import {
  CapitalGrowthPromotionGate,
  ChampionChallengerManager,
  LiveCalibrationStore,
  LiveCalibrationUpdater,
  PromotionDecisionEngine,
  PromotionStabilityCheck,
  ShadowEvaluationEngine,
  StrategyQuarantinePolicy,
  ToxicityTrend,
  createAlphaAttribution,
} from '@polymarket-btc-5m-agentic-bot/signal-engine';
import {
  VenueHealthLearningStore,
  VenueModePolicy,
  VenueUncertaintyDetector,
} from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';
import { CapitalLeakReviewJob } from './capitalLeakReview.job';
import { LearningCycleRunner, type LearningCycleSample } from '@worker/orchestration/learning-cycle-runner';
import { LearningEventLog } from '@worker/runtime/learning-event-log';
import { LearningStateStore } from '@worker/runtime/learning-state-store';
import { RollbackController } from '@worker/runtime/rollback-controller';
import { StrategyDeploymentRegistry } from '@worker/runtime/strategy-deployment-registry';
import { StrategyRolloutController } from '@worker/runtime/strategy-rollout-controller';
import {
  VersionLineageRegistry,
  buildAllocationPolicyVersionLineage,
  buildCalibrationVersionLineage,
  buildExecutionPolicyVersionLineage,
  buildFeatureSetVersionLineage,
  buildRiskPolicyVersionLineage,
  buildStrategyVersionLineage,
  buildValidationProofTags,
} from '@worker/runtime/version-lineage-registry';
import { CapitalGrowthReviewJob } from './capitalGrowthReview.job';
import { buildRetentionContextReport } from '../validation/retention-context-report';
import { buildCalibrationDriftAlerts } from '../validation/calibration-drift-alerts';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export class DailyReviewJob {
  private readonly logger = new AppLogger('DailyReviewJob');
  private readonly learningStateStore: LearningStateStore;
  private readonly learningEventLog: LearningEventLog;
  private readonly strategyDeploymentRegistry: StrategyDeploymentRegistry;
  private readonly runner: LearningCycleRunner;
  private readonly executionPolicyUpdater: ExecutionPolicyUpdater;
  private readonly portfolioLearningStateBuilder = new PortfolioLearningStateBuilder();
  private readonly strategyCorrelationMonitor = new StrategyCorrelationMonitor();
  private readonly capitalAllocationEngine = new CapitalAllocationEngine();
  private readonly tradeQualityHistoryStore: TradeQualityHistoryStore;
  private readonly regimeProfitabilityRanker = new RegimeProfitabilityRanker();
  private readonly capitalGrowthMetricsCalculator = new CapitalGrowthMetricsCalculator();
  private readonly championChallengerManager = new ChampionChallengerManager();
  private readonly shadowEvaluationEngine = new ShadowEvaluationEngine();
  private readonly capitalGrowthPromotionGate = new CapitalGrowthPromotionGate();
  private readonly promotionStabilityCheck = new PromotionStabilityCheck();
  private readonly promotionDecisionEngine = new PromotionDecisionEngine();
  private readonly quarantinePolicy = new StrategyQuarantinePolicy();
  private readonly rolloutController = new StrategyRolloutController();
  private readonly rollbackController = new RollbackController();
  private readonly versionLineageRegistry: VersionLineageRegistry;
  private readonly venueHealthLearningStore: VenueHealthLearningStore;
  private readonly capitalLeakReviewJob: CapitalLeakReviewJob;
  private readonly capitalGrowthReviewJob: CapitalGrowthReviewJob;
  private readonly venueUncertaintyDetector = new VenueUncertaintyDetector();
  private readonly venueModePolicy = new VenueModePolicy();
  private readonly liveSizingFeedbackPolicy = new LiveSizingFeedbackPolicy();
  private readonly benchmarkRelativeSizing = new BenchmarkRelativeSizing();
  private readonly toxicityTrend = new ToxicityTrend();

  constructor(
    private readonly prisma: PrismaClient,
    learningStateStore?: LearningStateStore,
    learningEventLog?: LearningEventLog,
    strategyDeploymentRegistry?: StrategyDeploymentRegistry,
    versionLineageRegistry?: VersionLineageRegistry,
    venueHealthLearningStore?: VenueHealthLearningStore,
  ) {
    this.learningStateStore = learningStateStore ?? new LearningStateStore();
    this.learningEventLog = learningEventLog ?? new LearningEventLog();
    this.strategyDeploymentRegistry =
      strategyDeploymentRegistry ?? new StrategyDeploymentRegistry();
    this.versionLineageRegistry =
      versionLineageRegistry ?? new VersionLineageRegistry();
    this.venueHealthLearningStore =
      venueHealthLearningStore ?? createDefaultVenueHealthLearningStore(this.learningStateStore);
    this.tradeQualityHistoryStore = new TradeQualityHistoryStore(
      path.join(this.learningStateStore.getPaths().rootDir, 'trade-quality'),
    );
    this.capitalLeakReviewJob = new CapitalLeakReviewJob(
      prisma,
      this.learningStateStore,
      this.tradeQualityHistoryStore,
    );
    this.capitalGrowthReviewJob = new CapitalGrowthReviewJob(
      prisma,
      this.learningStateStore,
      this.tradeQualityHistoryStore,
    );
    const calibrationStore = new LiveCalibrationStore({
      loadState: () => this.learningStateStore.load(),
      saveState: (state) => this.learningStateStore.save(state),
    });
    this.runner = new LearningCycleRunner(new LiveCalibrationUpdater(calibrationStore));
    const executionPolicyVersionStore = new ExecutionPolicyVersionStore({
      loadState: () => this.learningStateStore.load(),
      saveState: (state) => this.learningStateStore.save(state),
    });
    this.executionPolicyUpdater = new ExecutionPolicyUpdater(executionPolicyVersionStore);
  }

  async runDueCycle(now = new Date()): Promise<LearningCycleSummary | null> {
    const state = await this.learningStateStore.load();
    if (!isLearningCycleDue(state.lastCycleCompletedAt, now)) {
      return null;
    }

    return this.run({ now, priorState: state });
  }

  async run(options?: {
    now?: Date;
    force?: boolean;
    priorState?: Awaited<ReturnType<LearningStateStore['load']>>;
  }): Promise<LearningCycleSummary> {
    const now = options?.now ?? new Date();
    const priorState = options?.priorState ?? (await this.learningStateStore.load());
    if (!options?.force && !isLearningCycleDue(priorState.lastCycleCompletedAt, now)) {
      return (
        priorState.lastCycleSummary ?? {
          cycleId: 'learning-cycle-skipped',
          startedAt: now.toISOString(),
          completedAt: now.toISOString(),
          status: 'completed',
          analyzedWindow: {
            from: now.toISOString(),
            to: now.toISOString(),
          },
          realizedOutcomeCount: 0,
          attributionSliceCount: 0,
          calibrationUpdates: 0,
          shrinkageActions: 0,
          degradedContexts: [],
          warnings: ['learning_cycle_not_due'],
          errors: [],
        }
      );
    }

    const cycleId = `learning-cycle-${now.toISOString().replace(/[:.]/g, '-')}`;
    const window = determineLearningWindow(priorState.lastCycleCompletedAt, now);
    const startedState = {
      ...priorState,
      lastCycleStartedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    await this.learningStateStore.save(startedState);
    await this.learningEventLog.append([
      {
        id: `${cycleId}:started`,
        type: 'learning_cycle_started',
        severity: 'info',
        createdAt: now.toISOString(),
        cycleId,
        strategyVariantId: null,
        contextKey: null,
        summary: 'Learning cycle started.',
        details: {
          analyzedWindow: {
            from: window.from.toISOString(),
            to: window.to.toISOString(),
          },
        },
      },
    ]);

    try {
      const samples = await this.loadRealizedOutcomeSamples(window.from, window.to);
      const completedAt = new Date();
      const result = await this.runner.run({
        cycleId,
        startedAt: now,
        completedAt,
        analyzedWindow: window,
        priorState: startedState,
        samples,
      });
      const executionLearning = await this.runWaveThreeExecutionLearning({
        cycleId,
        now: completedAt,
        from: window.from,
        to: window.to,
        learningState: result.nextState,
      });
      const governed = await this.runWaveTwoGovernance({
        cycleId,
        now: completedAt,
        learningState: executionLearning.learningState,
      });
      const portfolioLearning = await this.runWaveFourPortfolioLearning({
        cycleId,
        now: completedAt,
        from: window.from,
        to: window.to,
        learningState: governed.learningState,
        registry: governed.registry,
      });
      const venueLearning = await this.runWaveFiveVenueLearning({
        now: completedAt,
        from: window.from,
        to: window.to,
      });
      const capitalLeakReview = await this.capitalLeakReviewJob.run({
        now: completedAt,
        from: window.from,
        to: window.to,
        learningState: portfolioLearning.learningState,
      });
      const capitalGrowthReview = await this.capitalGrowthReviewJob.run({
        now: completedAt,
        from: window.from,
        to: window.to,
        learningState: portfolioLearning.learningState,
        capitalLeakReport: capitalLeakReview.report,
      });
      const baselineBenchmarkReview = await this.runPhaseFiveBaselineBenchmarkReview({
        now: completedAt,
        baselineComparison: capitalGrowthReview.report.baselineComparison,
      });
      const benchmarkRelativeSizingReview = await this.runItemSevenBenchmarkRelativeSizingReview({
        now: completedAt,
        baselineComparison: capitalGrowthReview.report.baselineComparison,
      });
      const rollingBenchmarkScorecardReview =
        await this.runItemEightRollingBenchmarkScorecardReview({
          now: completedAt,
          rollingBenchmarkScorecard: capitalGrowthReview.report.rollingBenchmarkScorecard,
        });
      const validationProofReview = await this.runPhaseSixValidationProofReview({
        cycleId,
        now: completedAt,
        learningState: portfolioLearning.learningState,
        registry: governed.registry,
        capitalGrowthReport: capitalGrowthReview.report,
      });
      const alphaAttributionReview = await this.runPhaseOneAlphaAttributionReview({
        now: completedAt,
        from: window.from,
        to: window.to,
      });
      const retentionContextReview = await this.runItemTwoRetentionContextReview({
        now: completedAt,
        from: window.from,
        to: window.to,
      });
      const calibrationDriftAlertReview =
        await this.runItemTwelveCalibrationDriftAlertReview({
          now: completedAt,
          from: window.from,
          to: window.to,
        });
      const regimeLocalSizingReview = await this.runItemSixRegimeLocalSizingReview({
        now: completedAt,
        retentionContextSummary: retentionContextReview.summary,
      });
      const lossAttributionReview = await this.runItemOneLossAttributionReview({
        now: completedAt,
        from: window.from,
        to: window.to,
      });
      const toxicityReview = await this.runPhaseThreeToxicityReview({
        now: completedAt,
        from: window.from,
        to: window.to,
      });
      const liveSizingFeedbackReview = await this.runPhaseFourLiveSizingFeedbackReview({
        now: completedAt,
        from: window.from,
        to: window.to,
        learningState: portfolioLearning.learningState,
        capitalGrowthReport: capitalGrowthReview.report,
      });
      const summary = attachReviewOutputs(
        appendWarnings(result.summary, [
          ...executionLearning.warnings,
          ...portfolioLearning.warnings,
          ...venueLearning.warnings,
          ...capitalLeakReview.warnings,
          ...capitalGrowthReview.warnings,
          ...baselineBenchmarkReview.warnings,
          ...benchmarkRelativeSizingReview.warnings,
          ...rollingBenchmarkScorecardReview.warnings,
          ...validationProofReview.warnings,
          ...alphaAttributionReview.warnings,
          ...retentionContextReview.warnings,
          ...calibrationDriftAlertReview.warnings,
          ...regimeLocalSizingReview.warnings,
          ...lossAttributionReview.warnings,
          ...toxicityReview.warnings,
          ...liveSizingFeedbackReview.warnings,
        ]),
        {
          alphaAttribution: alphaAttributionReview.summary,
          retentionContext: retentionContextReview.summary,
          calibrationDriftAlerts: calibrationDriftAlertReview.summary,
          regimeLocalSizing: regimeLocalSizingReview.summary,
          lossAttribution: lossAttributionReview.summary,
          toxicity: toxicityReview.summary,
          baselineBenchmarks: capitalGrowthReview.report.baselineComparison,
          benchmarkRelativeSizing: benchmarkRelativeSizingReview.summary,
          rollingBenchmarkScorecard: rollingBenchmarkScorecardReview.summary,
          retentionReport: capitalGrowthReview.report.retentionReport,
          regimePerformanceReport: capitalGrowthReview.report.regimePerformanceReport,
          liveProofScorecard: capitalGrowthReview.report.liveProofScorecard,
          liveSizingFeedback: liveSizingFeedbackReview.summary,
        },
      );
      const finalState: LearningState = {
        ...portfolioLearning.learningState,
        lastCycleSummary: summary,
        lastCycleCompletedAt: summary.completedAt,
        updatedAt: completedAt.toISOString(),
      };

      await this.learningStateStore.save(finalState);
      await this.strategyDeploymentRegistry.save(governed.registry);
      await this.learningEventLog.append([
        ...result.events,
        ...executionLearning.events,
        ...governed.events,
        ...portfolioLearning.events,
      ]);

      this.logger.log('Daily learning cycle completed.', {
        cycleId,
        status: result.summary.status,
        realizedOutcomeCount: result.summary.realizedOutcomeCount,
        calibrationUpdates: result.summary.calibrationUpdates,
      });

      return summary;
    } catch (error) {
      const completedAt = new Date();
      const summary: LearningCycleSummary = {
        cycleId,
        startedAt: now.toISOString(),
        completedAt: completedAt.toISOString(),
        status: 'failed',
        analyzedWindow: {
          from: window.from.toISOString(),
          to: window.to.toISOString(),
        },
        realizedOutcomeCount: 0,
        attributionSliceCount: 0,
        calibrationUpdates: 0,
        shrinkageActions: 0,
        degradedContexts: [],
        warnings: [],
        errors: [error instanceof Error ? error.message : String(error)],
      };

      await this.learningStateStore.save({
        ...startedState,
        lastCycleCompletedAt: completedAt.toISOString(),
        lastCycleSummary: summary,
        updatedAt: completedAt.toISOString(),
      });

      await this.learningEventLog.append([
        {
          id: `${cycleId}:failed`,
          type: 'learning_cycle_failed',
          severity: 'critical',
          createdAt: completedAt.toISOString(),
          cycleId,
          strategyVariantId: null,
          contextKey: null,
          summary: 'Learning cycle failed.',
          details: {
            errors: summary.errors,
          },
        },
      ]);

      this.logger.error('Daily learning cycle failed.', undefined, {
        cycleId,
        error: summary.errors[0],
      });

      return summary;
    }
  }

  private async runWaveTwoGovernance(input: {
    cycleId: string;
    now: Date;
    learningState: LearningState;
  }): Promise<{
    learningState: LearningState;
    registry: Awaited<ReturnType<StrategyDeploymentRegistry['load']>>;
    events: LearningEvent[];
  }> {
    const strategyVersions = await this.loadStrategyVersions();
    let registry = await this.strategyDeploymentRegistry.load();
    const learningState: LearningState = {
      ...input.learningState,
      strategyVariants: {
        ...input.learningState.strategyVariants,
      },
    };
    const events: LearningEvent[] = [];
    const recentTradeQualityScores = await this.tradeQualityHistoryStore.readLatest(5_000);
    const latestCapitalLeakReport = await this.capitalLeakReviewJob.readLatestReport();

    const sync = this.championChallengerManager.sync({
      registry,
      versions: strategyVersions,
      cycleId: input.cycleId,
      now: input.now,
    });
    registry = sync.registry;
    events.push(...sync.events);

    for (const variantId of Object.keys(registry.variants).sort()) {
      learningState.strategyVariants[variantId] =
        learningState.strategyVariants[variantId] ??
        createDefaultStrategyVariantState(variantId);
    }

    const incumbent =
      registry.incumbentVariantId != null
        ? registry.variants[registry.incumbentVariantId] ?? null
        : null;
    const challengers = Object.values(registry.variants)
      .filter(
        (variant) =>
          variant.variantId !== registry.incumbentVariantId && variant.status !== 'retired',
      )
      .sort((left, right) => left.variantId.localeCompare(right.variantId));

    for (const challenger of challengers) {
      const shadowEvidence = this.shadowEvaluationEngine.evaluate({
        candidate: challenger,
        incumbent,
        learningState,
        now: input.now,
      });
      registry.variants[challenger.variantId] = {
        ...challenger,
        lastShadowEvaluatedAt: input.now.toISOString(),
        updatedAt: input.now.toISOString(),
      };
      events.push({
        id: `${input.cycleId}:shadow:${challenger.variantId}`,
        type: 'shadow_evaluation_completed',
        severity: shadowEvidence.sufficientSample ? 'info' : 'warning',
        createdAt: input.now.toISOString(),
        cycleId: input.cycleId,
        strategyVariantId: challenger.variantId,
        contextKey: null,
        summary: `Shadow evaluation completed for ${challenger.variantId}.`,
        details: shadowEvidence as unknown as Record<string, unknown>,
      });

      const quarantineAssessment = this.quarantinePolicy.evaluate({
        variant: challenger,
        evidence: shadowEvidence,
        learningState,
        now: input.now,
      });
      learningState.strategyVariants[challenger.variantId] = {
        ...learningState.strategyVariants[challenger.variantId]!,
        lastQuarantineDecision: quarantineAssessment.decision,
      };
      for (const record of quarantineAssessment.records) {
        registry.quarantines[record.quarantineId] = record;
        events.push({
          id: `${input.cycleId}:quarantine:${record.quarantineId}`,
          type: 'strategy_quarantined',
          severity: record.severity === 'high' ? 'critical' : 'warning',
          createdAt: input.now.toISOString(),
          cycleId: input.cycleId,
          strategyVariantId: challenger.variantId,
          contextKey: record.scope.regime,
          summary: `Strategy quarantine applied for ${challenger.variantId}.`,
          details: record as unknown as Record<string, unknown>,
        });
        await this.versionLineageRegistry.recordDecision({
          decisionId: record.quarantineId,
          decisionType: 'quarantine',
          recordedAt: input.now.toISOString(),
          summary: `Quarantine recorded for ${challenger.variantId}.`,
          marketId: null,
          strategyVariantId: challenger.variantId,
          cycleId: input.cycleId,
          lineage: {
            strategyVersion: buildStrategyVersionLineage({
              strategyVersionId: challenger.strategyVersionId,
              strategyVariantId: challenger.variantId,
            }),
            featureSetVersion: buildFeatureSetVersionLineage({
              featureSetId: 'shadow-evaluation-governance',
              parentStrategyVersionId: challenger.strategyVersionId,
              parameters: {
                evidenceMode: shadowEvidence.evaluationMode,
                scope: record.scope,
              },
            }),
            calibrationVersion: buildCalibrationVersionLineage(
              findCalibrationForVariantState(learningState, challenger.variantId),
            ),
            executionPolicyVersion: buildExecutionPolicyVersionLineage(
              findExecutionPolicyVersionForVariant(learningState, challenger.variantId),
            ),
            riskPolicyVersion: buildRiskPolicyVersionLineage({
              policyId: 'strategy-quarantine-policy',
              parameters: {
                record,
                shadowEvidence,
              },
            }),
            allocationPolicyVersion: null,
          },
          replay: {
            marketState: {
              quarantineScope: record.scope,
            },
            runtimeState: {
              cycleId: input.cycleId,
            },
            learningState: {
              shadowEvidence,
              quarantineDecision: quarantineAssessment.decision,
            },
            lineageState: {
              incumbentVariantId: registry.incumbentVariantId,
              activeRollout: registry.activeRollout,
            },
            activeParameterBundle: {
              record,
              shadowEvidence,
            },
            venueMode: null,
            venueUncertainty: null,
          },
          tags: ['wave5', 'quarantine'],
        });
      }
      if (quarantineAssessment.decision.status === 'quarantined') {
        registry.variants[challenger.variantId] = {
          ...registry.variants[challenger.variantId]!,
          status: 'quarantined',
          evaluationMode: 'shadow_only',
          rolloutStage: 'shadow_only',
          capitalAllocationPct: 0,
          updatedAt: input.now.toISOString(),
        };
        learningState.strategyVariants[challenger.variantId] = {
          ...learningState.strategyVariants[challenger.variantId]!,
          lastPromotionDecision: {
            decision: 'reject',
            reasons: ['candidate_quarantined_before_promotion'],
            evidence: {
              quarantineDecision: quarantineAssessment.decision,
            },
            decidedAt: input.now.toISOString(),
          },
        };
        continue;
      }

      const economicControls = this.buildPromotionEconomicControls({
        strategyVariantId: challenger.variantId,
        learningState,
        shadowEvidence,
        recentTradeQualityScores,
        capitalLeakReport: latestCapitalLeakReport,
      });

      const decision = this.promotionDecisionEngine.evaluate({
        evidence: shadowEvidence,
        currentRolloutStage:
          registry.activeRollout?.challengerVariantId === challenger.variantId
            ? registry.activeRollout.stage
            : challenger.rolloutStage,
        economicControls,
        now: input.now,
      });
      learningState.strategyVariants[challenger.variantId] = {
        ...learningState.strategyVariants[challenger.variantId]!,
        lastPromotionDecision: {
          decision: decision.verdict,
          reasons: decision.reasons,
          evidence: decision.evidence,
          decidedAt: decision.decidedAt,
        },
      };
      events.push({
        id: `${input.cycleId}:promotion:${challenger.variantId}`,
        type: 'strategy_promotion_decided',
        severity:
          decision.verdict === 'rollback'
            ? 'critical'
            : decision.verdict === 'promote'
              ? 'warning'
              : 'info',
        createdAt: input.now.toISOString(),
        cycleId: input.cycleId,
        strategyVariantId: challenger.variantId,
        contextKey: null,
        summary: `Promotion decision ${decision.verdict} for ${challenger.variantId}.`,
        details: decision as unknown as Record<string, unknown>,
      });
      await this.versionLineageRegistry.recordDecision({
        decisionId: `${input.cycleId}:promotion:${challenger.variantId}`,
        decisionType: 'promotion',
        recordedAt: input.now.toISOString(),
        summary: `Promotion decision ${decision.verdict} for ${challenger.variantId}.`,
        strategyVariantId: challenger.variantId,
        cycleId: input.cycleId,
        lineage: {
          strategyVersion: buildStrategyVersionLineage({
            strategyVersionId: challenger.strategyVersionId,
            strategyVariantId: challenger.variantId,
          }),
          featureSetVersion: buildFeatureSetVersionLineage({
            featureSetId: 'shadow-evaluation-governance',
            parentStrategyVersionId: challenger.strategyVersionId,
            parameters: {
              evaluationMode: shadowEvidence.evaluationMode,
              sampleCount: shadowEvidence.sampleCount,
            },
          }),
          calibrationVersion: buildCalibrationVersionLineage(
            findCalibrationForVariantState(learningState, challenger.variantId),
          ),
          executionPolicyVersion: buildExecutionPolicyVersionLineage(
            findExecutionPolicyVersionForVariant(learningState, challenger.variantId),
          ),
          riskPolicyVersion: buildRiskPolicyVersionLineage({
            policyId: 'promotion-decision-engine',
            parameters: {
              decision,
              shadowEvidence,
              economicControls,
            },
          }),
          allocationPolicyVersion: null,
        },
        replay: {
          marketState: null,
          runtimeState: {
            cycleId: input.cycleId,
          },
          learningState: {
            shadowEvidence,
            promotionEconomics: economicControls,
            lastPromotionDecision:
              learningState.strategyVariants[challenger.variantId]?.lastPromotionDecision ?? null,
          },
          lineageState: {
            incumbentVariantId: registry.incumbentVariantId,
            activeRollout: registry.activeRollout,
          },
          activeParameterBundle: {
            decision,
            shadowEvidence,
            economicControls,
          },
          venueMode: null,
          venueUncertainty: null,
        },
        tags: ['wave5', 'phase12_wave5', 'promotion', decision.verdict],
      });

      const rolloutMutation = this.rolloutController.applyPromotionDecision({
        registry,
        decision,
        cycleId: input.cycleId,
        now: input.now,
      });
      registry = rolloutMutation.registry;
      if (rolloutMutation.event) {
        events.push(rolloutMutation.event);
      }
    }

    const rollback = this.rollbackController.evaluate({
      registry,
      learningState,
      now: input.now,
    });
    if (rollback) {
      await this.versionLineageRegistry.recordDecision({
        decisionId: rollback.rollbackId,
        decisionType: 'rollback',
        recordedAt: input.now.toISOString(),
        summary: `Rollback triggered for ${rollback.fromVariantId}.`,
        strategyVariantId: rollback.fromVariantId,
        cycleId: input.cycleId,
        lineage: {
          strategyVersion: buildStrategyVersionLineage({
            strategyVersionId:
              registry.variants[rollback.fromVariantId]?.strategyVersionId ?? null,
            strategyVariantId: rollback.fromVariantId,
          }),
          featureSetVersion: buildFeatureSetVersionLineage({
            featureSetId: 'rollback-governance',
            parentStrategyVersionId:
              registry.variants[rollback.fromVariantId]?.strategyVersionId ?? null,
            parameters: {
              trigger: rollback.trigger,
              reasons: rollback.reasons,
            },
          }),
          calibrationVersion: buildCalibrationVersionLineage(
            findCalibrationForVariantState(learningState, rollback.fromVariantId),
          ),
          executionPolicyVersion: buildExecutionPolicyVersionLineage(
            findExecutionPolicyVersionForVariant(learningState, rollback.fromVariantId),
          ),
          riskPolicyVersion: buildRiskPolicyVersionLineage({
            policyId: 'rollback-controller',
            parameters: rollback as unknown as Record<string, unknown>,
          }),
          allocationPolicyVersion: null,
        },
        replay: {
          marketState: null,
          runtimeState: {
            cycleId: input.cycleId,
          },
          learningState: {
            strategyVariant: learningState.strategyVariants[rollback.fromVariantId] ?? null,
          },
          lineageState: {
            incumbentVariantId: registry.incumbentVariantId,
            activeRollout: registry.activeRollout,
          },
          activeParameterBundle: rollback as unknown as Record<string, unknown>,
          venueMode: null,
          venueUncertainty: null,
        },
        tags: ['wave5', 'rollback', rollback.trigger],
      });
      const rollbackMutation = this.rolloutController.applyRollback({
        registry,
        rollback,
        cycleId: input.cycleId,
        now: input.now,
      });
      registry = rollbackMutation.registry;
      if (rollbackMutation.event) {
        events.push(rollbackMutation.event);
      }
    }

    return {
      learningState,
      registry,
      events,
    };
  }

  private buildPromotionEconomicControls(input: {
    strategyVariantId: string;
    learningState: LearningState;
    shadowEvidence: {
      sampleCount: number;
      realizedVsExpected: number | null;
      realizedPnl: number;
    };
    recentTradeQualityScores: TradeQualityScore[];
    capitalLeakReport: CapitalLeakReport | null;
  }) {
    const variantState =
      input.learningState.strategyVariants[input.strategyVariantId] ??
      createDefaultStrategyVariantState(input.strategyVariantId);
    const persistedTradeQuality = input.recentTradeQualityScores.filter(
      (score) => score.strategyVariantId === input.strategyVariantId,
    );
    const variantTradeQuality =
      persistedTradeQuality.length > 0
        ? persistedTradeQuality
        : buildSyntheticPromotionTradeQualityScores(
            input.strategyVariantId,
            variantState,
            input.shadowEvidence,
          );
    const calibrationHealth = worstHealth(
      Object.values(input.learningState.calibration)
        .filter((calibration) => calibration.strategyVariantId === input.strategyVariantId)
        .map((calibration) => calibration.health),
    );
    const executionHealth = worstHealth(
      Object.values(variantState.executionLearning.contexts).map((context) => context.health),
    );
    const drawdownState = findVariantDrawdown(
      input.learningState,
      input.strategyVariantId,
    );
    const regimeAssessments = Object.values(variantState.regimeSnapshots).map((snapshot) =>
      this.regimeProfitabilityRanker.rank({
        strategyVariantId: input.strategyVariantId,
        regime: snapshot.regime,
        regimeSnapshot: snapshot,
        calibrationHealth,
        executionContext:
          Object.values(variantState.executionLearning.contexts).find(
            (context) => context.regime === snapshot.regime,
          ) ?? null,
        recentTradeQualityScores: variantTradeQuality.filter(
          (score) => score.regime === snapshot.regime,
        ),
        currentDrawdownPct: drawdownState?.currentDrawdown ?? null,
        maxDrawdownPct: drawdownState?.maxDrawdown ?? null,
        recentLeakShare:
          input.capitalLeakReport?.byRegime.find(
            (group) => group.groupKey === snapshot.regime,
          )?.dominantShare ?? null,
      }),
    );
    const metrics = this.capitalGrowthMetricsCalculator.evaluate({
      strategyVariantId: input.strategyVariantId,
      tradeQualityScores: variantTradeQuality,
      regimeAssessments,
      capitalLeakReportGroup:
        input.capitalLeakReport?.byStrategyVariant.find(
          (group) => group.groupKey === input.strategyVariantId,
        ) ?? null,
      calibrationHealth,
      executionHealth,
      currentDrawdownPct: drawdownState?.currentDrawdown ?? null,
      maxDrawdownPct: drawdownState?.maxDrawdown ?? null,
    });
    const sampleCount = Math.max(
      input.shadowEvidence.sampleCount,
      metrics.tradeCount,
      regimeAssessments.reduce((sum, assessment) => sum + assessment.metrics.sampleCount, 0),
    );
    const capitalGrowthGate = this.capitalGrowthPromotionGate.evaluate({
      sampleCount,
      calibrationHealth,
      executionHealth,
      netEdgeQuality: metrics.netEdgeQuality,
      maxDrawdownPct: metrics.maxDrawdownPct,
      capitalLeakageRatio: metrics.costLeakageRatio,
      executionEvRetention: metrics.executionEvRetention,
      regimeStabilityScore: metrics.regimeStabilityScore,
      stabilityAdjustedCapitalGrowthScore:
        metrics.stabilityAdjustedCapitalGrowthScore,
    });
    const realizedReturns = variantTradeQuality
      .map((score) => {
        const value = score.breakdown.realizedOutcomeQuality.evidence.realizedEv;
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
      })
      .filter((value): value is number => value != null);
    if (realizedReturns.length === 0 && Number.isFinite(input.shadowEvidence.realizedPnl)) {
      realizedReturns.push(input.shadowEvidence.realizedPnl);
    }
    const stabilityCheck = this.promotionStabilityCheck.evaluate({
      sampleCount,
      realizedVsExpected:
        metrics.evRetention ?? input.shadowEvidence.realizedVsExpected,
      stabilityAdjustedCapitalGrowthScore:
        metrics.stabilityAdjustedCapitalGrowthScore,
      contextShares: buildPromotionStabilityContextShares(variantState),
      realizedReturns,
    });

    return {
      capitalGrowthGate,
      stabilityCheck,
      netEdgeQuality: metrics.netEdgeQuality,
      maxDrawdownPct: metrics.maxDrawdownPct,
      capitalLeakageRatio: metrics.costLeakageRatio,
      executionEvRetention: metrics.executionEvRetention,
      regimeStabilityScore: metrics.regimeStabilityScore,
      stabilityAdjustedCapitalGrowthScore:
        metrics.stabilityAdjustedCapitalGrowthScore,
      compoundingEfficiencyScore: metrics.compoundingEfficiency.score,
    };
  }

  private async runWaveThreeExecutionLearning(input: {
    cycleId: string;
    now: Date;
    from: Date;
    to: Date;
    learningState: LearningState;
  }): Promise<{
    learningState: LearningState;
    events: LearningEvent[];
    warnings: string[];
  }> {
    const observations = await this.loadExecutionLearningObservations(input.from, input.to);
    if (observations.length === 0) {
      return {
        learningState: input.learningState,
        events: [],
        warnings: [],
      };
    }

    const updated = this.executionPolicyUpdater.update({
      priorState: input.learningState.executionLearning,
      observations,
      cycleId: input.cycleId,
      now: input.now,
    });
    const learningState: LearningState = {
      ...input.learningState,
      executionLearning: updated.executionLearning,
      strategyVariants: {
        ...input.learningState.strategyVariants,
      },
      updatedAt: input.now.toISOString(),
    };

    for (const [variantId, executionLearning] of Object.entries(updated.variantExecutionLearning)) {
      const priorVariant =
        learningState.strategyVariants[variantId] ?? createDefaultStrategyVariantState(variantId);
      learningState.strategyVariants[variantId] = {
        ...priorVariant,
        executionLearning,
        lastLearningAt: input.now.toISOString(),
      };
    }

    return {
      learningState,
      events: updated.events,
      warnings: updated.adverseSelectionContexts.map(
        (contextKey) => `adverse_selection_detected:${contextKey}`,
      ),
    };
  }

  private async runWaveFourPortfolioLearning(input: {
    cycleId: string;
    now: Date;
    from: Date;
    to: Date;
    learningState: LearningState;
    registry: Awaited<ReturnType<StrategyDeploymentRegistry['load']>>;
  }): Promise<{
    learningState: LearningState;
    events: LearningEvent[];
    warnings: string[];
  }> {
    const observations = await this.loadPortfolioLearningObservations(input.from, input.to);
    const correlation = this.strategyCorrelationMonitor.evaluate({
      observations,
      now: input.now,
    });
    const portfolioUpdate = this.portfolioLearningStateBuilder.update({
      priorState: input.learningState.portfolioLearning,
      observations,
      correlationSignals: correlation.signals,
      now: input.now,
    });
    const allocation = this.capitalAllocationEngine.evaluate({
      learningState: input.learningState,
      portfolioLearning: portfolioUpdate.state,
      registry: input.registry,
      correlationPenaltyByVariant: correlation.penaltyMultiplierByVariant,
      now: input.now,
    });
    const portfolioLearning = applyPortfolioAllocationDecisions(
      portfolioUpdate.state,
      allocation.decisions,
      input.now,
    );
    const learningState: LearningState = {
      ...input.learningState,
      portfolioLearning,
      strategyVariants: {
        ...input.learningState.strategyVariants,
      },
      updatedAt: input.now.toISOString(),
    };
    for (const decision of Object.values(allocation.decisions)) {
      const variant =
        learningState.strategyVariants[decision.strategyVariantId] ??
        createDefaultStrategyVariantState(decision.strategyVariantId);
      learningState.strategyVariants[decision.strategyVariantId] = {
        ...variant,
        lastCapitalAllocationDecision: {
          status:
            decision.status === 'increase'
              ? 'increase'
              : decision.status === 'reduce'
                ? 'reduce'
                : 'hold',
          targetMultiplier: decision.targetMultiplier,
          reasons: decision.reasons,
          decidedAt: decision.decidedAt,
        },
        lastLearningAt: input.now.toISOString(),
      };
      await this.versionLineageRegistry.recordDecision({
        decisionId: decision.decisionKey,
        decisionType: 'capital_allocation',
        recordedAt: decision.decidedAt ?? input.now.toISOString(),
        summary: `Capital allocation ${decision.status} for ${decision.strategyVariantId}.`,
        strategyVariantId: decision.strategyVariantId,
        cycleId: input.cycleId,
        lineage: {
          strategyVersion: buildStrategyVersionLineage({
            strategyVersionId:
              input.registry.variants[decision.strategyVariantId]?.strategyVersionId ?? null,
            strategyVariantId: decision.strategyVariantId,
          }),
          featureSetVersion: buildFeatureSetVersionLineage({
            featureSetId: 'portfolio-allocation',
            parentStrategyVersionId:
              input.registry.variants[decision.strategyVariantId]?.strategyVersionId ?? null,
            parameters: {
              sleeveType: 'variant',
              status: decision.status,
            },
          }),
          calibrationVersion: buildCalibrationVersionLineage(
            findCalibrationForVariantState(learningState, decision.strategyVariantId),
          ),
          executionPolicyVersion: buildExecutionPolicyVersionLineage(
            findExecutionPolicyVersionForVariant(learningState, decision.strategyVariantId),
          ),
          riskPolicyVersion: buildRiskPolicyVersionLineage({
            policyId: 'capital-allocation-engine',
            parameters: decision.evidence,
          }),
          allocationPolicyVersion: buildAllocationPolicyVersionLineage({
            policyId: 'capital-allocation-engine',
            strategyVariantId: decision.strategyVariantId,
            allocationDecisionKey: decision.decisionKey,
            parameters: decision.evidence,
          }),
        },
        replay: {
          marketState: null,
          runtimeState: {
            cycleId: input.cycleId,
          },
          learningState: {
            decision,
            portfolioLearning,
          },
          lineageState: {
            incumbentVariantId: input.registry.incumbentVariantId,
            activeRollout: input.registry.activeRollout,
          },
          activeParameterBundle: decision.evidence,
          venueMode: null,
          venueUncertainty: null,
        },
        tags: ['wave5', 'capital-allocation', decision.status],
      });
    }

    const events: LearningEvent[] = [
      {
        id: `${input.cycleId}:portfolio-learning`,
        type: 'portfolio_learning_updated',
        severity: portfolioUpdate.concentrationWarnings.length > 0 ? 'warning' : 'info',
        createdAt: input.now.toISOString(),
        cycleId: input.cycleId,
        strategyVariantId: null,
        contextKey: null,
        summary: 'Portfolio learning state updated.',
        details: {
          observationCount: observations.length,
          updatedSliceCount: portfolioUpdate.updatedSliceCount,
          concentrationWarnings: portfolioUpdate.concentrationWarnings,
        },
      },
      ...Object.values(correlation.signals)
        .filter((signal) => signal.hiddenOverlap)
        .map((signal) => ({
          id: `${input.cycleId}:${signal.signalKey}`,
          type: 'correlation_signal_detected' as const,
          severity:
            signal.penaltyMultiplier <= 0.7
              ? ('critical' as const)
              : ('warning' as const),
          createdAt: input.now.toISOString(),
          cycleId: input.cycleId,
          strategyVariantId: signal.leftVariantId,
          contextKey: signal.signalKey,
          summary: `Hidden overlap detected between ${signal.leftVariantId} and ${signal.rightVariantId}.`,
          details: signal as unknown as Record<string, unknown>,
        })),
      ...Object.values(allocation.decisions).map((decision) =>
        buildCapitalAllocationEvent(input.cycleId, input.now, decision),
      ),
    ];

    return {
      learningState,
      events,
      warnings: [
        ...portfolioUpdate.concentrationWarnings.map(
          (warning) => `allocation_concentration:${warning}`,
        ),
        ...Object.values(correlation.signals)
          .filter((signal) => signal.hiddenOverlap)
          .map((signal) => `hidden_overlap:${signal.signalKey}`),
      ],
    };
  }

  private async runWaveFiveVenueLearning(input: {
    now: Date;
    from: Date;
    to: Date;
  }): Promise<{ warnings: string[] }> {
    const prismaAny = this.prisma as any;
    const warnings: string[] = [];
    const orders = prismaAny.order?.findMany
      ? ((await prismaAny.order.findMany({
          where: {
            createdAt: {
              gte: input.from,
              lte: input.to,
            },
          },
          orderBy: {
            createdAt: 'asc',
          },
        })) as Array<Record<string, unknown>>)
      : [];
    const fills = prismaAny.fill?.findMany
      ? ((await prismaAny.fill.findMany({
          where: {
            filledAt: {
              gte: input.from,
              lte: input.to,
            },
          },
          orderBy: {
            filledAt: 'asc',
          },
        })) as Array<Record<string, unknown>>)
      : [];
    const auditEvents = prismaAny.auditEvent?.findMany
      ? ((await prismaAny.auditEvent.findMany({
          where: {
            createdAt: {
              gte: input.from,
              lte: input.to,
            },
          },
          orderBy: {
            createdAt: 'asc',
          },
        })) as Array<Record<string, unknown>>)
      : [];

    const cancelRequestedByOrderId = selectLatestByKey(
      auditEvents.filter(
        (event) => readString(event.eventType) === 'order.cancel_requested',
      ),
      (event) => readString(event.orderId),
      (event) => readDate(event.createdAt)?.getTime() ?? 0,
    );

    for (const order of orders) {
      const submittedAt = readDate(order.postedAt) ?? readDate(order.createdAt);
      const acknowledgedAt = readDate(order.acknowledgedAt);
      if (submittedAt && acknowledgedAt && acknowledgedAt >= submittedAt) {
        await this.venueHealthLearningStore.recordOpenOrderVisibilityLag(
          acknowledgedAt.getTime() - submittedAt.getTime(),
        );
      }

      const orderId = readString(order.id);
      const cancelRequestedAt = orderId
        ? readDate(cancelRequestedByOrderId.get(orderId)?.createdAt)
        : null;
      const canceledAt = readDate(order.canceledAt);
      if (cancelRequestedAt && canceledAt && canceledAt >= cancelRequestedAt) {
        await this.venueHealthLearningStore.recordCancelAcknowledgmentLag(
          canceledAt.getTime() - cancelRequestedAt.getTime(),
        );
      }
    }

    for (const fill of fills) {
      const createdAt = readDate(fill.createdAt);
      const filledAt = readDate(fill.filledAt);
      if (createdAt && filledAt && createdAt >= filledAt) {
        await this.venueHealthLearningStore.recordTradeVisibilityLag(
          createdAt.getTime() - filledAt.getTime(),
        );
      }
    }

    const metrics = await this.venueHealthLearningStore.getCurrentMetrics();
    const assessment = this.venueUncertaintyDetector.evaluate(metrics);
    const mode = this.venueModePolicy.decide(assessment);
    await this.venueHealthLearningStore.setOperationalAssessment({
      activeMode: mode.mode,
      uncertaintyLabel: assessment.label,
    });

    if (mode.mode !== 'normal') {
      warnings.push(`venue_mode_${mode.mode}`);
    }

    return { warnings };
  }

  private async loadStrategyVersions(): Promise<
    Array<{
      strategyVersionId: string;
      name: string;
      isActive: boolean;
      createdAt: string;
      updatedAt: string;
    }>
  > {
    const prismaAny = this.prisma as any;
    const versions = prismaAny.strategyVersion?.findMany
      ? ((await prismaAny.strategyVersion.findMany({
          orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
        })) as Array<Record<string, unknown>>)
      : [];
    return versions
      .map((version) => ({
        strategyVersionId: readString(version.id) ?? '',
        name: readString(version.name) ?? 'unknown',
        isActive: readBoolean(version.isActive) ?? false,
        createdAt: readDateString(version.createdAt) ?? new Date(0).toISOString(),
        updatedAt: readDateString(version.updatedAt) ?? new Date(0).toISOString(),
      }))
      .filter((version) => version.strategyVersionId.length > 0);
  }

  private async loadRealizedOutcomeSamples(
    from: Date,
    to: Date,
  ): Promise<LearningCycleSample[]> {
    const prismaAny = this.prisma as any;
    const diagnostics = (await prismaAny.executionDiagnostic.findMany({
      where: {
        capturedAt: {
          gte: from,
          lte: to,
        },
      },
      orderBy: {
        capturedAt: 'asc',
      },
    })) as Array<Record<string, unknown>>;

    const orderIds = diagnostics
      .map((diagnostic) => readString(diagnostic.orderId))
      .filter((value): value is string => Boolean(value));
    const orders = orderIds.length
      ? ((await prismaAny.order.findMany({
          where: {
            id: {
              in: orderIds,
            },
          },
          include: {
            signal: true,
            market: true,
          },
        })) as Array<Record<string, unknown>>)
      : [];
    const orderById = new Map(
      orders.map((order) => [readString(order.id) ?? '', order]),
    );

    const samples: LearningCycleSample[] = [];
    for (const diagnostic of diagnostics) {
      const orderId = readString(diagnostic.orderId);
      const order = orderId ? orderById.get(orderId) ?? null : null;
      const signal =
        order?.signal && typeof order.signal === 'object'
          ? (order.signal as Record<string, unknown>)
          : null;
      const market =
        order?.market && typeof order.market === 'object'
          ? (order.market as Record<string, unknown>)
          : null;
      const marketId =
        readString(order?.marketId) ??
        readString(signal?.marketId) ??
        readString(diagnostic.marketId) ??
        null;
      const tokenId = readString(order?.tokenId);
      const observedAt =
        readDateString(diagnostic.capturedAt) ??
        readDateString(signal?.observedAt) ??
        new Date().toISOString();
      const orderbook = marketId && tokenId
        ? ((await prismaAny.orderbook.findFirst({
            where: {
              marketId,
              tokenId,
              observedAt: {
                lte: new Date(observedAt),
              },
            },
            orderBy: {
              observedAt: 'desc',
            },
          })) as Record<string, unknown> | null)
        : null;
      const signalObservedAt = readDate(signal?.observedAt);
      const expiryAt = readDate(market?.expiresAt);
      const acknowledgedAt = readDate(order?.acknowledgedAt) ?? readDate(order?.createdAt);
      const timeToExpirySeconds =
        signalObservedAt && expiryAt
          ? Math.max(0, Math.floor((expiryAt.getTime() - signalObservedAt.getTime()) / 1000))
          : null;
      const entryDelayMs =
        signalObservedAt && acknowledgedAt
          ? Math.max(0, acknowledgedAt.getTime() - signalObservedAt.getTime())
          : null;
      const spread = readNumber(orderbook?.spread, null);
      const side = mapSide(readString(order?.side));
      const strategyVersionId =
        readString(diagnostic.strategyVersionId) ??
        readString(order?.strategyVersionId) ??
        readString(signal?.strategyVersionId);
      const sample: LearningCycleSample = {
        strategyVariantId: strategyVersionId
          ? buildStrategyVariantId(strategyVersionId)
          : 'unknown_strategy_variant',
        regime:
          readString(diagnostic.regime) ??
          readString(signal?.regime) ??
          'unknown_regime',
        side,
        expectedEv:
          readNumber(diagnostic.expectedEv, null) ??
          readNumber(signal?.expectedEv, null) ??
          0,
        realizedEv: readNumber(diagnostic.realizedEv, null) ?? 0,
        fillRate: readNumber(diagnostic.fillRate, null),
        realizedSlippage: readNumber(diagnostic.realizedSlippage, null),
        liquidityDepth: extractTopDepth(orderbook, side),
        spread,
        timeToExpirySeconds,
        entryDelayMs,
        executionStyle: inferExecutionStyle(diagnostic, order),
        observedAt,
        predictedProbability: readNumber(signal?.posteriorProbability, null) ?? 0.5,
        realizedOutcome:
          (readNumber(diagnostic.realizedEv, null) ?? 0) > 0 ? 1 : 0,
      };
      samples.push(sample);
    }

    return samples;
  }

  private async loadExecutionLearningObservations(
    from: Date,
    to: Date,
  ): Promise<ExecutionLearningObservation[]> {
    const prismaAny = this.prisma as any;
    if (!prismaAny.executionDiagnostic?.findMany) {
      return [];
    }

    const diagnostics = ((await prismaAny.executionDiagnostic.findMany({
      where: {
        capturedAt: {
          gte: from,
          lte: to,
        },
      },
      orderBy: {
        capturedAt: 'asc',
      },
    })) as Array<Record<string, unknown>>)
      .filter((diagnostic) => readString(diagnostic.orderId) != null);
    const latestDiagnostics = selectLatestDiagnosticsByOrder(diagnostics);
    const orderIds = latestDiagnostics
      .map((diagnostic) => readString(diagnostic.orderId))
      .filter((value): value is string => value != null);
    if (orderIds.length === 0) {
      return [];
    }

    const orders = prismaAny.order?.findMany
      ? ((await prismaAny.order.findMany({
          where: {
            id: {
              in: orderIds,
            },
          },
          include: {
            signal: true,
          },
        })) as Array<Record<string, unknown>>)
      : [];
    const fills = prismaAny.fill?.findMany
      ? ((await prismaAny.fill.findMany({
          where: {
            orderId: {
              in: orderIds,
            },
            filledAt: {
              gte: from,
              lte: to,
            },
          },
          orderBy: {
            filledAt: 'asc',
          },
        })) as Array<Record<string, unknown>>)
      : [];
    const auditEvents = prismaAny.auditEvent?.findMany
      ? ((await prismaAny.auditEvent.findMany({
          where: {
            orderId: {
              in: orderIds,
            },
            eventType: {
              in: [
                'order.submitted',
                'order.cancel_requested',
                'order.replace_requested',
                'order.market_ineligible',
                'order.cancel_failed',
              ],
            },
            createdAt: {
              lte: to,
            },
          },
          orderBy: {
            createdAt: 'asc',
          },
        })) as Array<Record<string, unknown>>)
      : [];

    const orderById = new Map(
      orders.map((order) => [readString(order.id) ?? '', order]),
    );
    const fillsByOrderId = groupByKey(fills, (fill) => readString(fill.orderId));
    const auditsByOrderId = groupByKey(auditEvents, (event) => readString(event.orderId));

    return latestDiagnostics
      .map((diagnostic) => {
        const orderId = readString(diagnostic.orderId);
        if (!orderId) {
          return null;
        }

        const order = orderById.get(orderId) ?? null;
        const signal =
          order?.signal && typeof order.signal === 'object'
            ? (order.signal as Record<string, unknown>)
            : null;
        const strategyVersionId =
          readString(diagnostic.strategyVersionId) ??
          readString(order?.strategyVersionId) ??
          readString(signal?.strategyVersionId);
        if (!strategyVersionId) {
          return null;
        }

        const orderAudits = auditsByOrderId.get(orderId) ?? [];
        const submissionEvent =
          orderAudits.find((event) => readString(event.eventType) === 'order.submitted') ?? null;
        const route = inferExecutionRoute(diagnostic, order, submissionEvent);
        const fillRate =
          clampRatio(
            readNumber(diagnostic.fillRate, null) ??
              inferOrderFillRatio(order),
          ) ?? 0;
        const cancelAttempted = orderAudits.some((event) =>
          ['order.cancel_requested', 'order.replace_requested', 'order.market_ineligible'].includes(
            readString(event.eventType) ?? '',
          ),
        );
        const cancelFailed = orderAudits.some(
          (event) => readString(event.eventType) === 'order.cancel_failed',
        );
        const status = readString(order?.status);
        const partiallyFilled =
          status === 'partially_filled' ||
          ((readNumber(order?.filledSize, null) ?? 0) > 0 &&
            (readNumber(order?.remainingSize, null) ?? 0) > 0);

        return {
          strategyVariantId: buildStrategyVariantId(strategyVersionId),
          regime: readString(diagnostic.regime) ?? readString(signal?.regime),
          route,
          fillRatio: fillRate,
          fillDelayMs: inferFillDelayMs(order, fillsByOrderId.get(orderId) ?? [], submissionEvent),
          slippage: Math.max(
            0,
            readNumber(diagnostic.realizedSlippage, null) ??
              readNumber(diagnostic.expectedSlippage, 0) ??
              0,
          ),
          cancelAttempted,
          cancelSucceeded:
            cancelAttempted && !cancelFailed
              ? status === 'canceled' || readDate(order?.canceledAt) != null
              : cancelAttempted
                ? false
                : null,
          partiallyFilled,
          observedAt:
            readDateString(diagnostic.capturedAt) ?? inputToIsoString(to),
        } satisfies ExecutionLearningObservation;
      })
      .filter((observation): observation is ExecutionLearningObservation => observation != null)
      .sort((left, right) => left.observedAt.localeCompare(right.observedAt));
  }

  private async loadPortfolioLearningObservations(
    from: Date,
    to: Date,
  ): Promise<PortfolioLearningObservation[]> {
    const prismaAny = this.prisma as any;
    if (!prismaAny.executionDiagnostic?.findMany) {
      return [];
    }

    const diagnostics = ((await prismaAny.executionDiagnostic.findMany({
      where: {
        capturedAt: {
          gte: from,
          lte: to,
        },
      },
      orderBy: {
        capturedAt: 'asc',
      },
    })) as Array<Record<string, unknown>>)
      .filter((diagnostic) => readString(diagnostic.orderId) != null);
    const latestDiagnostics = selectLatestDiagnosticsByOrder(diagnostics);
    const orderIds = latestDiagnostics
      .map((diagnostic) => readString(diagnostic.orderId))
      .filter((value): value is string => value != null);
    if (orderIds.length === 0) {
      return [];
    }

    const orders = prismaAny.order?.findMany
      ? ((await prismaAny.order.findMany({
          where: {
            id: {
              in: orderIds,
            },
          },
          include: {
            signal: true,
          },
        })) as Array<Record<string, unknown>>)
      : [];
    const signals = orders
      .map((order) =>
        order.signal && typeof order.signal === 'object'
          ? (order.signal as Record<string, unknown>)
          : null,
      )
      .filter((signal): signal is Record<string, unknown> => signal != null);
    const signalIds = signals
      .map((signal) => readString(signal.id))
      .filter((value): value is string => value != null);

    const approvedDecisions = prismaAny.signalDecision?.findMany
      ? ((await prismaAny.signalDecision.findMany({
          where: {
            signalId: {
              in: signalIds,
            },
            verdict: 'approved',
          },
          orderBy: {
            decisionAt: 'desc',
          },
        })) as Array<Record<string, unknown>>)
      : [];
    const admissionEvents = prismaAny.auditEvent?.findMany
      ? ((await prismaAny.auditEvent.findMany({
          where: {
            signalId: {
              in: signalIds,
            },
            eventType: 'signal.admission_decision',
          },
          orderBy: {
            createdAt: 'desc',
          },
        })) as Array<Record<string, unknown>>)
      : [];

    const orderById = new Map(
      orders.map((order) => [readString(order.id) ?? '', order]),
    );
    const approvedDecisionBySignalId = selectLatestByKey(
      approvedDecisions,
      (decision) => readString(decision.signalId),
      (decision) => readDate(decision.decisionAt)?.getTime() ?? 0,
    );
    const admissionEventBySignalId = selectLatestByKey(
      admissionEvents,
      (event) => readString(event.signalId),
      (event) => readDate(event.createdAt)?.getTime() ?? 0,
    );

    return latestDiagnostics
      .map((diagnostic) => {
        const orderId = readString(diagnostic.orderId);
        if (!orderId) {
          return null;
        }

        const order = orderById.get(orderId) ?? null;
        const signal =
          order?.signal && typeof order.signal === 'object'
            ? (order.signal as Record<string, unknown>)
            : null;
        const strategyVersionId =
          readString(diagnostic.strategyVersionId) ??
          readString(order?.strategyVersionId) ??
          readString(signal?.strategyVersionId);
        if (!strategyVersionId) {
          return null;
        }

        const signalId = readString(signal?.id);
        const approvedDecision = signalId ? approvedDecisionBySignalId.get(signalId) ?? null : null;
        const admissionEvent = signalId ? admissionEventBySignalId.get(signalId) ?? null : null;
        return {
          strategyVariantId: buildStrategyVariantId(strategyVersionId),
          regime: readString(diagnostic.regime) ?? readString(signal?.regime),
          opportunityClass: readOpportunityClass(admissionEvent),
          allocatedCapital: Math.max(
            0,
            readNumber(approvedDecision?.positionSize, null) ??
              Math.abs(
                (readNumber(order?.price, null) ?? 0) * (readNumber(order?.size, null) ?? 0),
              ) ??
              0,
          ),
          expectedEv:
            readNumber(diagnostic.expectedEv, null) ??
            readNumber(signal?.expectedEv, null) ??
            0,
          realizedEv: readNumber(diagnostic.realizedEv, null) ?? 0,
          observedAt:
            readDateString(diagnostic.capturedAt) ?? to.toISOString(),
        } satisfies PortfolioLearningObservation;
      })
      .filter((observation): observation is PortfolioLearningObservation => observation != null)
      .sort((left, right) => left.observedAt.localeCompare(right.observedAt));
  }

  private async runPhaseOneAlphaAttributionReview(input: {
    now: Date;
    from: Date;
    to: Date;
  }): Promise<{ warnings: string[]; summary: Record<string, unknown> }> {
    const prismaAny = this.prisma as any;
    if (!prismaAny.executionDiagnostic?.findMany) {
      return { warnings: [], summary: {} };
    }

    const diagnostics = ((await prismaAny.executionDiagnostic.findMany({
      where: {
        capturedAt: {
          gte: input.from,
          lte: input.to,
        },
      },
      orderBy: {
        capturedAt: 'asc',
      },
    })) as Array<Record<string, unknown>>)
      .filter((diagnostic) => readString(diagnostic.orderId) != null);
    if (diagnostics.length === 0) {
      return { warnings: [], summary: {} };
    }

    const orderIds = diagnostics
      .map((diagnostic) => readString(diagnostic.orderId))
      .filter((value): value is string => value != null);
    const orders = prismaAny.order?.findMany
      ? ((await prismaAny.order.findMany({
          where: {
            id: {
              in: orderIds,
            },
          },
          include: {
            signal: true,
          },
        })) as Array<Record<string, unknown>>)
      : [];
    const orderById = new Map(
      orders.map((order) => [readString(order.id) ?? '', order]),
    );

    const attributions = diagnostics
      .map((diagnostic) => {
        const orderId = readString(diagnostic.orderId);
        if (!orderId) {
          return null;
        }

        const order = orderById.get(orderId) ?? null;
        const signal =
          order?.signal && typeof order.signal === 'object'
            ? (order.signal as Record<string, unknown>)
            : null;
        const signalDirectionSign =
          (readNumber(signal?.edge, null) ?? 0) < 0 ||
          readString(signal?.outcome) === 'NO'
            ? -1
            : 1;

        return {
          orderId,
          strategyVersionId:
            readString(diagnostic.strategyVersionId) ??
            readString(order?.strategyVersionId) ??
            readString(signal?.strategyVersionId),
          regime: readString(diagnostic.regime) ?? readString(signal?.regime),
          attribution: createAlphaAttribution({
            rawForecastProbability: readNumber(signal?.posteriorProbability, 0.5) ?? 0.5,
            marketImpliedProbability: readNumber(signal?.marketImpliedProb, 0.5) ?? 0.5,
            confidenceAdjustedEdge:
              readNumber(signal?.edge, null) ??
              readNumber(diagnostic.edgeAtSignal, null),
            paperEdge:
              readNumber(signal?.expectedEv, null) != null
                ? signalDirectionSign * Math.abs(readNumber(signal?.expectedEv, 0) ?? 0)
                : readNumber(signal?.edge, null),
            expectedExecutionCost: {
              feeCost: readNumber(diagnostic.expectedFee, 0) ?? 0,
              slippageCost: readNumber(diagnostic.expectedSlippage, 0) ?? 0,
              adverseSelectionCost: Math.max(
                0,
                (readNumber(diagnostic.edgeAtSignal, null) ?? 0) -
                  (readNumber(diagnostic.edgeAtFill, null) ?? readNumber(diagnostic.edgeAtSignal, 0) ?? 0),
              ),
              fillDecayCost: 0,
              cancelReplaceOverheadCost: 0,
              missedOpportunityCost: 0,
              venuePenalty: 0,
            },
            expectedNetEdge: readNumber(diagnostic.expectedEv, null),
            realizedExecutionCost: {
              feeCost: readNumber(diagnostic.realizedFee, 0) ?? 0,
              slippageCost: readNumber(diagnostic.realizedSlippage, 0) ?? 0,
              adverseSelectionCost: Math.max(
                0,
                (readNumber(diagnostic.edgeAtSignal, null) ?? 0) -
                  (readNumber(diagnostic.edgeAtFill, null) ?? readNumber(diagnostic.edgeAtSignal, 0) ?? 0),
              ),
              fillDecayCost: 0,
              cancelReplaceOverheadCost: 0,
              missedOpportunityCost: 0,
              venuePenalty: 0,
            },
            realizedNetEdge: readNumber(diagnostic.realizedEv, null),
            capturedAt: readDateString(diagnostic.capturedAt) ?? input.now.toISOString(),
          }),
        };
      })
      .filter(
        (
          entry,
        ): entry is {
          orderId: string;
          strategyVersionId: string | null;
          regime: string | null;
          attribution: ReturnType<typeof createAlphaAttribution>;
        } => entry != null,
      );
    if (attributions.length === 0) {
      return { warnings: [], summary: {} };
    }

    const averageExpectedNetEdge = averageNullable(
      attributions.map((entry) => entry.attribution.expectedNetEdge),
    );
    const averageRealizedNetEdge = averageNullable(
      attributions.map((entry) => entry.attribution.realizedNetEdge),
    );
    const averageRetentionRatio = averageNullable(
      attributions.map((entry) => entry.attribution.retentionRatio),
    );
    const degradedRetentionCount = attributions.filter(
      (entry) =>
        entry.attribution.retentionRatio != null && entry.attribution.retentionRatio < 0.5,
    ).length;

    if (prismaAny.auditEvent?.create) {
      await prismaAny.auditEvent.create({
        data: {
          eventType: 'learning.alpha_attribution_review',
          message: 'Daily alpha attribution review completed.',
          metadata: {
            window: {
              from: input.from.toISOString(),
              to: input.to.toISOString(),
            },
            sampleCount: attributions.length,
            averageExpectedNetEdge,
            averageRealizedNetEdge,
            averageRetentionRatio,
            degradedRetentionCount,
            recentAlphaAttributions: attributions.slice(-5),
          } as object,
        },
      });
    }

    const warnings: string[] = [];
    if (averageRetentionRatio != null && averageRetentionRatio < 0.5) {
      warnings.push('alpha_retention_degraded');
    }
    if (
      averageExpectedNetEdge != null &&
      averageRealizedNetEdge != null &&
      averageRealizedNetEdge < averageExpectedNetEdge * 0.5
    ) {
      warnings.push('alpha_expected_vs_realized_gap');
    }

    return {
      warnings,
      summary: {
        sampleCount: attributions.length,
        averageExpectedNetEdge,
        averageRealizedNetEdge,
        averageRetentionRatio,
        degradedRetentionCount,
        recentAlphaAttributions: attributions.slice(-5),
      },
    };
  }

  private async runItemTwoRetentionContextReview(input: {
    now: Date;
    from: Date;
    to: Date;
  }): Promise<{ warnings: string[]; summary: Record<string, unknown> }> {
    const prismaAny = this.prisma as any;
    if (!prismaAny.executionDiagnostic?.findMany) {
      return { warnings: [], summary: {} };
    }

    const diagnostics = ((await prismaAny.executionDiagnostic.findMany({
      where: {
        capturedAt: {
          gte: input.from,
          lte: input.to,
        },
      },
      orderBy: {
        capturedAt: 'asc',
      },
    })) as Array<Record<string, unknown>>)
      .filter((diagnostic) => readString(diagnostic.orderId) != null);
    if (diagnostics.length === 0) {
      return { warnings: [], summary: {} };
    }

    const orderIds = diagnostics
      .map((diagnostic) => readString(diagnostic.orderId))
      .filter((value): value is string => value != null);
    const orders = prismaAny.order?.findMany
      ? ((await prismaAny.order.findMany({
          where: {
            id: {
              in: orderIds,
            },
          },
          include: {
            signal: true,
          },
        })) as Array<Record<string, unknown>>)
      : [];
    const orderById = new Map(
      orders.map((order) => [readString(order.id) ?? '', order]),
    );
    const submissionEvents = prismaAny.auditEvent?.findMany
      ? ((await prismaAny.auditEvent.findMany({
          where: {
            orderId: {
              in: orderIds,
            },
            eventType: {
              in: ['order.submitted', 'order.rejected_on_submit'],
            },
          },
          orderBy: {
            createdAt: 'asc',
          },
        })) as Array<Record<string, unknown>>)
      : [];
    const submissionEventByOrderId = new Map<string, Record<string, unknown>>();
    for (const event of submissionEvents) {
      const orderId = readString(event.orderId);
      if (!orderId) {
        continue;
      }
      submissionEventByOrderId.set(orderId, event);
    }

    const report = buildRetentionContextReport({
      observations: diagnostics.map((diagnostic) => {
        const orderId = readString(diagnostic.orderId);
        const order = orderId ? (orderById.get(orderId) ?? null) : null;
        const signal =
          order?.signal && typeof order.signal === 'object'
            ? (order.signal as Record<string, unknown>)
            : null;
        const submissionEvent = orderId
          ? (submissionEventByOrderId.get(orderId) ?? null)
          : null;
        const metadata = submissionEvent ? readMetadata(submissionEvent) : {};
        const retained =
          metadata.retainedEdgeExpectation &&
          typeof metadata.retainedEdgeExpectation === 'object'
            ? (metadata.retainedEdgeExpectation as Record<string, unknown>)
            : null;
        const upstream =
          metadata.upstreamEvaluationEvidence &&
          typeof metadata.upstreamEvaluationEvidence === 'object'
            ? (metadata.upstreamEvaluationEvidence as Record<string, unknown>)
            : null;

        return {
          regime:
            readString(diagnostic.regime) ??
            readString(signal?.regime) ??
            'unknown',
          archetype:
            readString(retained?.marketArchetype) ??
            readString(upstream?.marketArchetype) ??
            'unknown',
          toxicityState:
            readString(retained?.toxicityState) ??
            readString(upstream?.toxicityState) ??
            'unknown',
          expectedNetEdge:
            readNumber(diagnostic.expectedEv, null) ??
            readNumber(metadata.executionAdjustedEdge, null),
          realizedNetEdge: readNumber(diagnostic.realizedEv, null),
        };
      }),
      now: input.now,
    });

    if (report.sampleCount === 0) {
      return { warnings: [], summary: {} };
    }

    if (prismaAny.auditEvent?.create) {
      await prismaAny.auditEvent.create({
        data: {
          eventType: 'learning.retention_context_review',
          message: 'Daily retention context review completed.',
          metadata: {
            window: {
              from: input.from.toISOString(),
              to: input.to.toISOString(),
            },
            ...report,
          } as object,
        },
      });
    }

    const warnings = report.topDegradingContexts
      .filter(
        (entry) =>
          (entry.retentionRatio != null && entry.retentionRatio < 0.5) ||
          entry.realizedVsExpectedGap < 0,
      )
      .slice(0, 2)
      .map(
        (entry) =>
          `retention_context_degraded:${entry.contextType}:${sanitizeReviewLabel(entry.contextValue)}`,
      );

    return {
      warnings,
      summary: report as unknown as Record<string, unknown>,
    };
  }

  private async runItemTwelveCalibrationDriftAlertReview(input: {
    now: Date;
    from: Date;
    to: Date;
  }): Promise<{ warnings: string[]; summary: Record<string, unknown> }> {
    const prismaAny = this.prisma as any;
    if (!prismaAny.executionDiagnostic?.findMany) {
      return { warnings: [], summary: {} };
    }

    const diagnostics = ((await prismaAny.executionDiagnostic.findMany({
      where: {
        capturedAt: {
          gte: input.from,
          lte: input.to,
        },
      },
      orderBy: {
        capturedAt: 'asc',
      },
    })) as Array<Record<string, unknown>>)
      .filter((diagnostic) => readString(diagnostic.orderId) != null);
    if (diagnostics.length === 0) {
      return { warnings: [], summary: {} };
    }

    const orderIds = diagnostics
      .map((diagnostic) => readString(diagnostic.orderId))
      .filter((value): value is string => value != null);
    const orders = prismaAny.order?.findMany
      ? ((await prismaAny.order.findMany({
          where: {
            id: {
              in: orderIds,
            },
          },
          include: {
            signal: true,
          },
        })) as Array<Record<string, unknown>>)
      : [];
    const orderById = new Map(
      orders.map((order) => [readString(order.id) ?? '', order]),
    );
    const submissionEvents = prismaAny.auditEvent?.findMany
      ? ((await prismaAny.auditEvent.findMany({
          where: {
            orderId: {
              in: orderIds,
            },
            eventType: {
              in: ['order.submitted', 'order.rejected_on_submit'],
            },
          },
          orderBy: {
            createdAt: 'asc',
          },
        })) as Array<Record<string, unknown>>)
      : [];
    const submissionEventByOrderId = new Map<string, Record<string, unknown>>();
    for (const event of submissionEvents) {
      const orderId = readString(event.orderId);
      if (!orderId) {
        continue;
      }
      submissionEventByOrderId.set(orderId, event);
    }

    const report = buildCalibrationDriftAlerts({
      observations: diagnostics.map((diagnostic) => {
        const orderId = readString(diagnostic.orderId);
        const order = orderId ? (orderById.get(orderId) ?? null) : null;
        const signal =
          order?.signal && typeof order.signal === 'object'
            ? (order.signal as Record<string, unknown>)
            : null;
        const submissionEvent = orderId
          ? (submissionEventByOrderId.get(orderId) ?? null)
          : null;
        const metadata = submissionEvent ? readMetadata(submissionEvent) : {};
        const retained =
          metadata.retainedEdgeExpectation &&
          typeof metadata.retainedEdgeExpectation === 'object'
            ? (metadata.retainedEdgeExpectation as Record<string, unknown>)
            : null;
        const upstream =
          metadata.upstreamEvaluationEvidence &&
          typeof metadata.upstreamEvaluationEvidence === 'object'
            ? (metadata.upstreamEvaluationEvidence as Record<string, unknown>)
            : null;

        return {
          regime:
            readString(diagnostic.regime) ??
            readString(signal?.regime) ??
            'unknown',
          archetype:
            readString(retained?.marketArchetype) ??
            readString(upstream?.marketArchetype) ??
            readString(signal?.marketArchetype) ??
            'unknown',
          predictedProbability: readNumber(signal?.posteriorProbability, null),
          realizedOutcome:
            (readNumber(diagnostic.realizedEv, null) ?? 0) > 0 ? 1 : 0,
        };
      }),
      now: input.now,
    });

    if (report.sampleCount === 0) {
      return { warnings: [], summary: {} };
    }

    if (prismaAny.auditEvent?.create) {
      await prismaAny.auditEvent.create({
        data: {
          eventType: 'learning.calibration_drift_alert_review',
          message: 'Daily calibration drift alert review completed.',
          metadata: {
            window: {
              from: input.from.toISOString(),
              to: input.to.toISOString(),
            },
            ...report,
          } as object,
        },
      });
    }

    const warnings = [
      ...report.regimeCalibrationAlert
        .filter((entry) => entry.calibrationDriftState === 'alert')
        .slice(0, 2)
        .map(
          (entry) =>
            `calibration_drift_alert:regime:${sanitizeReviewLabel(entry.contextValue)}`,
        ),
      ...report.archetypeCalibrationAlert
        .filter((entry) => entry.calibrationDriftState === 'alert')
        .slice(0, 2)
        .map(
          (entry) =>
            `calibration_drift_alert:archetype:${sanitizeReviewLabel(entry.contextValue)}`,
        ),
    ];

    return {
      warnings,
      summary: report as unknown as Record<string, unknown>,
    };
  }

  private async runItemSixRegimeLocalSizingReview(input: {
    now: Date;
    retentionContextSummary: Record<string, unknown>;
  }): Promise<{ warnings: string[]; summary: Record<string, unknown> }> {
    const retentionByRegime = readRetentionSizingEntries(
      input.retentionContextSummary.retentionByRegime,
      'regime',
    );
    const retentionByArchetype = readRetentionSizingEntries(
      input.retentionContextSummary.retentionByArchetype,
      'archetype',
    );
    if (retentionByRegime.length === 0 && retentionByArchetype.length === 0) {
      return { warnings: [], summary: {} };
    }

    const summary = buildRegimeLocalSizingSummary({
      now: input.now,
      retentionByRegime,
      retentionByArchetype,
    });
    const warnings = summary.mostConstrainedContexts
      .filter((entry) => entry.recommendedSizeMultiplier < 0.8)
      .slice(0, 3)
      .map(
        (entry) =>
          `regime_local_sizing_reduced:${entry.contextType}:${sanitizeReviewLabel(entry.contextValue)}`,
      );

    const prismaAny = this.prisma as any;
    if (prismaAny.auditEvent?.create) {
      await prismaAny.auditEvent.create({
        data: {
          eventType: 'learning.regime_local_sizing_review',
          message: 'Daily regime-local sizing review completed.',
          metadata: summary as object,
        },
      });
    }

    return {
      warnings,
      summary: summary as unknown as Record<string, unknown>,
    };
  }

  private async runItemOneLossAttributionReview(input: {
    now: Date;
    from: Date;
    to: Date;
  }): Promise<{ warnings: string[]; summary: Record<string, unknown> }> {
    const prismaAny = this.prisma as any;
    if (!prismaAny.auditEvent?.findMany) {
      return { warnings: [], summary: {} };
    }

    const events = ((await prismaAny.auditEvent.findMany({
      where: {
        createdAt: {
          gte: input.from,
          lte: input.to,
        },
        eventType: 'trade.loss_attribution_classified',
      },
      orderBy: {
        createdAt: 'asc',
      },
    })) as Array<Record<string, unknown>>)
      .map((event) => {
        const metadata = readMetadata(event);
        const lossAttribution =
          metadata.lossAttribution && typeof metadata.lossAttribution === 'object'
            ? (metadata.lossAttribution as Record<string, unknown>)
            : null;
        if (!lossAttribution) {
          return null;
        }

        return {
          orderId: readString(event.orderId),
          signalId: readString(event.signalId),
          createdAt: readDateString(event.createdAt) ?? input.now.toISOString(),
          lossCategory: readString(lossAttribution.lossCategory) ?? 'mixed',
          primaryLeakageDriver:
            readString(lossAttribution.primaryLeakageDriver) ?? 'mixed',
          forecastQualityAssessment:
            readString(lossAttribution.forecastQualityAssessment) ?? 'watch',
          executionQualityAssessment:
            readString(lossAttribution.executionQualityAssessment) ?? 'watch',
          secondaryLeakageDrivers: Array.isArray(lossAttribution.secondaryLeakageDrivers)
            ? lossAttribution.secondaryLeakageDrivers
                .filter((driver): driver is string => typeof driver === 'string')
                .sort()
            : [],
          lossReasonCodes: Array.isArray(lossAttribution.lossReasonCodes)
            ? lossAttribution.lossReasonCodes
                .filter((code): code is string => typeof code === 'string')
                .sort()
            : [],
        };
      })
      .filter(
        (
          event,
        ): event is {
          orderId: string | null;
          signalId: string | null;
          createdAt: string;
          lossCategory: string;
          primaryLeakageDriver: string;
          forecastQualityAssessment: string;
          executionQualityAssessment: string;
          secondaryLeakageDrivers: string[];
          lossReasonCodes: string[];
        } => event != null,
      );

    if (events.length === 0) {
      return { warnings: [], summary: {} };
    }

    const categoryCounts = countBy(events.map((event) => event.lossCategory));
    const primaryLeakageDriverCounts = countBy(
      events.map((event) => event.primaryLeakageDriver),
    );
    const forecastQualityAssessmentCounts = countBy(
      events.map((event) => event.forecastQualityAssessment),
    );
    const executionQualityAssessmentCounts = countBy(
      events.map((event) => event.executionQualityAssessment),
    );
    const reasonCodeCounts = countBy(
      events.flatMap((event) => event.lossReasonCodes),
    );
    const dominantLossCategory = dominantKey(categoryCounts);
    const dominantPrimaryLeakageDriver = dominantKey(primaryLeakageDriverCounts);

    const summary = {
      sampleCount: events.length,
      categoryCounts,
      primaryLeakageDriverCounts,
      forecastQualityAssessmentCounts,
      executionQualityAssessmentCounts,
      reasonCodeCounts,
      dominantLossCategory,
      dominantPrimaryLeakageDriver,
      recentClassifications: events.slice(-5),
    };

    if (prismaAny.auditEvent?.create) {
      await prismaAny.auditEvent.create({
        data: {
          eventType: 'learning.loss_attribution_review',
          message: 'Daily loss attribution review completed.',
          metadata: {
            window: {
              from: input.from.toISOString(),
              to: input.to.toISOString(),
            },
            ...summary,
          } as object,
        },
      });
    }

    const warnings: string[] = [];
    if (
      dominantLossCategory &&
      (categoryCounts[dominantLossCategory] ?? 0) / events.length >= 0.5
    ) {
      warnings.push(`loss_attribution_dominant:${dominantLossCategory}`);
    }
    if (
      dominantPrimaryLeakageDriver &&
      (primaryLeakageDriverCounts[dominantPrimaryLeakageDriver] ?? 0) / events.length >= 0.5
    ) {
      warnings.push(`primary_leakage_dominant:${dominantPrimaryLeakageDriver}`);
    }

    return {
      warnings,
      summary,
    };
  }

  private async runPhaseThreeToxicityReview(input: {
    now: Date;
    from: Date;
    to: Date;
  }): Promise<{ warnings: string[]; summary: Record<string, unknown> }> {
    const prismaAny = this.prisma as any;
    if (!prismaAny.auditEvent?.findMany) {
      return { warnings: [], summary: {} };
    }

    const events = ((await prismaAny.auditEvent.findMany({
      where: {
        createdAt: {
          gte: input.from,
          lte: input.to,
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
    })) as Array<Record<string, unknown>>)
      .map((event) => {
        const metadata = readMetadata(event);
        const toxicity =
          metadata.toxicity && typeof metadata.toxicity === 'object'
            ? (metadata.toxicity as Record<string, unknown>)
            : null;

        if (!toxicity) {
          return null;
        }

        return {
          eventType: readString(event.eventType) ?? 'unknown',
          toxicityScore: readNumber(toxicity.toxicityScore, null),
          toxicityState: readString(toxicity.toxicityState) ?? 'unknown',
          recommendedAction: readString(toxicity.recommendedAction) ?? 'unknown',
          toxicityMomentum: readNumber(toxicity.toxicityMomentum, null),
          toxicityShock: readNumber(toxicity.toxicityShock, null),
          toxicityPersistence: readNumber(toxicity.toxicityPersistence, null),
        };
      })
      .filter(
        (
          entry,
        ): entry is {
          eventType: string;
          toxicityScore: number | null;
          toxicityState: string;
          recommendedAction: string;
          toxicityMomentum: number | null;
          toxicityShock: number | null;
          toxicityPersistence: number | null;
        } => entry != null,
      );

    if (events.length === 0) {
      return { warnings: [], summary: {} };
    }

    const averageToxicityScore = averageNullable(events.map((event) => event.toxicityScore));
    const averageToxicityMomentum = averageNullable(
      events.map((event) => event.toxicityMomentum),
    );
    const averageToxicityShock = averageNullable(events.map((event) => event.toxicityShock));
    const averageToxicityPersistence = averageNullable(
      events.map((event) => event.toxicityPersistence),
    );
    const blockedCount = events.filter(
      (event) => event.recommendedAction === 'temporarily_block_regime',
    ).length;
    const aggressiveExecutionDisabledCount = events.filter(
      (event) => event.recommendedAction === 'disable_aggressive_execution',
    ).length;
    const actionCounts = events.reduce<Record<string, number>>((counts, event) => {
      counts[event.recommendedAction] = (counts[event.recommendedAction] ?? 0) + 1;
      return counts;
    }, {});
    const recomputedTrend = this.toxicityTrend.evaluate({
      currentToxicityScore: events[events.length - 1]?.toxicityScore ?? 0,
      recentHistory: events
        .map((event) =>
          event.toxicityScore == null
            ? null
            : {
                toxicityScore: event.toxicityScore,
                toxicityState: event.toxicityState,
                recommendedAction: event.recommendedAction,
              },
        )
        .filter((event): event is { toxicityScore: number; toxicityState: string; recommendedAction: string } => event != null),
    });
    const summary = {
      window: {
        from: input.from.toISOString(),
        to: input.to.toISOString(),
      },
      sampleCount: events.length,
      averageToxicityScore,
      averageToxicityMomentum,
      averageToxicityShock,
      averageToxicityPersistence,
      blockedCount,
      aggressiveExecutionDisabledCount,
      actionCounts,
      recentToxicityEvents: events.slice(-10),
      recomputedTrend,
    };

    if (prismaAny.auditEvent?.create) {
      await prismaAny.auditEvent.create({
        data: {
          eventType: 'learning.toxicity_review',
          message: 'Daily toxicity review completed.',
          metadata: summary as object,
        },
      });
    }

    const warnings: string[] = [];
    if ((averageToxicityScore ?? 0) >= 0.68) {
      warnings.push('toxicity_pressure_elevated');
    }
    if (blockedCount > 0) {
      warnings.push('toxicity_temporarily_blocked_regime');
    }
    if ((averageToxicityPersistence ?? recomputedTrend.toxicityPersistence) >= 0.55) {
      warnings.push('toxicity_persistence_elevated');
    }
    if ((averageToxicityShock ?? recomputedTrend.toxicityShock) >= 0.55) {
      warnings.push('toxicity_shock_detected');
    }

    return { warnings, summary };
  }

  private async runPhaseFourLiveSizingFeedbackReview(input: {
    now: Date;
    from: Date;
    to: Date;
    learningState: LearningState;
    capitalGrowthReport: Awaited<ReturnType<CapitalGrowthReviewJob['run']>>['report'];
  }): Promise<{ warnings: string[]; summary: Record<string, unknown> }> {
    const prismaAny = this.prisma as any;
    const [diagnostics, auditEvents, venueMetrics] = await Promise.all([
      prismaAny.executionDiagnostic?.findMany
        ? prismaAny.executionDiagnostic.findMany({
            where: {
              capturedAt: {
                gte: input.from,
                lte: input.to,
              },
            },
            orderBy: {
              capturedAt: 'asc',
            },
          })
        : Promise.resolve([]),
      prismaAny.auditEvent?.findMany
        ? prismaAny.auditEvent.findMany({
            where: {
              createdAt: {
                gte: input.from,
                lte: input.to,
              },
            },
            orderBy: {
              createdAt: 'asc',
            },
          })
        : Promise.resolve([]),
      this.venueHealthLearningStore.getCurrentMetrics(),
    ]);

    const latestAlphaReview = [...((auditEvents ?? []) as Array<Record<string, unknown>>)]
      .filter((event) => readString(event.eventType) === 'learning.alpha_attribution_review')
      .sort(
        (left, right) =>
          (readDate(right.createdAt)?.getTime() ?? Number.NEGATIVE_INFINITY) -
          (readDate(left.createdAt)?.getTime() ?? Number.NEGATIVE_INFINITY),
      )[0];
    const latestAlphaMetadata = latestAlphaReview ? readMetadata(latestAlphaReview) : {};
    const averageExpectedNetEdge = readNumber(latestAlphaMetadata.averageExpectedNetEdge, null);
    const averageRealizedNetEdge = readNumber(latestAlphaMetadata.averageRealizedNetEdge, null);
    const retentionRatio =
      input.capitalGrowthReport.retentionReport?.aggregateRetentionRatio ??
      readNumber(latestAlphaMetadata.averageRetentionRatio, null);

    const toxicityEvents = ((auditEvents ?? []) as Array<Record<string, unknown>>)
      .map((event) => {
        const metadata = readMetadata(event);
        const toxicity =
          metadata.toxicity && typeof metadata.toxicity === 'object'
            ? (metadata.toxicity as Record<string, unknown>)
            : null;
        if (!toxicity) {
          return null;
        }

        return {
          toxicityScore: readNumber(toxicity.toxicityScore, null),
          recommendedAction: readString(toxicity.recommendedAction),
        };
      })
      .filter(
        (
          value,
        ): value is {
          toxicityScore: number | null;
          recommendedAction: string | null;
        } => value != null,
      );
    const averageToxicityScore = averageNullable(
      toxicityEvents.map((event) => event.toxicityScore),
    );
    const toxicityState =
      toxicityEvents.some((event) => event.recommendedAction === 'temporarily_block_regime')
        ? 'blocked'
        : toxicityEvents.some(
              (event) => event.recommendedAction === 'disable_aggressive_execution',
            ) || (averageToxicityScore ?? 0) >= 0.68
          ? 'high'
          : toxicityEvents.some((event) => event.recommendedAction === 'reduce_size') ||
              toxicityEvents.some((event) => event.recommendedAction === 'widen_threshold') ||
              (averageToxicityScore ?? 0) >= 0.4
            ? 'elevated'
            : 'normal';

    const calibrationHealth = worstNullableHealth(
      Object.values(input.learningState.calibration).map((calibration) => calibration.health),
    );
    let regimeDegradation = worstNullableHealth(
      Object.values(input.learningState.strategyVariants).flatMap((variant) => [
        variant.health,
        ...Object.values(variant.regimeSnapshots).map((snapshot) => snapshot.health),
      ]),
    );
    if (
      input.capitalGrowthReport.baselineComparison &&
      input.capitalGrowthReport.baselineComparison.underperformedBenchmarkIds.length >
        input.capitalGrowthReport.baselineComparison.outperformedBenchmarkIds.length
    ) {
      regimeDegradation =
        regimeDegradation == null || regimeDegradation === 'healthy'
          ? 'watch'
          : regimeDegradation;
    }
    const realizedVsExpected = minimumNullable(
      Object.values(input.learningState.strategyVariants).flatMap((variant) =>
        Object.values(variant.regimeSnapshots).map((snapshot) => snapshot.realizedVsExpected),
      ),
    );
    const executionDrift = averageNullable(
      ((diagnostics ?? []) as Array<Record<string, unknown>>).map((diagnostic) =>
        readNumber(diagnostic.evDrift, null),
      ),
    );
    const venueAssessment = this.venueUncertaintyDetector.evaluate(venueMetrics);
    const liveSizingFeedback = this.liveSizingFeedbackPolicy.evaluate({
      retentionRatio,
      calibrationHealth,
      executionDrift,
      regimeDegradation,
      toxicityState,
      venueUncertainty: venueAssessment.label,
      realizedVsExpected:
        input.capitalGrowthReport.liveProofScorecard?.proofScore != null
          ? minimumNullable([
              averageExpectedNetEdge != null && Math.abs(averageExpectedNetEdge) > 1e-9
                ? (averageRealizedNetEdge ?? 0) / averageExpectedNetEdge
                : realizedVsExpected,
              input.capitalGrowthReport.liveProofScorecard.proofScore,
            ])
          : averageExpectedNetEdge != null && Math.abs(averageExpectedNetEdge) > 1e-9
          ? (averageRealizedNetEdge ?? 0) / averageExpectedNetEdge
          : realizedVsExpected,
    });
    const liveSizingRecoveryProbationState =
      typeof liveSizingFeedback.recoveryProbationState === 'string'
        ? liveSizingFeedback.recoveryProbationState
        : 'none';
    const liveSizingUpshiftEligibility =
      typeof liveSizingFeedback.upshiftEligibility === 'string'
        ? liveSizingFeedback.upshiftEligibility
        : 'eligible';

    if (prismaAny.auditEvent?.create) {
      await prismaAny.auditEvent.create({
        data: {
          eventType: 'learning.live_sizing_feedback_review',
          message: 'Daily live sizing feedback review completed.',
          metadata: {
            window: {
              from: input.from.toISOString(),
              to: input.to.toISOString(),
            },
            sampleCount: (diagnostics ?? []).length,
            venueAssessment,
            inputs: liveSizingFeedback.evidence,
            decision: liveSizingFeedback,
          } as object,
        },
      });
    }

    const warnings: string[] = [];
    if (liveSizingFeedback.sizeMultiplier < 0.85) {
      warnings.push('live_sizing_feedback_size_reduced');
    }
    if (liveSizingRecoveryProbationState !== 'none') {
      warnings.push(
        `live_sizing_feedback_recovery_probation_${liveSizingRecoveryProbationState}`,
      );
    }
    if (liveSizingUpshiftEligibility !== 'eligible') {
      warnings.push(
        `live_sizing_feedback_upshift_${liveSizingUpshiftEligibility}`,
      );
    }
    if (liveSizingFeedback.aggressionCap === 'passive_only') {
      warnings.push('live_sizing_feedback_passive_only');
    }
    if (liveSizingFeedback.regimePermissionOverride === 'reduce_only') {
      warnings.push('live_sizing_feedback_reduce_only');
    }
    if (liveSizingFeedback.regimePermissionOverride === 'block_new_entries') {
      warnings.push('live_sizing_feedback_blocks_new_entries');
    }

    return {
      warnings,
      summary: {
        averageExpectedNetEdge,
        averageRealizedNetEdge,
        retentionRatio,
        benchmarkUnderperformanceCount:
          input.capitalGrowthReport.baselineComparison?.underperformedBenchmarkIds.length ?? 0,
        benchmarkOutperformanceCount:
          input.capitalGrowthReport.baselineComparison?.outperformedBenchmarkIds.length ?? 0,
        proofScore: input.capitalGrowthReport.liveProofScorecard?.proofScore ?? null,
        decision: liveSizingFeedback,
      },
    };
  }

  private async runPhaseFiveBaselineBenchmarkReview(input: {
    now: Date;
    baselineComparison: Awaited<ReturnType<CapitalGrowthReviewJob['run']>>['report']['baselineComparison'];
  }): Promise<{ warnings: string[] }> {
    if (!input.baselineComparison) {
      return { warnings: [] };
    }

    const prismaAny = this.prisma as any;
    if (prismaAny.auditEvent?.create) {
      await prismaAny.auditEvent.create({
        data: {
          eventType: 'learning.baseline_benchmark_review',
          message: 'Daily baseline benchmark review completed.',
          metadata: {
            generatedAt: input.baselineComparison.generatedAt,
            outperformedBenchmarkIds: input.baselineComparison.outperformedBenchmarkIds,
            underperformedBenchmarkIds: input.baselineComparison.underperformedBenchmarkIds,
            comparisons: input.baselineComparison.comparisons,
          } as object,
        },
      });
    }

    return {
      warnings: input.baselineComparison.underperformedBenchmarkIds.map(
        (benchmarkId) => `baseline_underperformance:${benchmarkId}`,
      ),
    };
  }

  private async runItemSevenBenchmarkRelativeSizingReview(input: {
    now: Date;
    baselineComparison: Awaited<ReturnType<CapitalGrowthReviewJob['run']>>['report']['baselineComparison'];
  }): Promise<{ warnings: string[]; summary: Record<string, unknown> }> {
    if (!input.baselineComparison) {
      return { warnings: [], summary: {} };
    }

    const regimePenalties = input.baselineComparison.strategy.regimeBreakdown
      .map((context) => {
        const decision = this.benchmarkRelativeSizing.evaluate({
          regime: context.regime,
          overallUnderperformedBenchmarkIds:
            input.baselineComparison?.underperformedBenchmarkIds ?? [],
          overallOutperformedBenchmarkIds:
            input.baselineComparison?.outperformedBenchmarkIds ?? [],
          strategyRegimeBreakdown: input.baselineComparison?.strategy.regimeBreakdown ?? [],
          benchmarks:
            input.baselineComparison?.benchmarks.map((benchmark) => ({
              benchmarkId: benchmark.benchmarkId,
              benchmarkName: benchmark.benchmarkName,
              regimeBreakdown: benchmark.regimeBreakdown,
            })) ?? [],
        });
        return {
          regime: context.regime,
          baselinePenaltyMultiplier: decision.baselinePenaltyMultiplier,
          benchmarkComparisonState: decision.benchmarkComparisonState,
          regimeBenchmarkGateState: decision.regimeBenchmarkGateState,
          promotionBlockedByBenchmark: decision.promotionBlockedByBenchmark,
          regimeBenchmarkReasonCodes: decision.regimeBenchmarkReasonCodes,
          benchmarkPenaltyReasonCodes: decision.benchmarkPenaltyReasonCodes,
          sampleCount: context.sampleCount,
          tradeCount: context.tradeCount,
        };
      })
      .sort(
        (left, right) => left.baselinePenaltyMultiplier - right.baselinePenaltyMultiplier,
      )
      .slice(0, 12);
    const warnings = regimePenalties
      .filter((entry) => entry.baselinePenaltyMultiplier < 1)
      .slice(0, 3)
      .map(
        (entry) =>
          `benchmark_relative_sizing:${sanitizeReviewLabel(entry.regime)}:${entry.benchmarkComparisonState}`,
      );
    warnings.push(
      ...regimePenalties
        .filter((entry) => entry.promotionBlockedByBenchmark)
        .slice(0, 3)
        .map(
          (entry) =>
            `regime_benchmark_gate:${sanitizeReviewLabel(entry.regime)}:${entry.regimeBenchmarkGateState}`,
        ),
    );
    const summary = {
      generatedAt: input.now.toISOString(),
      underperformedBenchmarkIds: input.baselineComparison.underperformedBenchmarkIds,
      outperformedBenchmarkIds: input.baselineComparison.outperformedBenchmarkIds,
      promotionBlockedRegimes: regimePenalties
        .filter((entry) => entry.promotionBlockedByBenchmark)
        .map((entry) => entry.regime),
      regimePenalties,
    };

    const prismaAny = this.prisma as any;
    if (prismaAny.auditEvent?.create) {
      await prismaAny.auditEvent.create({
        data: {
          eventType: 'learning.benchmark_relative_sizing_review',
          message: 'Daily benchmark-relative sizing review completed.',
          metadata: summary as object,
        },
      });
    }

    return {
      warnings,
      summary,
    };
  }

  private async runItemEightRollingBenchmarkScorecardReview(input: {
    now: Date;
    rollingBenchmarkScorecard: Awaited<
      ReturnType<CapitalGrowthReviewJob['run']>
    >['report']['rollingBenchmarkScorecard'];
  }): Promise<{ warnings: string[]; summary: Record<string, unknown> }> {
    if (!input.rollingBenchmarkScorecard) {
      return { warnings: [], summary: {} };
    }

    const windows = input.rollingBenchmarkScorecard.windows.map((window) => ({
      windowKey: window.windowKey,
      requestedDays: window.requestedDays,
      effectiveDays: window.effectiveDays,
      exactWindowAvailable: window.exactWindowAvailable,
      sampleCount: window.sampleCount,
      tradeCount: window.tradeCount,
      benchmarkComparisonState: window.benchmarkComparisonState,
      outperformedBenchmarkIds: window.outperformedBenchmarkIds,
      underperformedBenchmarkIds: window.underperformedBenchmarkIds,
      strategyRealizedEv: window.strategyRealizedEv,
      strategyRetainedEdge: window.strategyRetainedEdge,
    }));
    const warnings = windows
      .filter((window) => window.benchmarkComparisonState === 'underperforming')
      .map((window) => `rolling_benchmark_underperformance:${window.windowKey}`);
    const summary = {
      generatedAt: input.now.toISOString(),
      anchoredAt: input.rollingBenchmarkScorecard.anchoredAt,
      observationRange: input.rollingBenchmarkScorecard.observationRange,
      windows,
      stabilityOfOutperformance:
        input.rollingBenchmarkScorecard.stabilityOfOutperformance,
    };

    const prismaAny = this.prisma as any;
    if (prismaAny.auditEvent?.create) {
      await prismaAny.auditEvent.create({
        data: {
          eventType: 'learning.rolling_benchmark_scorecard_review',
          message: 'Daily rolling benchmark scorecard review completed.',
          metadata: summary as object,
        },
      });
    }

    return {
      warnings,
      summary,
    };
  }

  private async runPhaseSixValidationProofReview(input: {
    cycleId: string;
    now: Date;
    learningState: LearningState;
    registry: Awaited<ReturnType<StrategyDeploymentRegistry['load']>>;
    capitalGrowthReport: Awaited<ReturnType<CapitalGrowthReviewJob['run']>>['report'];
  }): Promise<{ warnings: string[] }> {
    const liveProofScorecard = input.capitalGrowthReport.liveProofScorecard;
    const regimePerformanceReport = input.capitalGrowthReport.regimePerformanceReport;
    const retentionReport = input.capitalGrowthReport.retentionReport;
    if (!liveProofScorecard || !regimePerformanceReport || !retentionReport) {
      return { warnings: [] };
    }

    const prismaAny = this.prisma as any;
    if (prismaAny.auditEvent?.create) {
      await prismaAny.auditEvent.create({
        data: {
          eventType: 'learning.live_proof_review',
          message: liveProofScorecard.summary,
          metadata: {
            liveProofScorecard,
            benchmarkComparisonSummary: regimePerformanceReport.benchmarkComparisonSummary,
            weakestRegimes: regimePerformanceReport.weakestRegimes,
            strongestRegimes: regimePerformanceReport.strongestRegimes,
            toxicityConditionedResults: regimePerformanceReport.toxicityConditionedResults,
            aggregateRetentionRatio: retentionReport.aggregateRetentionRatio,
          } as object,
        },
      });
    }

    await this.versionLineageRegistry.recordDecision({
      decisionId: `${input.cycleId}:live-proof-review`,
      decisionType: 'learning_cycle',
      recordedAt: input.now.toISOString(),
      summary: liveProofScorecard.summary,
      strategyVariantId: input.registry.incumbentVariantId,
      cycleId: input.cycleId,
      lineage: {
        strategyVersion: buildStrategyVersionLineage({
          strategyVersionId:
            input.registry.incumbentVariantId != null
              ? input.registry.variants[input.registry.incumbentVariantId]?.strategyVersionId ?? null
              : null,
          strategyVariantId: input.registry.incumbentVariantId,
        }),
        featureSetVersion: buildFeatureSetVersionLineage({
          featureSetId: 'phase6-live-proof-scorecard',
          parentStrategyVersionId:
            input.registry.incumbentVariantId != null
              ? input.registry.variants[input.registry.incumbentVariantId]?.strategyVersionId ?? null
              : null,
          parameters: {
            evidenceClass: liveProofScorecard.evidenceClass,
            proofScore: liveProofScorecard.proofScore,
            recommendation: liveProofScorecard.recommendation,
          },
        }),
        calibrationVersion: buildCalibrationVersionLineage(
          input.registry.incumbentVariantId != null
            ? findCalibrationForVariantState(input.learningState, input.registry.incumbentVariantId)
            : null,
        ),
        executionPolicyVersion: buildExecutionPolicyVersionLineage(
          input.registry.incumbentVariantId != null
            ? findExecutionPolicyVersionForVariant(
                input.learningState,
                input.registry.incumbentVariantId,
              )
            : null,
        ),
        riskPolicyVersion: buildRiskPolicyVersionLineage({
          policyId: 'phase6-live-proof-scorecard',
          parameters: {
            liveProofScorecard,
            weakestRegimes: regimePerformanceReport.weakestRegimes,
            benchmarkComparisonSummary: regimePerformanceReport.benchmarkComparisonSummary,
          },
        }),
        allocationPolicyVersion: null,
      },
      replay: {
        marketState: null,
        runtimeState: {
          cycleId: input.cycleId,
        },
        learningState: {
          liveProofScorecard,
          retentionReport,
          regimePerformanceReport,
        },
        lineageState: {
          incumbentVariantId: input.registry.incumbentVariantId,
          activeRollout: input.registry.activeRollout,
        },
        activeParameterBundle: {
          benchmarkComparisonSummary: regimePerformanceReport.benchmarkComparisonSummary,
          weakestRegimes: regimePerformanceReport.weakestRegimes,
          strongestRegimes: regimePerformanceReport.strongestRegimes,
        },
        venueMode: null,
        venueUncertainty: null,
      },
      tags: buildValidationProofTags({
        mode:
          liveProofScorecard.evidenceClass === 'synthetic_smoke_only'
            ? 'synthetic_smoke'
            : 'empirical',
        promotableEvidence: liveProofScorecard.promotableEvidence,
        underperformedBenchmarkIds:
          regimePerformanceReport.benchmarkComparisonSummary.underperformedBenchmarkIds,
        blockers: liveProofScorecard.blockers,
      }),
    });

    return {
      warnings: [
        ...liveProofScorecard.blockers.map((blocker) => `live_proof_blocker:${blocker}`),
        ...regimePerformanceReport.weakestRegimes.map(
          (regime) => `live_proof_weak_regime:${regime}`,
        ),
      ],
    };
  }
}

export function isLearningCycleDue(
  lastCycleCompletedAt: string | null,
  now: Date,
): boolean {
  if (!lastCycleCompletedAt) {
    return true;
  }

  const completedAt = new Date(lastCycleCompletedAt);
  if (Number.isNaN(completedAt.getTime())) {
    return true;
  }

  return now.getTime() - completedAt.getTime() >= ONE_DAY_MS;
}

function determineLearningWindow(
  lastCycleCompletedAt: string | null,
  now: Date,
): { from: Date; to: Date } {
  const fallback = new Date(now.getTime() - ONE_DAY_MS);
  if (!lastCycleCompletedAt) {
    return { from: fallback, to: now };
  }

  const parsed = new Date(lastCycleCompletedAt);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() >= now.getTime()) {
    return { from: fallback, to: now };
  }

  return { from: parsed, to: now };
}

function appendWarnings(
  summary: LearningCycleSummary,
  warnings: string[],
): LearningCycleSummary {
  return {
    ...summary,
    warnings: [...summary.warnings, ...warnings],
  };
}

function attachReviewOutputs(
  summary: LearningCycleSummary,
  reviewOutputs: Record<string, unknown>,
): LearningCycleSummary {
  return {
    ...summary,
    reviewOutputs,
  };
}

function averageNullable(values: Array<number | null | undefined>): number | null {
  const filtered = values.filter((value): value is number => Number.isFinite(value ?? Number.NaN));
  if (filtered.length === 0) {
    return null;
  }

  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function minimumNullable(values: Array<number | null | undefined>): number | null {
  const filtered = values.filter((value): value is number => Number.isFinite(value ?? Number.NaN));
  if (filtered.length === 0) {
    return null;
  }

  return Math.min(...filtered);
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((accumulator, value) => {
    if (value.length === 0) {
      return accumulator;
    }
    accumulator[value] = (accumulator[value] ?? 0) + 1;
    return accumulator;
  }, {});
}

function dominantKey(counts: Record<string, number>): string | null {
  let dominant: string | null = null;
  let bestCount = -1;
  for (const [key, count] of Object.entries(counts)) {
    if (count > bestCount) {
      dominant = key;
      bestCount = count;
    }
  }
  return dominant;
}

function buildCapitalAllocationEvent(
  cycleId: string,
  now: Date,
  decision: PortfolioAllocationDecisionRecord,
): LearningEvent {
  return {
    id: `${cycleId}:capital-allocation:${decision.strategyVariantId}`,
    type: 'capital_allocation_decided',
    severity:
      decision.status === 'reduce'
        ? 'warning'
        : decision.status === 'block_scale'
          ? 'warning'
          : 'info',
    createdAt: now.toISOString(),
    cycleId,
    strategyVariantId: decision.strategyVariantId,
    contextKey: null,
    summary: `Capital allocation ${decision.status} for ${decision.strategyVariantId}.`,
    details: decision.evidence,
  };
}

function findCalibrationForVariantState(
  learningState: LearningState,
  strategyVariantId: string,
) {
  return (
    Object.values(learningState.calibration).find(
      (calibration) => calibration.strategyVariantId === strategyVariantId,
    ) ?? null
  );
}

function findExecutionPolicyVersionForVariant(
  learningState: LearningState,
  strategyVariantId: string,
) {
  const activeVersionIds = new Set(
    Object.entries(learningState.executionLearning.activePolicyVersionIds)
      .filter(([contextKey]) => contextKey.includes(strategyVariantId))
      .map(([, versionId]) => versionId),
  );
  for (const versionId of activeVersionIds) {
    const version = learningState.executionLearning.policyVersions[versionId];
    if (version) {
      return version;
    }
  }
  return (
    Object.values(learningState.executionLearning.policyVersions).find(
      (version) => version.strategyVariantId === strategyVariantId,
    ) ?? null
  );
}

function buildPromotionStabilityContextShares(
  variantState: LearningState['strategyVariants'][string],
) {
  return Object.entries(variantState.regimeSnapshots).map(([contextKey, snapshot]) => ({
    contextKey,
    realizedContribution: snapshot.realizedEvSum,
    sampleCount: snapshot.sampleCount,
    realizedVsExpected: snapshot.realizedVsExpected,
  }));
}

function findVariantDrawdown(
  learningState: LearningState,
  strategyVariantId: string,
) {
  return (
    Object.values(learningState.portfolioLearning.drawdownBySleeve).find(
      (drawdown) =>
        drawdown.sleeveType === 'variant' && drawdown.sleeveValue === strategyVariantId,
    ) ?? null
  );
}

function worstHealth(
  values: Array<'healthy' | 'watch' | 'degraded' | 'quarantine_candidate'>,
) {
  const priority = {
    healthy: 0,
    watch: 1,
    degraded: 2,
    quarantine_candidate: 3,
  };

  return values.reduce<'healthy' | 'watch' | 'degraded' | 'quarantine_candidate'>(
    (worst, value) => (priority[value] > priority[worst] ? value : worst),
    'healthy',
  );
}

function worstNullableHealth(
  values: Array<'healthy' | 'watch' | 'degraded' | 'quarantine_candidate' | null | undefined>,
) {
  const filtered = values.filter(
    (value): value is 'healthy' | 'watch' | 'degraded' | 'quarantine_candidate' => value != null,
  );
  if (filtered.length === 0) {
    return null;
  }

  return worstHealth(filtered);
}

function buildSyntheticPromotionTradeQualityScores(
  strategyVariantId: string,
  variantState: LearningState['strategyVariants'][string],
  shadowEvidence: {
    realizedVsExpected: number | null;
    realizedPnl: number;
  },
): TradeQualityScore[] {
  const snapshots = Object.values(variantState.regimeSnapshots);
  if (snapshots.length === 0) {
    return [];
  }

  return snapshots.map((snapshot, index) => {
    const expectedEv =
      Number.isFinite(snapshot.expectedEvSum) && snapshot.expectedEvSum !== 0
        ? snapshot.expectedEvSum
        : snapshot.avgExpectedEv;
    const realizedEv =
      Number.isFinite(snapshot.realizedEvSum) && snapshot.realizedEvSum !== 0
        ? snapshot.realizedEvSum
        : shadowEvidence.realizedPnl;
    const overallScore =
      snapshot.realizedVsExpected >= 1.1
        ? 0.82
        : snapshot.realizedVsExpected >= 0.95
          ? 0.7
          : snapshot.realizedVsExpected >= 0.8
            ? 0.55
            : 0.35;

    return {
      tradeId: `promotion-fallback:${strategyVariantId}:${index}`,
      orderId: null,
      signalId: null,
      marketId: null,
      strategyVariantId,
      regime: snapshot.regime,
      marketContext: 'promotion_shadow_evaluation',
      executionStyle: snapshot.executionStyle,
      evaluatedAt: snapshot.lastObservedAt ?? new Date().toISOString(),
      label:
        overallScore >= 0.8
          ? 'excellent'
          : overallScore >= 0.65
            ? 'good'
            : overallScore >= 0.45
              ? 'mixed'
              : overallScore >= 0.25
                ? 'poor'
                : 'destructive',
      breakdown: {
        forecastQuality: buildSyntheticTradeQualityComponent(overallScore),
        calibrationQuality: buildSyntheticTradeQualityComponent(overallScore),
        executionQuality: buildSyntheticTradeQualityComponent(overallScore),
        timingQuality: buildSyntheticTradeQualityComponent(overallScore),
        policyCompliance: buildSyntheticTradeQualityComponent(0.8),
        realizedOutcomeQuality: {
          ...buildSyntheticTradeQualityComponent(overallScore),
          evidence: {
            expectedEv,
            realizedEv,
            realizedVsExpected:
              snapshot.realizedVsExpected ?? shadowEvidence.realizedVsExpected,
          },
        },
        overallScore,
        reasons: ['promotion_shadow_evidence_fallback'],
      },
    };
  });
}

function buildSyntheticTradeQualityComponent(
  score: number,
): TradeQualityScore['breakdown']['forecastQuality'] {
  return {
    score,
    label:
      score >= 0.8
        ? 'excellent'
        : score >= 0.65
          ? 'good'
          : score >= 0.45
            ? 'mixed'
            : score >= 0.25
              ? 'poor'
              : 'destructive',
    reasons: ['promotion_shadow_evidence_fallback'],
    evidence: {},
  };
}

function inferExecutionStyle(
  diagnostic: Record<string, unknown>,
  order: Record<string, unknown> | null,
): ExecutionStyle {
  const fillRate = readNumber(diagnostic.fillRate, null);
  const realizedSlippage = readNumber(diagnostic.realizedSlippage, null);
  const staleOrder = readBoolean(diagnostic.staleOrder) ?? false;

  if (staleOrder || (fillRate != null && fillRate < 0.8 && (realizedSlippage ?? 0) <= 0.003)) {
    return 'maker';
  }
  if ((realizedSlippage ?? 0) > 0.004 || readString(order?.status) === 'filled') {
    return 'taker';
  }
  if (fillRate != null || realizedSlippage != null) {
    return 'hybrid';
  }
  return 'unknown';
}

function inferExecutionRoute(
  diagnostic: Record<string, unknown>,
  order: Record<string, unknown> | null,
  submissionEvent: Record<string, unknown> | null,
): 'maker' | 'taker' {
  const metadata = readMetadata(submissionEvent);
  const route = readString(metadata.route);
  if (route === 'maker' || route === 'taker') {
    return route;
  }

  const executionStyle = readString(metadata.executionStyle);
  if (executionStyle === 'rest') {
    return 'maker';
  }
  if (executionStyle === 'cross') {
    return 'taker';
  }

  const inferredStyle = inferExecutionStyle(diagnostic, order);
  return inferredStyle === 'maker' ? 'maker' : 'taker';
}

function inferOrderFillRatio(order: Record<string, unknown> | null): number | null {
  if (!order) {
    return null;
  }

  const size = readNumber(order.size, null);
  const filledSize = readNumber(order.filledSize, null);
  if (size == null || filledSize == null || size <= 0) {
    return null;
  }

  return filledSize / size;
}

function inferFillDelayMs(
  order: Record<string, unknown> | null,
  fills: Array<Record<string, unknown>>,
  submissionEvent: Record<string, unknown> | null,
): number | null {
  const referenceAt =
    readDate(submissionEvent?.createdAt) ??
    readDate(order?.postedAt) ??
    readDate(order?.acknowledgedAt) ??
    readDate(order?.createdAt);
  if (!referenceAt) {
    return null;
  }

  const firstFillAt = fills
    .map((fill) => readDate(fill.filledAt))
    .filter((value): value is Date => value != null)
    .sort((left, right) => left.getTime() - right.getTime())[0];
  if (firstFillAt) {
    return Math.max(0, firstFillAt.getTime() - referenceAt.getTime());
  }

  const canceledAt = readDate(order?.canceledAt);
  if (canceledAt) {
    return Math.max(0, canceledAt.getTime() - referenceAt.getTime());
  }

  return null;
}

function extractTopDepth(
  orderbook: Record<string, unknown> | null,
  side: LearningTradeSide,
): number | null {
  if (!orderbook) {
    return null;
  }

  const field = side === 'sell' ? orderbook.bidLevels : orderbook.askLevels;
  if (!Array.isArray(field) || field.length === 0) {
    return null;
  }

  const top = field[0];
  if (!top || typeof top !== 'object') {
    return null;
  }

  const record = top as Record<string, unknown>;
  return readNumber(record.size, null);
}

function mapSide(value: string | null): LearningTradeSide {
  if (value === 'BUY') {
    return 'buy';
  }
  if (value === 'SELL') {
    return 'sell';
  }
  return 'unknown';
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readRetentionSizingEntries(
  raw: unknown,
  contextType: 'regime' | 'archetype',
): Array<{
  contextType: 'regime' | 'archetype';
  contextValue: string;
  sampleCount: number;
  retentionRatio: number | null;
  realizedVsExpectedGap: number | null;
  rankScore: number | null;
}> {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((entry): entry is Record<string, unknown> => entry != null && typeof entry === 'object')
    .map((entry) => ({
      contextType,
      contextValue: readString(entry.contextValue) ?? 'unknown',
      sampleCount: readNumber(entry.sampleCount, 0) ?? 0,
      retentionRatio: readNumber(entry.retentionRatio, null),
      realizedVsExpectedGap: readNumber(entry.realizedVsExpectedGap, null),
      rankScore: readNumber(entry.rankScore, null),
    }));
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || !('metadata' in value)) {
    return {};
  }

  const metadata = (value as { metadata?: unknown }).metadata;
  return metadata && typeof metadata === 'object'
    ? (metadata as Record<string, unknown>)
    : {};
}

function sanitizeReviewLabel(value: string): string {
  return value.replace(/[^a-zA-Z0-9_:-]+/g, '-');
}

function readOpportunityClass(value: unknown): string | null {
  const metadata = readMetadata(value);
  const strategyFamily =
    metadata.strategyFamily && typeof metadata.strategyFamily === 'object'
      ? (metadata.strategyFamily as Record<string, unknown>)
      : null;
  return readString(strategyFamily?.family);
}

function readNumber(value: unknown, fallback: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function readDateString(value: unknown): string | null {
  const parsed = readDate(value);
  return parsed ? parsed.toISOString() : null;
}

function inputToIsoString(value: Date): string {
  return value.toISOString();
}

function selectLatestDiagnosticsByOrder(
  diagnostics: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const latest = new Map<string, Record<string, unknown>>();
  for (const diagnostic of diagnostics) {
    const orderId = readString(diagnostic.orderId);
    if (!orderId) {
      continue;
    }

    const current = latest.get(orderId);
    const candidateAt = readDate(diagnostic.capturedAt)?.getTime() ?? 0;
    const currentAt = current ? readDate(current.capturedAt)?.getTime() ?? 0 : -1;
    if (!current || candidateAt >= currentAt) {
      latest.set(orderId, diagnostic);
    }
  }

  return [...latest.values()].sort((left, right) => {
    const leftAt = readDate(left.capturedAt)?.getTime() ?? 0;
    const rightAt = readDate(right.capturedAt)?.getTime() ?? 0;
    return leftAt - rightAt;
  });
}

function groupByKey(
  records: Array<Record<string, unknown>>,
  keyFor: (record: Record<string, unknown>) => string | null,
): Map<string, Array<Record<string, unknown>>> {
  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const record of records) {
    const key = keyFor(record);
    if (!key) {
      continue;
    }

    const list = grouped.get(key) ?? [];
    list.push(record);
    grouped.set(key, list);
  }
  return grouped;
}

function selectLatestByKey(
  records: Array<Record<string, unknown>>,
  keyFor: (record: Record<string, unknown>) => string | null,
  sortValueFor: (record: Record<string, unknown>) => number,
): Map<string, Record<string, unknown>> {
  const latest = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    const key = keyFor(record);
    if (!key) {
      continue;
    }

    const current = latest.get(key);
    if (!current || sortValueFor(record) >= sortValueFor(current)) {
      latest.set(key, record);
    }
  }
  return latest;
}

function clampRatio(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(1, value));
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
      path.join(os.tmpdir(), `venue-health-${Math.random().toString(16).slice(2)}`),
    );
  }

  return new VenueHealthLearningStore();
}
