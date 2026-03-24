import type { StrategyCorrelationSignal } from '@polymarket-btc-5m-agentic-bot/domain';
import type { PortfolioLearningObservation } from './portfolio-learning-state';

export interface StrategyCorrelationMonitorResult {
  signals: Record<string, StrategyCorrelationSignal>;
  penaltyMultiplierByVariant: Record<string, number>;
}

export class StrategyCorrelationMonitor {
  evaluate(input: {
    observations: PortfolioLearningObservation[];
    now?: Date;
  }): StrategyCorrelationMonitorResult {
    const now = input.now ?? new Date();
    const grouped = new Map<
      string,
      {
        totalCount: number;
        realizedPositiveCount: number;
        regimes: Map<string, number>;
        opportunityClasses: Map<string, number>;
      }
    >();

    for (const observation of input.observations) {
      const current = grouped.get(observation.strategyVariantId) ?? {
        totalCount: 0,
        realizedPositiveCount: 0,
        regimes: new Map<string, number>(),
        opportunityClasses: new Map<string, number>(),
      };
      current.totalCount += 1;
      if (observation.realizedEv >= 0) {
        current.realizedPositiveCount += 1;
      }
      increment(current.regimes, observation.regime ?? 'unknown_regime');
      increment(
        current.opportunityClasses,
        observation.opportunityClass ?? 'unknown_opportunity_class',
      );
      grouped.set(observation.strategyVariantId, current);
    }

    const variants = [...grouped.keys()].sort();
    const signals: Record<string, StrategyCorrelationSignal> = {};
    const penaltyMultiplierByVariant: Record<string, number> = {};

    for (let index = 0; index < variants.length; index += 1) {
      for (let nextIndex = index + 1; nextIndex < variants.length; nextIndex += 1) {
        const leftVariantId = variants[index]!;
        const rightVariantId = variants[nextIndex]!;
        const left = grouped.get(leftVariantId)!;
        const right = grouped.get(rightVariantId)!;
        const regimeOverlap = overlapScore(left.regimes, right.regimes);
        const opportunityOverlap = overlapScore(
          left.opportunityClasses,
          right.opportunityClasses,
        );
        const overlap = regimeOverlap * 0.5 + opportunityOverlap * 0.5;
        const realizedAlignment =
          left.totalCount > 0 && right.totalCount > 0
            ? 1 -
              Math.abs(
                left.realizedPositiveCount / left.totalCount -
                  right.realizedPositiveCount / right.totalCount,
              )
            : 0;
        const sharedSampleCount = estimateSharedSamples(left, right);
        const hiddenOverlap =
          sharedSampleCount >= 3 && overlap >= 0.5 && realizedAlignment >= 0.5;
        const penaltyMultiplier = hiddenOverlap
          ? overlap >= 0.75
            ? 0.7
            : 0.85
          : 1;
        const signalKey = `correlation:${leftVariantId}:${rightVariantId}`;
        signals[signalKey] = {
          signalKey,
          leftVariantId,
          rightVariantId,
          sharedSampleCount,
          overlapScore: overlap,
          realizedAlignment,
          penaltyMultiplier,
          hiddenOverlap,
          reasons: hiddenOverlap
            ? ['hidden_overlap_detected_across_sleeves']
            : ['diversification_overlap_within_limits'],
          lastUpdatedAt: now.toISOString(),
        };
        penaltyMultiplierByVariant[leftVariantId] = Math.min(
          penaltyMultiplierByVariant[leftVariantId] ?? 1,
          penaltyMultiplier,
        );
        penaltyMultiplierByVariant[rightVariantId] = Math.min(
          penaltyMultiplierByVariant[rightVariantId] ?? 1,
          penaltyMultiplier,
        );
      }
    }

    return {
      signals,
      penaltyMultiplierByVariant,
    };
  }
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function overlapScore(left: Map<string, number>, right: Map<string, number>): number {
  const keys = new Set([...left.keys(), ...right.keys()]);
  if (keys.size === 0) {
    return 0;
  }

  let numerator = 0;
  let denominator = 0;
  for (const key of keys) {
    const leftCount = left.get(key) ?? 0;
    const rightCount = right.get(key) ?? 0;
    numerator += Math.min(leftCount, rightCount);
    denominator += Math.max(leftCount, rightCount);
  }
  return denominator > 0 ? numerator / denominator : 0;
}

function estimateSharedSamples(
  left: {
    regimes: Map<string, number>;
    opportunityClasses: Map<string, number>;
  },
  right: {
    regimes: Map<string, number>;
    opportunityClasses: Map<string, number>;
  },
): number {
  const sharedRegimes = [...left.regimes.entries()].reduce(
    (sum, [key, count]) => sum + Math.min(count, right.regimes.get(key) ?? 0),
    0,
  );
  const sharedOpportunityClasses = [...left.opportunityClasses.entries()].reduce(
    (sum, [key, count]) => sum + Math.min(count, right.opportunityClasses.get(key) ?? 0),
    0,
  );
  return Math.max(sharedRegimes, sharedOpportunityClasses);
}
