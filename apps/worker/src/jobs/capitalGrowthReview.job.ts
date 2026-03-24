import fs from 'fs/promises';
import path from 'path';
import type { PrismaClient } from '@prisma/client';
import { AppLogger } from '@worker/common/logger';
import { DecisionLogService } from '@worker/runtime/decision-log.service';
import { LearningStateStore } from '@worker/runtime/learning-state-store';
import type { LearningState, TradeQualityScore } from '@polymarket-btc-5m-agentic-bot/domain';
import {
  CapitalGrowthMetricsCalculator,
  type CapitalGrowthMetricsResult,
  RegimeProfitabilityRanker,
  TradeQualityHistoryStore,
  type CapitalLeakReport,
} from '@polymarket-btc-5m-agentic-bot/risk-engine';
import {
  CapitalGrowthPromotionGate,
  PromotionStabilityCheck,
  type PromotionStabilityContextShare,
} from '@polymarket-btc-5m-agentic-bot/signal-engine';
import {
  createDefaultTradeQualityHistoryStore,
  readLatestCapitalLeakReport,
} from './capitalLeakReview.job';

export interface CapitalGrowthVariantReview {
  strategyVariantId: string;
  metrics: CapitalGrowthMetricsResult;
  promotionGate: ReturnType<CapitalGrowthPromotionGate['evaluate']>;
  stabilityCheck: ReturnType<PromotionStabilityCheck['evaluate']>;
  recommendation: 'scale' | 'hold' | 'reduce';
  profitableButUnstable: boolean;
  reasons: string[];
}

export interface CapitalGrowthReviewReport {
  generatedAt: string;
  window: {
    from: string;
    to: string;
  };
  variants: CapitalGrowthVariantReview[];
  compoundingEfficient: string[];
  profitableButUnstable: string[];
  shouldScale: string[];
  shouldReduce: string[];
}

export interface CapitalGrowthReviewResult {
  report: CapitalGrowthReviewReport;
  warnings: string[];
  reportPath: string;
}

export class CapitalGrowthReviewJob {
  private readonly logger = new AppLogger('CapitalGrowthReviewJob');
  private readonly decisionLogService: DecisionLogService;
  private readonly learningStateStore: LearningStateStore;
  private readonly tradeQualityHistoryStore: TradeQualityHistoryStore;
  private readonly regimeProfitabilityRanker = new RegimeProfitabilityRanker();
  private readonly capitalGrowthMetricsCalculator = new CapitalGrowthMetricsCalculator();
  private readonly capitalGrowthPromotionGate = new CapitalGrowthPromotionGate();
  private readonly promotionStabilityCheck = new PromotionStabilityCheck();
  private readonly rootDir: string;
  private readonly reportDir: string;
  private readonly latestReportPath: string;

  constructor(
    private readonly prisma: PrismaClient,
    learningStateStore?: LearningStateStore,
    tradeQualityHistoryStore?: TradeQualityHistoryStore,
    rootDir?: string,
  ) {
    this.learningStateStore = learningStateStore ?? new LearningStateStore();
    this.tradeQualityHistoryStore =
      tradeQualityHistoryStore ??
      createDefaultTradeQualityHistoryStore(this.learningStateStore);
    this.rootDir =
      rootDir ??
      path.join(this.learningStateStore.getPaths().rootDir, 'capital-growth');
    this.reportDir = path.join(this.rootDir, 'reports');
    this.latestReportPath = path.join(this.rootDir, 'latest-report.json');
    this.decisionLogService = new DecisionLogService(prisma);
  }

