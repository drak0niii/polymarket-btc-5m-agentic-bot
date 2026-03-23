export type OperationalTransitionState =
  | 'degraded'
  | 'reconciliation_only'
  | 'cancel_only'
  | 'halted_hard'
  | null;

export type OperationalRejectType =
  | 'venue_geoblocked'
  | 'venue_closed_only'
  | 'auth_failed'
  | 'clock_skew_detected'
  | 'venue_validation_failed'
  | 'rate_limited'
  | 'network_unavailable'
  | 'server_unavailable'
  | 'venue_unknown_error';

export interface OperationalPolicyInput {
  reasonCode: OperationalRejectType;
  recentRejectCount?: number;
}

export interface OperationalTransitionDecision {
  transitionTo: OperationalTransitionState;
  haltTrading: boolean;
  blockNewEntries: boolean;
  forceCancelAll: boolean;
  reasonCode: string;
}

export class VenueOperationalPolicyService {
  evaluate(input: OperationalPolicyInput): OperationalTransitionDecision {
    switch (input.reasonCode) {
      case 'venue_geoblocked':
        return this.decision('halted_hard', true, true, 'operational_geoblock');
      case 'venue_closed_only':
        return this.decision('cancel_only', true, true, 'operational_closed_only');
      case 'auth_failed':
        return this.decision('reconciliation_only', true, false, 'operational_auth_invalid');
      case 'clock_skew_detected':
        return this.decision('reconciliation_only', true, false, 'operational_clock_skew');
      case 'venue_validation_failed':
        if ((input.recentRejectCount ?? 0) >= 5) {
          return this.decision(
            'cancel_only',
            true,
            true,
            'operational_validation_reject_burst',
          );
        }
        if ((input.recentRejectCount ?? 0) >= 3) {
          return this.decision(
            'degraded',
            true,
            false,
            'operational_validation_reject_warning',
          );
        }
        return this.decision(null, false, false, 'operational_validation_reject');
      case 'network_unavailable':
      case 'server_unavailable':
      case 'rate_limited':
      case 'venue_unknown_error':
      default:
        return this.decision(null, false, false, `operational_${input.reasonCode}`);
    }
  }

  private decision(
    transitionTo: OperationalTransitionState,
    haltTrading: boolean,
    forceCancelAll: boolean,
    reasonCode: string,
  ): OperationalTransitionDecision {
    return {
      transitionTo,
      haltTrading,
      blockNewEntries: haltTrading,
      forceCancelAll,
      reasonCode,
    };
  }
}
