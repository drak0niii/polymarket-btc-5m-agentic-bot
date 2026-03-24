import type { CapitalLeakCategory } from './capital-leak-attribution';
import type { TradeQualityScore } from '@polymarket-btc-5m-agentic-bot/domain';
import type { RegimeProfitabilityAssessment } from './regime-profitability-ranker';

export type RegimeDisableStatus = 'none' | 'restrict' | 'disabled';

export interface RegimeDisableDecision {
  status: RegimeDisableStatus;
  blockNewTrades: boolean;
  sizeMultiplier: number;
  reasons: string[];
  evidence: Record<string, unknown>;
}

export class RegimeDisablePolicy {
  evaluate(input: {
    assessment: RegimeProfitabilityAssessment;
    recentTradeQualityScores: TradeQualityScore[];
    recentLeakShare: number | null;
    recentLeakDominantCategory: CapitalLeakCategory | null;
  }): RegimeDisableDecision {
    const averageQuality = average(
      input.recentTradeQualityScores.map((score) => score.breakdown.overallScore),
    );
    const destructiveShare = average(
      input.recentTradeQualityScores.map((score) => (score.label === 'destructive' ? 1 : 0)),
    );
    const persistentlyDestructive =
      input.assessment.metrics.sampleCount >= 6 &&
      input.assessment.rank === 'avoid_regime' &&
      ((input.assessment.metrics.realizedEvRetention ?? 0) < 0.65 ||
        input.assessment.metrics.netEv <= 0) &&
      ((averageQuality ?? 1) < 0.45 ||
        (destructiveShare ?? 0) >= 0.35 ||
        (input.recentLeakShare ?? 0) >= 0.4);

    if (persistentlyDestructive) {
      return {
        status: 'disabled',
        blockNewTrades: true,
        sizeMultiplier: 0,
        reasons: [
          'regime_persistently_destructive',
          `dominant_leak_${input.recentLeakDominantCategory ?? 'unknown'}`,
        ],
        evidence: {
          assessment: input.assessment,
          averageQuality,
          destructiveShare,
          recentLeakShare: input.recentLeakShare,
          recentLeakDominantCategory: input.recentLeakDominantCategory,
        },
      };
    }

    const restrictive =
      input.assessment.rank === 'marginal_regime' &&
      ((averageQuality ?? 1) < 0.55 ||
        (input.recentLeakShare ?? 0) >= 0.3 ||
        (destructiveShare ?? 0) >= 0.25);
    if (restrictive) {
      return {
        status: 'restrict',
        blockNewTrades: false,
        sizeMultiplier: 0.35,
        reasons: ['regime_requires_heavy_restriction'],
        evidence: {
          assessment: input.assessment,
          averageQuality,
          destructiveShare,
          recentLeakShare: input.recentLeakShare,
          recentLeakDominantCategory: input.recentLeakDominantCategory,
        },
      };
    }

    return {
      status: 'none',
      blockNewTrades: false,
      sizeMultiplier: 1,
      reasons: ['regime_disable_not_triggered'],
      evidence: {
        assessment: input.assessment,
        averageQuality,
        destructiveShare,
        recentLeakShare: input.recentLeakShare,
        recentLeakDominantCategory: input.recentLeakDominantCategory,
      },
    };
  }
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