  async run(input: {
    from: Date;
    to: Date;
    now?: Date;
    learningState?: LearningState;
    capitalLeakReport?: CapitalLeakReport | null;
  }): Promise<CapitalGrowthReviewResult> {
    const now = input.now ?? new Date();
    const learningState = input.learningState ?? (await this.learningStateStore.load());
    const tradeQualityScores = await this.tradeQualityHistoryStore.readWindow(
      input.from,
      input.to,
    );
    const capitalLeakReport =
      input.capitalLeakReport ??
      (await readLatestCapitalLeakReport(
        path.join(this.learningStateStore.getPaths().rootDir, 'capital-leak'),
      ));
    const variants = Object.keys(learningState.strategyVariants)
      .sort()
      .map((strategyVariantId) =>
        this.evaluateVariant({
          strategyVariantId,
          learningState,
          tradeQualityScores,
          capitalLeakReport,
        }),
      );

    const report: CapitalGrowthReviewReport = {
      generatedAt: now.toISOString(),
      window: {
        from: input.from.toISOString(),
        to: input.to.toISOString(),
      },
      variants,
      compoundingEfficient: variants
        .filter((variant) => variant.metrics.compoundingEfficiency.label === 'efficient')
        .map((variant) => variant.strategyVariantId),
      profitableButUnstable: variants
        .filter((variant) => variant.profitableButUnstable)
        .map((variant) => variant.strategyVariantId),
      shouldScale: variants
        .filter((variant) => variant.recommendation === 'scale')
        .map((variant) => variant.strategyVariantId),
      shouldReduce: variants
        .filter((variant) => variant.recommendation === 'reduce')
        .map((variant) => variant.strategyVariantId),
    };
    const warnings = [
      ...report.profitableButUnstable.map((variantId) => `profitable_but_unstable:${variantId}`),
      ...report.shouldReduce.map((variantId) => `reduce_capital:${variantId}`),
    ];

    await this.persistReport(report);
    await this.decisionLogService.record({
      category: 'promotion',
      eventType: 'capital.growth_review',
      summary: `Capital growth review computed for ${report.window.from} to ${report.window.to}.`,
      payload: {
        report,
        warnings,
      },
      createdAt: now.toISOString(),
    });

    if (warnings.length > 0) {
      this.logger.warn('Capital growth review found unstable or reducible variants.', {
        warnings,
      });
    }

    return {
      report,
      warnings,
      reportPath: this.latestReportPath,
    };
  }

