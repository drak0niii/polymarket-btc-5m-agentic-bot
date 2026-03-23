import type {
  CalibrationState,
  HealthLabel,
} from '@polymarket-btc-5m-agentic-bot/domain';

export interface ConfidenceShrinkageDecision {
  health: HealthLabel;
  thresholdMultiplier: number;
  sizeMultiplier: number;
  rationale: string[];
}

export class ConfidenceShrinkagePolicy {
  evaluate(calibration: CalibrationState | null): ConfidenceShrinkageDecision {
    if (!calibration) {
      return {
        health: 'healthy',
        thresholdMultiplier: 1,
        sizeMultiplier: 1,
        rationale: ['no_live_calibration_state'],
      };
    }

    if (calibration.health === 'quarantine_candidate') {
      return {
        health: calibration.health,
        thresholdMultiplier: Math.max(1.5, 1 + (1 - calibration.shrinkageFactor)),
        sizeMultiplier: Math.min(0.4, calibration.shrinkageFactor),
        rationale: [
          'calibration_collapse_detected',
          ...calibration.driftSignals,
        ],
      };
    }

    if (calibration.health === 'degraded') {
      return {
        health: calibration.health,
        thresholdMultiplier: Math.max(1.25, 1 + (1 - calibration.shrinkageFactor) * 0.8),
        sizeMultiplier: Math.min(0.7, calibration.shrinkageFactor),
        rationale: [
          'calibration_degraded_reduce_aggressiveness',
          ...calibration.driftSignals,
        ],
      };
    }

    if (calibration.health === 'watch') {
      return {
        health: calibration.health,
        thresholdMultiplier: Math.max(1.08, 1 + (1 - calibration.shrinkageFactor) * 0.5),
        sizeMultiplier: Math.min(0.9, Math.max(0.75, calibration.shrinkageFactor)),
        rationale: [
          'calibration_watch_apply_soft_shrinkage',
          ...calibration.driftSignals,
        ],
      };
    }

    return {
      health: calibration.health,
      thresholdMultiplier: 1,
      sizeMultiplier: Math.min(1, Math.max(0.9, calibration.shrinkageFactor)),
      rationale: calibration.driftSignals.length > 0 ? calibration.driftSignals : ['calibration_healthy'],
    };
  }
}
