import type { VenueRuntimeMode } from '@polymarket-btc-5m-agentic-bot/domain';
import type { VenueUncertaintyAssessment } from './venue-uncertainty-detector';

export interface VenueModeDecision {
  mode: VenueRuntimeMode;
  sizeMultiplier: number;
  blockNewEntries: boolean;
  allowOrderSubmit: boolean;
  reasons: string[];
}

export class VenueModePolicy {
  decide(input: VenueUncertaintyAssessment): VenueModeDecision {
    if (input.label === 'healthy') {
      return {
        mode: 'normal',
        sizeMultiplier: 1,
        blockNewEntries: false,
        allowOrderSubmit: true,
        reasons: input.reasons,
      };
    }

    if (input.label === 'degraded') {
      return {
        mode: 'size-reduced',
        sizeMultiplier: 0.5,
        blockNewEntries: false,
        allowOrderSubmit: true,
        reasons: input.reasons,
      };
    }

    const reconciliationOnly =
      input.reasons.includes('stale_data_interval_unsafe') ||
      input.reasons.includes('open_order_visibility_lag_unsafe') ||
      input.reasons.includes('trade_visibility_lag_unsafe');

    return {
      mode: reconciliationOnly ? 'reconciliation-only' : 'cancel-only',
      sizeMultiplier: 0,
      blockNewEntries: true,
      allowOrderSubmit: false,
      reasons: input.reasons,
    };
  }
}
