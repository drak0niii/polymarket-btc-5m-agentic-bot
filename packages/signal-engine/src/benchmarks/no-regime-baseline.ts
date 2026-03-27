import {
  BenchmarkReplayCase,
  BenchmarkSummary,
  clamp,
  resolveSide,
  runBenchmarkEvaluation,
} from './btc-follow-baseline';

export class NoRegimeBaseline {
  evaluate(cases: BenchmarkReplayCase[]): BenchmarkSummary {
    return runBenchmarkEvaluation({
      benchmarkId: 'no_regime_baseline',
      benchmarkName: 'No-Regime Baseline',
      assumptions: [
        'Uses a simple return-and-liquidity heuristic without regime awareness or no-trade discipline.',
        'Continues to trade through unstable and marginal conditions that a regime-first policy should reject.',
        'Acts as the naive directional benchmark the full model should beat.',
      ],
      cases,
      evaluateCase: (input) => {
        const simpleScore =
          input.featureSnapshot.rollingReturnPct * 70 +
          input.featureSnapshot.lastReturnPct * 40 -
          input.featureSnapshot.spread * 1.2 -
          (input.featureSnapshot.topLevelDepth < 15 ? 0.04 : 0);
        const score = clamp(simpleScore, -1, 1);
        return {
          side: resolveSide(score, 0.07),
          probabilityOffset: clamp(Math.abs(score) * 0.075, 0, 0.11),
        };
      },
    });
  }
}
