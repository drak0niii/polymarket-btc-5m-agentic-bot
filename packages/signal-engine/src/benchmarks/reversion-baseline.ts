import {
  BenchmarkReplayCase,
  BenchmarkSummary,
  clamp,
  resolveSide,
  runBenchmarkEvaluation,
} from './btc-follow-baseline';

export class ReversionBaseline {
  evaluate(cases: BenchmarkReplayCase[]): BenchmarkSummary {
    return runBenchmarkEvaluation({
      benchmarkId: 'reversion_baseline',
      benchmarkName: 'Reversion Baseline',
      assumptions: [
        'Trades against stretched short-term moves when noise and volatility stay bounded.',
        'Avoids acting when return extension is too small to justify contrarian entry.',
      ],
      cases,
      evaluateCase: (input) => {
        const extension =
          input.featureSnapshot.lastReturnPct * 120 -
          input.featureSnapshot.rollingReturnPct * 40;
        const reversionScore =
          -extension -
          input.featureSnapshot.realizedVolatility * 8 -
          input.featureSnapshot.orderbookNoiseScore * 0.08;
        const score = clamp(reversionScore, -1, 1);
        return {
          side: resolveSide(score, 0.16),
          probabilityOffset: clamp(Math.abs(score) * 0.085, 0, 0.12),
        };
      },
    });
  }
}
