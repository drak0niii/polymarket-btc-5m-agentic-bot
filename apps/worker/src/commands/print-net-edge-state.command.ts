import { RealizedVsExpectedEdgeStore } from '@polymarket-btc-5m-agentic-bot/execution-engine';
import {
  VenueHealthLearningStore,
  VenueModePolicy,
  VenueUncertaintyDetector,
} from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';
import { LearningStateStore } from '@worker/runtime/learning-state-store';
import { ResolvedTradeLedger } from '@worker/runtime/resolved-trade-ledger';
import { VersionLineageRegistry } from '@worker/runtime/version-lineage-registry';

async function main(): Promise<void> {
  const learningStateStore = new LearningStateStore();
  const versionLineageRegistry = new VersionLineageRegistry();
  const venueHealthLearningStore = new VenueHealthLearningStore();
  const venueUncertaintyDetector = new VenueUncertaintyDetector();
  const venueModePolicy = new VenueModePolicy();
  const resolvedTradeLedger = new ResolvedTradeLedger();
  const realizedVsExpectedEdgeStore = new RealizedVsExpectedEdgeStore(resolvedTradeLedger);

  const [learningState, venueHealth, recentLineage, recentResolvedEdgeComparisons] =
    await Promise.all([
    learningStateStore.load(),
    venueHealthLearningStore.getCurrentMetrics(),
    versionLineageRegistry.getLatestDecisions(200),
    realizedVsExpectedEdgeStore.loadRecent(20),
  ]);
  const venueAssessment = venueUncertaintyDetector.evaluate(venueHealth);
  const venueMode = venueModePolicy.decide(venueAssessment);
  const recentNetEdgeDecisions = recentLineage
    .filter((decision) => decision.decisionType === 'signal_execution')
    .map((decision) => {
      const bundle =
        decision.replay.activeParameterBundle &&
        typeof decision.replay.activeParameterBundle === 'object'
          ? decision.replay.activeParameterBundle
          : {};

      return {
        decisionId: decision.decisionId,
        recordedAt: decision.recordedAt,
        signalId: decision.signalId,
        marketId: decision.marketId,
        strategyVariantId: decision.strategyVariantId,
        tags: decision.tags,
        venueMode: decision.replay.venueMode,
        venueUncertainty: decision.replay.venueUncertainty,
        feeModeling: bundle['feeModeling'] ?? null,
        netRealismContext: bundle['netRealismContext'] ?? null,
        netEdgeDecision: bundle['netEdgeDecision'] ?? null,
        netEdgeBreakdown:
          bundle['netEdgeDecision'] &&
          typeof bundle['netEdgeDecision'] === 'object' &&
          bundle['netEdgeDecision'] !== null &&
          'breakdown' in (bundle['netEdgeDecision'] as Record<string, unknown>)
            ? (bundle['netEdgeDecision'] as Record<string, unknown>)['breakdown']
            : null,
        netEdgeThreshold: bundle['netEdgeThreshold'] ?? null,
        executionCostCalibration: bundle['executionCostCalibration'] ?? null,
        executionCostAssessment: bundle['executionCostAssessment'] ?? null,
        noTradeZone: bundle['noTradeZone'] ?? null,
        uncertaintySizing: bundle['uncertaintySizing'] ?? null,
        sizePenalty: bundle['sizePenalty'] ?? null,
        liquidityDecision: bundle['liquidityDecision'] ?? null,
      };
    })
    .slice(0, 20);

  process.stdout.write(
    `${JSON.stringify(
      {
        lastCycleSummary: learningState.lastCycleSummary,
        venueHealth,
        venueAssessment,
        venueMode,
        recentNetEdgeDecisions,
        recentResolvedEdgeComparisons,
      },
      null,
      2,
    )}\n`,
  );
}

void main();
