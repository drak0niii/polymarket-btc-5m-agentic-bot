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
        'Uses a simple return-and-liquidity heuristic without regime awareness.',
        'Acts as the naive directional benchmark the full model should beat.',
      ],
      cases,
      evaluateCase: (input) => {
        const simpleScore =
          input.featureSnapshot.rollingReturnPct * 70 +
          input.featureSnapshot.lastReturnPct * 40 -
          input.featureSnapshot.spread * 2 -
          (input.featureSnapshot.topLevelDepth < 15 ? 0.1 : 0);
        const score = clamp(simpleScore, -1, 1);
        return {
          side: resolveSide(score, 0.1),
          probabilityOffset: clamp(Math.abs(score) * 0.07, 0, 0.1),
        };
      },
    });
  }
}
