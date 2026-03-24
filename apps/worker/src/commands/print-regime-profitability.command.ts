import type { LearningState, TradeQualityScore } from '@polymarket-btc-5m-agentic-bot/domain';
import {
  RegimeProfitabilityRanker,
  TradeQualityHistoryStore,
  type CapitalLeakReport,
} from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { readLatestCapitalLeakReport } from '@worker/jobs/capitalLeakReview.job';
import { LearningStateStore } from '@worker/runtime/learning-state-store';

async function main(): Promise<void> {
  const variantId = process.argv[2] ?? null;
  const learningStateStore = new LearningStateStore();
  const tradeQualityHistoryStore = new TradeQualityHistoryStore(
    `${learningStateStore.getPaths().rootDir}/trade-quality`,
  );
  const regimeProfitabilityRanker = new RegimeProfitabilityRanker();

  const [learningState, tradeQualityScores, capitalLeakReport] = await Promise.all([
    learningStateStore.load(),
    tradeQualityHistoryStore.readLatest(5_000),
    readLatestCapitalLeakReport(),
  ]);

  const variantIds = Object.keys(learningState.strategyVariants)
    .filter((candidate) => (variantId ? candidate === variantId : true))
    .sort();
  const profitability = variantIds.map((strategyVariantId) => {
    const variant = learningState.strategyVariants[strategyVariantId]!;
    const calibrationHealth = worstHealth(
      Object.values(learningState.calibration)
        .filter((calibration) => calibration.strategyVariantId === strategyVariantId)
        .map((calibration) => calibration.health),
    );
    const drawdown = findVariantDrawdown(learningState, strategyVariantId);
    return {
      strategyVariantId,
      regimes: Object.values(variant.regimeSnapshots).map((snapshot) =>
        regimeProfitabilityRanker.rank({
          strategyVariantId,
          regime: snapshot.regime,
          regimeSnapshot: snapshot,
          calibrationHealth,
          executionContext:
            Object.values(variant.executionLearning.contexts).find(
              (context) => context.regime === snapshot.regime,
            ) ?? null,
          recentTradeQualityScores: tradeQualityScores.filter(
            (score) =>
              score.strategyVariantId === strategyVariantId &&
              score.regime === snapshot.regime,
          ),
          currentDrawdownPct: drawdown?.currentDrawdown ?? null,
          maxDrawdownPct: drawdown?.maxDrawdown ?? null,
          recentLeakShare:
            capitalLeakReport?.byRegime.find((group) => group.groupKey === snapshot.regime)
              ?.dominantShare ?? null,
        }),
      ),
    };
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        capitalLeakReportWindow: capitalLeakReport?.window ?? null,
        profitability,
      },
      null,
      2,
    )}\n`,
  );
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

void main();