  private evaluateVariant(input: {
    strategyVariantId: string;
    learningState: LearningState;
    tradeQualityScores: TradeQualityScore[];
    capitalLeakReport: CapitalLeakReport | null;
  }): CapitalGrowthVariantReview {
    const variant = input.learningState.strategyVariants[input.strategyVariantId];
    const variantTradeQuality = input.tradeQualityScores.filter(
      (score) => score.strategyVariantId === input.strategyVariantId,
    );
    const calibrationHealth = worstHealth(
      Object.values(input.learningState.calibration)
        .filter((calibration) => calibration.strategyVariantId === input.strategyVariantId)
        .map((calibration) => calibration.health),
    );
    const executionHealth = worstHealth(
      Object.values(variant.executionLearning.contexts).map((context) => context.health),
    );
    const regimeAssessments = Object.values(variant.regimeSnapshots).map((snapshot) =>
      this.regimeProfitabilityRanker.rank({
        strategyVariantId: input.strategyVariantId,
        regime: snapshot.regime,
        regimeSnapshot: snapshot,
        calibrationHealth,
        executionContext:
          Object.values(variant.executionLearning.contexts).find(
            (context) => context.regime === snapshot.regime,
          ) ?? null,
        recentTradeQualityScores: variantTradeQuality.filter(
          (score) => score.regime === snapshot.regime,
        ),
        currentDrawdownPct: findVariantDrawdown(input.learningState, input.strategyVariantId)?.currentDrawdown ?? null,
        maxDrawdownPct: findVariantDrawdown(input.learningState, input.strategyVariantId)?.maxDrawdown ?? null,
        recentLeakShare:
          input.capitalLeakReport?.byRegime.find((group) => group.groupKey === snapshot.regime)
            ?.dominantShare ?? null,
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
      currentDrawdownPct:
        findVariantDrawdown(input.learningState, input.strategyVariantId)?.currentDrawdown ?? null,
      maxDrawdownPct:
        findVariantDrawdown(input.learningState, input.strategyVariantId)?.maxDrawdown ?? null,
    });
    const promotionGate = this.capitalGrowthPromotionGate.evaluate({
      sampleCount: Math.max(
        metrics.tradeCount,
        regimeAssessments.reduce((sum, assessment) => sum + assessment.metrics.sampleCount, 0),
      ),
      calibrationHealth,
      executionHealth,
      netEdgeQuality: metrics.netEdgeQuality,
      maxDrawdownPct: metrics.maxDrawdownPct,
      capitalLeakageRatio: metrics.costLeakageRatio,
      executionEvRetention: metrics.executionEvRetention,
      regimeStabilityScore: metrics.regimeStabilityScore,
      stabilityAdjustedCapitalGrowthScore: metrics.stabilityAdjustedCapitalGrowthScore,
    });
    const stabilityCheck = this.promotionStabilityCheck.evaluate({
      sampleCount: Math.max(
        metrics.tradeCount,
        regimeAssessments.reduce((sum, assessment) => sum + assessment.metrics.sampleCount, 0),
      ),
      realizedVsExpected: metrics.evRetention,
      stabilityAdjustedCapitalGrowthScore: metrics.stabilityAdjustedCapitalGrowthScore,
      contextShares: buildContextShares(variant),
      realizedReturns: variantTradeQuality
        .map((score) => {
          const value = score.breakdown.realizedOutcomeQuality.evidence.realizedEv;
          return typeof value === 'number' && Number.isFinite(value) ? value : null;
        })
        .filter((value): value is number => value != null),
    });
    const profitableButUnstable = metrics.netReturn > 0 && !stabilityCheck.stable;
    const recommendation: CapitalGrowthVariantReview['recommendation'] =
      promotionGate.passed &&
      stabilityCheck.stable &&
      metrics.compoundingEfficiency.score >= 0.78
        ? 'scale'
        : profitableButUnstable ||
            metrics.netReturn <= 0 ||
            (metrics.costLeakageRatio ?? 0) > 0.35
          ? 'reduce'
          : 'hold';

    return {
      strategyVariantId: input.strategyVariantId,
      metrics,
      promotionGate,
      stabilityCheck,
      recommendation,
      profitableButUnstable,
      reasons: [
        ...metrics.reasons,
        ...promotionGate.reasons,
        ...stabilityCheck.reasons,
        `recommendation_${recommendation}`,
      ],
    };
  }

  private async persistReport(report: CapitalGrowthReviewReport): Promise<void> {
    await fs.mkdir(this.reportDir, { recursive: true });
    const reportPath = path.join(
      this.reportDir,
      `${report.generatedAt.replace(/[:.]/g, '-')}.json`,
    );
    await Promise.all([
      fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
      fs.writeFile(this.latestReportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
    ]);
  }
}

export async function readLatestCapitalGrowthReport(
  rootDir?: string,
): Promise<CapitalGrowthReviewReport | null> {
  const learningStateStore = new LearningStateStore();
  const resolvedRoot =
    rootDir ??
    path.join(learningStateStore.getPaths().rootDir, 'capital-growth');
  const latestReportPath = path.join(resolvedRoot, 'latest-report.json');
  try {
    const content = await fs.readFile(latestReportPath, 'utf8');
    return JSON.parse(content) as CapitalGrowthReviewReport;
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

function buildContextShares(variant: LearningState['strategyVariants'][string]): PromotionStabilityContextShare[] {
  return Object.entries(variant.regimeSnapshots).map(([contextKey, snapshot]) => ({
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

function worstHealth(values: Array<'healthy' | 'watch' | 'degraded' | 'quarantine_candidate'>) {
  const priority = {
    healthy: 0,
    watch: 1,
    degraded: 2,
    quarantine_candidate: 3,
  };
  return values.sort((left, right) => priority[right] - priority[left])[0] ?? 'healthy';
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT',
  );
}
