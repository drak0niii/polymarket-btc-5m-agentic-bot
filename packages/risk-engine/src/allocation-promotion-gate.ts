import type { HealthLabel } from '@polymarket-btc-5m-agentic-bot/domain';

export interface AllocationPromotionGateResult {
  allowScale: boolean;
  reasons: string[];
}

export class AllocationPromotionGate {
  evaluate(input: {
    targetMultiplier: number;
    sampleCount: number;
    calibrationHealth: HealthLabel;
    executionHealth: HealthLabel;
    currentDrawdown: number;
    concentrationPenaltyMultiplier: number;
    correlationPenaltyMultiplier: number;
  }): AllocationPromotionGateResult {
    if (input.targetMultiplier <= 1) {
      return {
        allowScale: true,
        reasons: ['allocation_not_requesting_scale_up'],
      };
    }

    const reasons: string[] = [];
    if (input.calibrationHealth !== 'healthy') {
      reasons.push(`calibration_health_${input.calibrationHealth}`);
    }
    if (input.executionHealth !== 'healthy') {
      reasons.push(`execution_health_${input.executionHealth}`);
    }
    if (input.sampleCount < 8) {
      reasons.push('sample_sufficiency_not_met_for_scaling');
    }
    if (input.currentDrawdown > 0.03) {
      reasons.push('drawdown_state_blocks_scaling');
    }
    if (input.concentrationPenaltyMultiplier < 0.95) {
      reasons.push('concentration_penalty_blocks_scaling');
    }
    if (input.correlationPenaltyMultiplier < 0.95) {
      reasons.push('correlation_penalty_blocks_scaling');
    }

    return {
      allowScale: reasons.length === 0,
      reasons: reasons.length > 0 ? reasons : ['allocation_scale_up_supported'],
    };
  }
}
