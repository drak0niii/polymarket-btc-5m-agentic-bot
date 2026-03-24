import type { HealthLabel, NetEdgeVenueUncertaintyLabel } from '@polymarket-btc-5m-agentic-bot/domain';

export interface SizePenaltyEngineInput {
  calibrationHealth: HealthLabel | null;
  executionHealth: HealthLabel | null;
  regimeHealth: HealthLabel | null;
  venueUncertaintyLabel: NetEdgeVenueUncertaintyLabel | null;
  concentrationPenaltyMultiplier?: number | null;
  correlationPenaltyMultiplier?: number | null;
}

export interface SizePenaltyEngineDecision {
  multiplier: number;
  componentPenalties: {
    calibrationPenalty: number;
    executionPenalty: number;
    regimePenalty: number;
    venuePenalty: number;
    concentrationPenalty: number;
  };
  reasons: string[];
  evidence: Record<string, unknown>;
}

export class SizePenaltyEngine {
  evaluate(input: SizePenaltyEngineInput): SizePenaltyEngineDecision {
    const calibrationPenalty = penaltyForHealth(input.calibrationHealth);
    const executionPenalty = penaltyForHealth(input.executionHealth);
    const regimePenalty = penaltyForHealth(input.regimeHealth);
    const venuePenalty =
      input.venueUncertaintyLabel === 'degraded'
        ? 0.1
        : input.venueUncertaintyLabel === 'unsafe'
          ? 0.35
          : 0;
    const concentrationMultiplier = clamp(
      Math.min(
        input.concentrationPenaltyMultiplier ?? 1,
        input.correlationPenaltyMultiplier ?? 1,
      ),
      0,
      1,
    );
    const concentrationPenalty = 1 - concentrationMultiplier;
    const multiplier = clamp(
      (1 - calibrationPenalty) *
        (1 - executionPenalty) *
        (1 - regimePenalty) *
        (1 - venuePenalty) *
        concentrationMultiplier,
      0,
      1,
    );
    const reasons: string[] = [];
    if (calibrationPenalty > 0) {
      reasons.push(`calibration_penalty_${calibrationPenalty.toFixed(2)}`);
    }
    if (executionPenalty > 0) {
      reasons.push(`execution_penalty_${executionPenalty.toFixed(2)}`);
    }
    if (regimePenalty > 0) {
      reasons.push(`regime_penalty_${regimePenalty.toFixed(2)}`);
    }
    if (venuePenalty > 0) {
      reasons.push(`venue_penalty_${venuePenalty.toFixed(2)}`);
    }
    if (concentrationPenalty > 0) {
      reasons.push(`concentration_penalty_${concentrationPenalty.toFixed(2)}`);
    }

    return {
      multiplier,
      componentPenalties: {
        calibrationPenalty,
        executionPenalty,
        regimePenalty,
        venuePenalty,
        concentrationPenalty,
      },
      reasons,
      evidence: {
        calibrationHealth: input.calibrationHealth,
        executionHealth: input.executionHealth,
        regimeHealth: input.regimeHealth,
        venueUncertaintyLabel: input.venueUncertaintyLabel,
        concentrationPenaltyMultiplier: input.concentrationPenaltyMultiplier ?? null,
        correlationPenaltyMultiplier: input.correlationPenaltyMultiplier ?? null,
      },
    };
  }
}

function penaltyForHealth(health: HealthLabel | null): number {
  if (health === 'quarantine_candidate') {
    return 0.35;
  }
  if (health === 'degraded') {
    return 0.15;
  }
  if (health === 'watch') {
    return 0.05;
  }
  return 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
