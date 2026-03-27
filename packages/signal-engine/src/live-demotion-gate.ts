import type { LivePromotionEvidencePacket } from './live-promotion-gate';

export type LiveDemotionAction = 'none' | 'probation' | 'demote' | 'quarantine';

export interface LiveDemotionGateComponentResult {
  triggered: boolean;
  observedValue: number;
  threshold: number;
}

export interface LiveDemotionGateDecision {
  action: LiveDemotionAction;
  reasonCodes: string[];
  quarantineUntil: string | null;
  components: {
    realizedVsExpectedGap: LiveDemotionGateComponentResult;
    repeatedExecutionUnderperformance: LiveDemotionGateComponentResult;
    benchmarkUnderperformance: LiveDemotionGateComponentResult;
    highRegimeInstability: LiveDemotionGateComponentResult;
    repeatedAdverseSelectionSpikes: LiveDemotionGateComponentResult;
  };
  evidencePacket: LivePromotionEvidencePacket;
  capturedAt: string;
}

export class LiveDemotionGate {
  evaluate(input: { evidencePacket: LivePromotionEvidencePacket; now?: Date }): LiveDemotionGateDecision {
    const now = input.now ?? new Date();
    const packet = input.evidencePacket;
    const realizedVsExpectedGap = buildComponent(
      Math.abs(packet.executionVarianceSummary.averageGapBps ?? 0),
      18,
      (packet.executionVarianceSummary.averageGapBps ?? 0) <= -18,
    );
    const repeatedExecutionUnderperformance = buildComponent(
      packet.executionVarianceSummary.stdDevGapBps ?? 0,
      65,
      (packet.executionVarianceSummary.stdDevGapBps ?? 0) >= 65,
    );
    const benchmarkUnderperformance = buildComponent(
      packet.benchmarkComparisonSummary.underperformingCount,
      2,
      packet.benchmarkComparisonSummary.underperformingCount >= 2 ||
        packet.benchmarkComparisonSummary.outperformanceShare < 0.35,
    );
    const highRegimeInstability = buildComponent(
      packet.regimeInstabilitySummary.instabilityScore,
      0.5,
      packet.regimeInstabilitySummary.instabilityScore >= 0.5,
    );
    const repeatedAdverseSelectionSpikes = buildComponent(
      packet.adverseSelectionSummary.spikeShare,
      0.3,
      packet.adverseSelectionSummary.spikeShare >= 0.3,
    );

    const reasonCodes: string[] = [];
    if (realizedVsExpectedGap.triggered) {
      reasonCodes.push('large_realized_vs_expected_edge_gap');
    }
    if (repeatedExecutionUnderperformance.triggered) {
      reasonCodes.push('repeated_execution_underperformance');
    }
    if (benchmarkUnderperformance.triggered) {
      reasonCodes.push('benchmark_underperformance');
    }
    if (highRegimeInstability.triggered) {
      reasonCodes.push('high_regime_instability');
    }
    if (repeatedAdverseSelectionSpikes.triggered) {
      reasonCodes.push('repeated_adverse_selection_spikes');
    }

    const severeTriggerCount = [
      realizedVsExpectedGap.triggered,
      repeatedExecutionUnderperformance.triggered,
      benchmarkUnderperformance.triggered,
      highRegimeInstability.triggered,
      repeatedAdverseSelectionSpikes.triggered,
    ].filter(Boolean).length;

    let action: LiveDemotionAction = 'none';
    let quarantineUntil: string | null = null;
    if (severeTriggerCount >= 4) {
      action = 'quarantine';
      quarantineUntil = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
    } else if (severeTriggerCount >= 3) {
      action = 'demote';
      quarantineUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    } else if (severeTriggerCount >= 1) {
      action = 'probation';
      quarantineUntil = new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString();
    }

    return {
      action,
      reasonCodes,
      quarantineUntil,
      components: {
        realizedVsExpectedGap,
        repeatedExecutionUnderperformance,
        benchmarkUnderperformance,
        highRegimeInstability,
        repeatedAdverseSelectionSpikes,
      },
      evidencePacket: packet,
      capturedAt: now.toISOString(),
    };
  }
}

function buildComponent(
  observedValue: number,
  threshold: number,
  triggered: boolean,
): LiveDemotionGateComponentResult {
  return {
    triggered,
    observedValue,
    threshold,
  };
}
