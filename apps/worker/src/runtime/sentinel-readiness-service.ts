import type {
  SentinelReadinessStatus,
  SentinelRecommendationState,
  TradingOperatingMode,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { SentinelStateStore } from './sentinel-state-store';

const TARGET_SIMULATED_TRADES = 20;
const TARGET_LEARNED_TRADES = 20;
const READINESS_THRESHOLD = 0.75;
const MAX_EDGE_GAP_BPS = 8;
const MIN_FILL_QUALITY_PASS_RATE = 0.8;
const MIN_NO_TRADE_DISCIPLINE_PASS_RATE = 0.8;

export class SentinelReadinessService {
  constructor(private readonly sentinelStateStore: SentinelStateStore = new SentinelStateStore()) {}

  async recompute(
    operatingMode: TradingOperatingMode = 'sentinel_simulation',
  ): Promise<SentinelReadinessStatus> {
    const baseline = await this.sentinelStateStore.ensureBaselineKnowledge(operatingMode);
    const [trades, updates, learnedTradeCount] = await Promise.all([
      this.sentinelStateStore.loadAllSimulatedTrades(),
      this.sentinelStateStore.loadAllLearningUpdates(),
      this.sentinelStateStore.countLearnedTrades(),
    ]);

    const simulatedTradesCompleted = trades.length;
    const simulatedTradesLearned = learnedTradeCount;
    const simulatedNetEdgeAfterCostsBps =
      average(trades.map((trade) => trade.realizedNetEdgeAfterCostsBps)) ?? 0;
    const expectedVsRealizedEdgeGapBps =
      average(trades.map((trade) => trade.expectedVsRealizedEdgeGapBps)) ?? 0;
    const fillQualityPassRate =
      ratio(
        trades.filter((trade) => trade.fillQualityPassed).length,
        simulatedTradesCompleted,
      ) ?? 0;
    const noTradeDisciplinePassRate =
      ratio(
        trades.filter((trade) => trade.noTradeDisciplinePassed).length,
        simulatedTradesCompleted,
      ) ?? 0;
    const learningCoverage =
      ratio(simulatedTradesLearned, simulatedTradesCompleted) ?? 0;
    const unresolvedAnomalyCount = trades.reduce(
      (sum, trade) => sum + Math.max(0, trade.unresolvedAnomalyCount),
      0,
    );
    const lastLearningAt =
      updates.length === 0
        ? null
        : updates
            .map((update) => update.learnedAt)
            .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] ?? null;

    const readinessScore = roundTo(
      [
        Math.min(simulatedTradesCompleted / TARGET_SIMULATED_TRADES, 1),
        Math.min(simulatedTradesLearned / TARGET_LEARNED_TRADES, 1),
        learningCoverage,
        simulatedNetEdgeAfterCostsBps > 0 ? 1 : 0,
        expectedVsRealizedEdgeGapBps <= MAX_EDGE_GAP_BPS
          ? 1
          : Math.max(0, 1 - (expectedVsRealizedEdgeGapBps - MAX_EDGE_GAP_BPS) / 16),
        fillQualityPassRate,
        noTradeDisciplinePassRate,
        unresolvedAnomalyCount === 0 ? 1 : 0,
      ].reduce((sum, value) => sum + value, 0) / 8,
      4,
    );

    const recommendationState: SentinelRecommendationState =
      simulatedTradesCompleted >= TARGET_SIMULATED_TRADES &&
      simulatedTradesLearned >= TARGET_LEARNED_TRADES &&
      readinessScore >= READINESS_THRESHOLD &&
      simulatedNetEdgeAfterCostsBps > 0 &&
      expectedVsRealizedEdgeGapBps <= MAX_EDGE_GAP_BPS &&
      fillQualityPassRate >= MIN_FILL_QUALITY_PASS_RATE &&
      noTradeDisciplinePassRate >= MIN_NO_TRADE_DISCIPLINE_PASS_RATE &&
      unresolvedAnomalyCount === 0 &&
      learningCoverage >= 0.95
        ? 'ready_to_consider_live'
        : 'not_ready';

    const status: SentinelReadinessStatus = {
      updatedAt: new Date().toISOString(),
      operatingMode,
      mode: operatingMode,
      recommendationState,
      recommendationMessage:
        recommendationState === 'ready_to_consider_live'
          ? `Sentinel thresholds are satisfied. Simulated trades: ${simulatedTradesCompleted}/20. Learned trades: ${simulatedTradesLearned}/20. Readiness score: ${formatScore(readinessScore)}/0.75. It is safe to consider enabling live trading.`
          : `Sentinel is still learning. Simulated trades: ${simulatedTradesCompleted}/20. Learned trades: ${simulatedTradesLearned}/20. Readiness score: ${formatScore(readinessScore)}/0.75. Do not enable live trading yet.`,
      simulatedTradesCompleted,
      simulatedTradesLearned,
      targetSimulatedTrades: TARGET_SIMULATED_TRADES,
      targetLearnedTrades: TARGET_LEARNED_TRADES,
      readinessScore,
      readinessThreshold: READINESS_THRESHOLD,
      simulatedNetEdgeAfterCostsBps: roundTo(simulatedNetEdgeAfterCostsBps, 4),
      netEdgeAfterCostsBps: roundTo(simulatedNetEdgeAfterCostsBps, 4),
      expectedVsRealizedEdgeGapBps: roundTo(expectedVsRealizedEdgeGapBps, 4),
      fillQualityPassRate: roundTo(fillQualityPassRate, 4),
      noTradeDisciplinePassRate: roundTo(noTradeDisciplinePassRate, 4),
      learningCoverage: roundTo(learningCoverage, 4),
      unresolvedAnomalyCount,
      recommendedLiveEnable: recommendationState === 'ready_to_consider_live',
      lastLearningAt,
      baselineKnowledgeVersion: baseline.baselineId,
    };

    await this.sentinelStateStore.writeReadiness(status);
    return status;
  }
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) {
    return null;
  }

  return numerator / denominator;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function formatScore(value: number): string {
  return value.toFixed(2);
}
