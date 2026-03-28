import type {
  SentinelLearningUpdate,
  SentinelSimulatedTradeRecord,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { SentinelStateStore } from './sentinel-state-store';

export class SentinelLearningService {
  constructor(private readonly sentinelStateStore: SentinelStateStore = new SentinelStateStore()) {}

  async learnFromTrade(
    trade: SentinelSimulatedTradeRecord,
  ): Promise<SentinelLearningUpdate | null> {
    const existingUpdates = await this.sentinelStateStore.loadAllLearningUpdates();
    if (existingUpdates.some((update) => update.simulationTradeId === trade.simulationTradeId)) {
      return null;
    }

    const update: SentinelLearningUpdate = {
      learningUpdateId: `sentinel-learning:${trade.simulationTradeId}`,
      simulationTradeId: trade.simulationTradeId,
      learnedAt: new Date().toISOString(),
      parameterChanges: [
        {
          parameter: 'execution_expectation_summary.fill_probability',
          previousValue: trade.expectedFillProbability,
          nextValue: trade.realizedFillProbability,
          rationale: ['Persist sentinel fill-probability realism for backend readiness review.'],
          boundedBy: ['bounded_adaptation_only', 'execution_expectation_summaries'],
        },
        {
          parameter: 'execution_expectation_summary.slippage_bps',
          previousValue: trade.expectedSlippageBps,
          nextValue: trade.realizedSlippageBps,
          rationale: ['Track simulated slippage realism without changing live execution policy.'],
          boundedBy: ['bounded_adaptation_only', 'execution_expectation_summaries'],
        },
        {
          parameter: 'strategy_readiness_metric.realized_net_edge_after_costs_bps',
          previousValue: trade.expectedNetEdgeAfterCostsBps,
          nextValue: trade.realizedNetEdgeAfterCostsBps,
          rationale: ['Capture sentinel strategy-readiness evidence for advisory live recommendations.'],
          boundedBy: ['bounded_adaptation_only', 'strategy_confidence_readiness_metrics'],
        },
      ],
      evidenceRefs: [
        this.sentinelStateStore.getPaths().tradesPath,
        ...trade.evidenceRefs,
      ],
      reason: trade.fillQualityPassed
        ? 'sentinel_trade_learned_with_passing_fill_quality'
        : 'sentinel_trade_learned_with_fill_quality_warning',
      rollbackCriteria: [
        'revert advisory readiness if expected_vs_realized_edge_gap_bps exceeds 8',
        'revert advisory readiness if unresolved sentinel anomalies become non-zero',
      ],
    };

    await this.sentinelStateStore.appendLearningUpdate(update);
    return update;
  }
}
