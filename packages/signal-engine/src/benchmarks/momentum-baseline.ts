import {
  BenchmarkReplayCase,
  BenchmarkSummary,
  clamp,
  resolveSide,
  runBenchmarkEvaluation,
} from './btc-follow-baseline';

export class MomentumBaseline {
  evaluate(cases: BenchmarkReplayCase[]): BenchmarkSummary {
    return runBenchmarkEvaluation({
      benchmarkId: 'momentum_baseline',
      benchmarkName: 'Momentum Baseline',
      assumptions: [
        'Trades only when short and rolling returns align.',
        'Reduces conviction under high noise and elevated spread.',
      ],
      cases,
      evaluateCase: (input) => {
        const aligned =
          Math.sign(input.featureSnapshot.lastReturnPct) ===
          Math.sign(input.featureSnapshot.rollingReturnPct);
        const momentumScore = aligned
          ? input.featureSnapshot.lastReturnPct * 110 +
            input.featureSnapshot.rollingReturnPct * 90
          : input.featureSnapshot.lastReturnPct * 30;
        const noisePenalty =
          input.featureSnapshot.orderbookNoiseScore * 0.18 +
          input.featureSnapshot.spread * 2.8;
        const score = clamp(momentumScore - noisePenalty, -1, 1);
        return {
          side: resolveSide(score, 0.14),
          probabilityOffset: clamp(Math.abs(score) * 0.1, 0, 0.14),
        };
      },
    });
  }
}
