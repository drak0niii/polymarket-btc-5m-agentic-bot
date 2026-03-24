import type { HealthLabel, NetEdgeVenueUncertaintyLabel } from '@polymarket-btc-5m-agentic-bot/domain';

export interface UncertaintyWeightedSizingInput {
  basePositionSize: number;
  netEdge: number;
  netEdgeThreshold: number;
  calibrationHealth: HealthLabel | null;
  executionHealth: HealthLabel | null;
  regimeHealth: HealthLabel | null;
  venueHealth: NetEdgeVenueUncertaintyLabel | null;
  currentDrawdownPct: number | null;
  sampleCount: number | null;
}

export interface UncertaintyWeightedSizingDecision {
  adjustedPositionSize: number;
  multiplier: number;
  uncertaintyScore: number;
  reasons: string[];
  evidence: Record<string, unknown>;
}

export class UncertaintyWeightedSizing {
  evaluate(input: UncertaintyWeightedSizingInput): UncertaintyWeightedSizingDecision {
    const edgeMargin = input.netEdge - input.netEdgeThreshold;
    let multiplier = 1;
    const reasons: string[] = [];

    if (edgeMargin <= 0) {
      multiplier = 0;
      reasons.push('net_edge_below_threshold_zero_size');
    } else if (edgeMargin < 0.0015) {
      multiplier *= 0.75;
      reasons.push('net_edge_margin_thin');
    } else if (edgeMargin < 0.004) {
      multiplier *= 0.9;
      reasons.push('net_edge_margin_moderate');
    }

    multiplier *= healthMultiplier('calibration', input.calibrationHealth, reasons);
    multiplier *= healthMultiplier('execution', input.executionHealth, reasons);
    multiplier *= healthMultiplier('regime', input.regimeHealth, reasons);

    if (input.venueHealth === 'degraded') {
      multiplier *= 0.9;
      reasons.push('venue_health_degraded_reduces_size');
    } else if (input.venueHealth === 'unsafe') {
      multiplier *= 0.4;
      reasons.push('venue_health_unsafe_collapses_size');
    }

    if ((input.currentDrawdownPct ?? 0) >= 0.08) {
      multiplier *= 0.55;
      reasons.push('drawdown_state_severe');
    } else if ((input.currentDrawdownPct ?? 0) >= 0.04) {
      multiplier *= 0.85;
      reasons.push('drawdown_state_elevated');
    }

    if ((input.sampleCount ?? 0) < 5) {
      multiplier *= 0.9;
      reasons.push('sample_sufficiency_weak');
    } else if ((input.sampleCount ?? 0) < 10) {
      multiplier *= 0.95;
      reasons.push('sample_sufficiency_moderate');
    }

    multiplier = clamp(multiplier, 0, 1.2);
    const uncertaintyScore = clamp(1 - multiplier, 0, 1);

    return {
      adjustedPositionSize: Math.max(0, input.basePositionSize * multiplier),
      multiplier,
      uncertaintyScore,
      reasons,
      evidence: {
        edgeMargin,
        netEdge: input.netEdge,
        netEdgeThreshold: input.netEdgeThreshold,
        calibrationHealth: input.calibrationHealth,
        executionHealth: input.executionHealth,
        regimeHealth: input.regimeHealth,
        venueHealth: input.venueHealth,
        currentDrawdownPct: input.currentDrawdownPct,
        sampleCount: input.sampleCount,
      },
    };
  }
}

function healthMultiplier(
  label: 'calibration' | 'execution' | 'regime',
  health: HealthLabel | null,
  reasons: string[],
): number {
  if (health === 'quarantine_candidate') {
    reasons.push(`${label}_health_quarantine_candidate`);
    return 0.45;
  }
  if (health === 'degraded') {
    reasons.push(`${label}_health_degraded`);
    return 0.85;
  }
  if (health === 'watch') {
    reasons.push(`${label}_health_watch`);
    return 0.95;
  }
  return 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
