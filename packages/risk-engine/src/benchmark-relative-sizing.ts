export interface BenchmarkRelativeSizingContextEntry {
  regime: string;
  sampleCount: number;
  tradeCount: number;
  expectedEv: number;
  realizedEv: number;
  realizedVsExpected: number | null;
}

export interface BenchmarkRelativeSizingBenchmark {
  benchmarkId: string;
  benchmarkName: string;
  regimeBreakdown: BenchmarkRelativeSizingContextEntry[];
}

export type BenchmarkComparisonState =
  | 'outperforming'
  | 'neutral'
  | 'underperforming'
  | 'context_missing';

export type RegimeBenchmarkGateState =
  | 'passed'
  | 'blocked'
  | 'insufficient_evidence';

export interface BenchmarkRelativeSizingInput {
  regime: string | null;
  overallUnderperformedBenchmarkIds: string[];
  overallOutperformedBenchmarkIds: string[];
  strategyRegimeBreakdown: BenchmarkRelativeSizingContextEntry[];
  benchmarks: BenchmarkRelativeSizingBenchmark[];
}

export interface BenchmarkRelativeSizingDecision {
  baselinePenaltyMultiplier: number;
  benchmarkComparisonState: BenchmarkComparisonState;
  regimeBenchmarkGateState: RegimeBenchmarkGateState;
  promotionBlockedByBenchmark: boolean;
  regimeBenchmarkReasonCodes: string[];
  benchmarkPenaltyReasonCodes: string[];
  evidence: Record<string, unknown>;
  capturedAt: string;
}

export class BenchmarkRelativeSizing {
  evaluate(input: BenchmarkRelativeSizingInput): BenchmarkRelativeSizingDecision {
    const reasonCodes: string[] = [];
    const gateReasonCodes: string[] = [];
    const regime = input.regime ?? 'unknown';
    const strategyContext =
      input.strategyRegimeBreakdown.find((entry) => entry.regime === regime) ?? null;
    const benchmarkContexts = input.benchmarks
      .map((benchmark) => ({
        benchmarkId: benchmark.benchmarkId,
        benchmarkName: benchmark.benchmarkName,
        context:
          benchmark.regimeBreakdown.find((entry) => entry.regime === regime) ?? null,
      }))
      .filter((entry) => entry.context != null);

    let benchmarkComparisonState: BenchmarkComparisonState = 'neutral';
    let baselinePenaltyMultiplier = 1;
    let regimeBenchmarkGateState: RegimeBenchmarkGateState = 'blocked';
    let promotionBlockedByBenchmark = true;

    if (!strategyContext || benchmarkContexts.length === 0) {
      benchmarkComparisonState = 'context_missing';
      reasonCodes.push('benchmark_context_missing');
      gateReasonCodes.push('benchmark_gate_context_missing');
      if (
        input.overallUnderperformedBenchmarkIds.length >
        input.overallOutperformedBenchmarkIds.length
      ) {
        benchmarkComparisonState = 'underperforming';
        baselinePenaltyMultiplier = 0.92;
        reasonCodes.push('benchmark_overall_underperformance_fallback');
      }
    } else if (
      strategyContext.sampleCount < 8 ||
      strategyContext.tradeCount < 4 ||
      benchmarkContexts.length < 2
    ) {
      benchmarkComparisonState = 'context_missing';
      reasonCodes.push('benchmark_context_insufficient_sample');
      gateReasonCodes.push('benchmark_gate_insufficient_sample');
    } else {
      let underperformingBenchmarks = 0;
      let outperformingBenchmarks = 0;

      for (const benchmark of benchmarkContexts) {
        const realizedGap = strategyContext.realizedEv - benchmark.context!.realizedEv;
        const expectedGap = strategyContext.expectedEv - benchmark.context!.expectedEv;
        const retentionGap =
          strategyContext.realizedVsExpected != null &&
          benchmark.context!.realizedVsExpected != null
            ? strategyContext.realizedVsExpected - benchmark.context!.realizedVsExpected
            : null;

        if (realizedGap < 0) {
          reasonCodes.push(`benchmark_realized_gap_negative:${benchmark.benchmarkId}`);
        }
        if (expectedGap < 0) {
          reasonCodes.push(`benchmark_expected_gap_negative:${benchmark.benchmarkId}`);
        }
        if (retentionGap != null && retentionGap < 0) {
          reasonCodes.push(`benchmark_retention_gap_negative:${benchmark.benchmarkId}`);
        }

        const materiallyUnderperforming =
          realizedGap < -0.0015 ||
          expectedGap < -0.0005 ||
          (retentionGap != null && retentionGap < -0.05);
        const clearlyOutperforming =
          realizedGap > 0.0015 &&
          expectedGap >= 0 &&
          (retentionGap == null || retentionGap >= -0.02);

        if (materiallyUnderperforming) {
          underperformingBenchmarks += 1;
        } else if (clearlyOutperforming) {
          outperformingBenchmarks += 1;
        }
      }

      if (underperformingBenchmarks >= Math.max(2, benchmarkContexts.length - 1)) {
        benchmarkComparisonState = 'underperforming';
        baselinePenaltyMultiplier =
          strategyContext.realizedEv < 0 || strategyContext.realizedVsExpected == null
            ? 0.72
            : 0.82;
        reasonCodes.push('benchmark_underperformance_majority');
      } else if (underperformingBenchmarks > outperformingBenchmarks) {
        benchmarkComparisonState = 'underperforming';
        baselinePenaltyMultiplier = 0.9;
        reasonCodes.push('benchmark_underperformance_minor');
      } else if (
        outperformingBenchmarks === benchmarkContexts.length &&
        benchmarkContexts.length > 0
      ) {
        benchmarkComparisonState = 'outperforming';
        reasonCodes.push('benchmark_context_outperforming');
      } else {
        benchmarkComparisonState = 'neutral';
        reasonCodes.push('benchmark_context_mixed');
      }
    }

    if (benchmarkComparisonState === 'outperforming') {
      regimeBenchmarkGateState = 'passed';
      promotionBlockedByBenchmark = false;
      gateReasonCodes.push('benchmark_gate_passed');
    } else if (benchmarkComparisonState === 'context_missing') {
      regimeBenchmarkGateState = 'insufficient_evidence';
      promotionBlockedByBenchmark = true;
      gateReasonCodes.push('benchmark_gate_insufficient_evidence');
    } else {
      regimeBenchmarkGateState = 'blocked';
      promotionBlockedByBenchmark = true;
      gateReasonCodes.push('benchmark_gate_unfavorable_context');
      if (benchmarkComparisonState === 'underperforming') {
        gateReasonCodes.push('benchmark_gate_underperforming_context');
      }
      if (benchmarkComparisonState === 'neutral') {
        gateReasonCodes.push('benchmark_gate_non_outperforming_context');
      }
    }

    return {
      baselinePenaltyMultiplier,
      benchmarkComparisonState,
      regimeBenchmarkGateState,
      promotionBlockedByBenchmark,
      regimeBenchmarkReasonCodes: Array.from(new Set(gateReasonCodes)),
      benchmarkPenaltyReasonCodes: Array.from(new Set(reasonCodes)),
      evidence: {
        regime,
        strategyContext,
        benchmarkContexts,
        regimeBenchmarkGateState,
        promotionBlockedByBenchmark,
        overallUnderperformedBenchmarkIds: input.overallUnderperformedBenchmarkIds,
        overallOutperformedBenchmarkIds: input.overallOutperformedBenchmarkIds,
      },
      capturedAt: new Date().toISOString(),
    };
  }
}
