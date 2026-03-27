import type { LiveTrustScoreDecision } from './live-trust-score';

export type EvidenceQualityBand =
  | 'shadow_only'
  | 'quarter_size'
  | 'half_size'
  | 'three_quarter_size'
  | 'full_size';

export interface EvidenceQualitySizingDecision {
  strategyVariantId: string | null;
  regime: string | null;
  trustScore: number;
  evidenceFactor: number;
  recentEvidenceBand: EvidenceQualityBand;
  shadowOnly: boolean;
  rationale: string[];
  capReason: string | null;
  thresholdsUsed: Record<string, number>;
  thresholdsMet: string[];
  thresholdsUnmet: string[];
  capturedAt: string;
}

export class EvidenceQualitySizer {
  evaluate(input: { trust: LiveTrustScoreDecision }): EvidenceQualitySizingDecision {
    const trust = input.trust;
    let evidenceFactor = 1;
    let recentEvidenceBand: EvidenceQualityBand = 'full_size';
    const rationale: string[] = [];
    let capReason: string | null = null;

    if (trust.trustScore < 0.25) {
      evidenceFactor = 0;
      recentEvidenceBand = 'shadow_only';
      capReason = 'trust_score_below_shadow_threshold';
    } else if (trust.trustScore < 0.45) {
      evidenceFactor = 0.25;
      recentEvidenceBand = 'quarter_size';
      capReason = 'trust_score_below_quarter_threshold';
    } else if (trust.trustScore < 0.65) {
      evidenceFactor = 0.5;
      recentEvidenceBand = 'half_size';
      capReason = 'trust_score_below_half_threshold';
    } else if (trust.trustScore < 0.8) {
      evidenceFactor = 0.75;
      recentEvidenceBand = 'three_quarter_size';
      capReason = 'trust_score_below_full_threshold';
    }

    const thresholdsUsed = {
      minimumLiveTradesForScale: 6,
      minimumBenchmarkComponentForScale: 0.5,
      minimumReconciliationComponentForScale: 0.7,
    };
    const thresholdsMet: string[] = [];
    const thresholdsUnmet: string[] = [];

    if (trust.sampleCount >= thresholdsUsed.minimumLiveTradesForScale) {
      thresholdsMet.push('minimum_live_trades_for_scale');
    } else {
      thresholdsUnmet.push('minimum_live_trades_for_scale');
      evidenceFactor = Math.min(evidenceFactor, 0.25);
      recentEvidenceBand = evidenceFactor <= 0 ? 'shadow_only' : 'quarter_size';
      capReason = capReason ?? 'live_trade_sample_below_scale_threshold';
    }

    if (
      trust.componentBreakdown.benchmarkOutperformance >=
      thresholdsUsed.minimumBenchmarkComponentForScale
    ) {
      thresholdsMet.push('minimum_benchmark_component_for_scale');
    } else {
      thresholdsUnmet.push('minimum_benchmark_component_for_scale');
      evidenceFactor = Math.min(evidenceFactor, 0.5);
      if (evidenceFactor === 0) {
        recentEvidenceBand = 'shadow_only';
      } else if (evidenceFactor <= 0.25) {
        recentEvidenceBand = 'quarter_size';
      } else {
        recentEvidenceBand = 'half_size';
      }
      capReason = capReason ?? 'benchmark_outperformance_not_proven';
    }

    if (
      trust.componentBreakdown.reconciliationCleanliness >=
      thresholdsUsed.minimumReconciliationComponentForScale
    ) {
      thresholdsMet.push('minimum_reconciliation_component_for_scale');
    } else {
      thresholdsUnmet.push('minimum_reconciliation_component_for_scale');
      evidenceFactor = Math.min(evidenceFactor, 0.5);
      if (evidenceFactor === 0) {
        recentEvidenceBand = 'shadow_only';
      } else if (evidenceFactor <= 0.25) {
        recentEvidenceBand = 'quarter_size';
      } else {
        recentEvidenceBand = 'half_size';
      }
      capReason = capReason ?? 'reconciliation_cleanliness_not_proven';
    }

    rationale.push(`trust_band:${recentEvidenceBand}`);
    rationale.push(
      ...(thresholdsMet.map((threshold) => `threshold_met:${threshold}`)),
      ...(thresholdsUnmet.map((threshold) => `threshold_unmet:${threshold}`)),
    );

    return {
      strategyVariantId: trust.strategyVariantId,
      regime: trust.regime,
      trustScore: trust.trustScore,
      evidenceFactor,
      recentEvidenceBand,
      shadowOnly: evidenceFactor <= 0,
      rationale: Array.from(new Set(rationale)),
      capReason,
      thresholdsUsed,
      thresholdsMet,
      thresholdsUnmet,
      capturedAt: new Date().toISOString(),
    };
  }
}
