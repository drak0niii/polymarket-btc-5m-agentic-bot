export type OrderExecutionLifecycleState =
  | 'working'
  | 'matched'
  | 'mined'
  | 'confirmed'
  | 'retrying'
  | 'failed'
  | 'cancel_pending'
  | 'cancel_confirmed'
  | 'economically_final_enough';

export interface OrderExecutionState {
  intendedSize: number;
  cumulativeFilledSize: number;
  averageFillPrice: number | null;
  remainingSize: number;
  cumulativeFees: number;
  lastVisibleVenueState: string;
  lastUserStreamUpdateAt: string | null;
  lastRestConfirmationAt: string | null;
  lastMatchedAt?: string | null;
  lastLifecycleState?: OrderExecutionLifecycleState | null;
  retryCount?: number;
  cancelRequestedAt?: string | null;
  cancelConfirmedAt?: string | null;
}

export interface FillApplicationInput {
  state: OrderExecutionState;
  fillPrice: number;
  fillSize: number;
  fee: number | null;
  venueState?: string | null;
  observedAt?: string | null;
  restConfirmed?: boolean | null;
}

export interface ResidualDecisionInput {
  remainingSize: number;
  minMeaningfulSize: number;
  signalAgeMs: number;
  maxSignalAgeMs: number;
  priceDriftBps: number;
  fillProbability: number;
}

export interface GhostExposureCheckInput {
  localOrderIds: string[];
  venueOrderIds: string[];
  userStreamOrderIds: string[];
  unresolvedIntentIds: string[];
}

export interface GhostExposureCheckResult {
  ghostExposureDetected: boolean;
  reasonCodes: string[];
  disagreementCount: number;
}

export interface OrderExecutionLifecycleInput {
  state: OrderExecutionState;
  orderStatus?: string | null;
  venueState?: string | null;
  hasRestConfirmation?: boolean;
  retryCount?: number | null;
  lastError?: string | null;
  cancelRequestedAt?: string | null;
  cancelConfirmedAt?: string | null;
}

export interface OrderExecutionLifecycleAssessment {
  lifecycleState: OrderExecutionLifecycleState;
  economicallyFinalEnough: boolean;
  confidence: 'low' | 'medium' | 'high';
  reasonCodes: string[];
}

export class FillStateService {
  applyFill(input: FillApplicationInput): OrderExecutionState {
    const appliedFillSize = Math.max(0, input.fillSize);
    const nextFilled = Math.min(
      input.state.intendedSize,
      input.state.cumulativeFilledSize + appliedFillSize,
    );
    const weighted =
      (input.state.averageFillPrice ?? 0) * input.state.cumulativeFilledSize +
      input.fillPrice * appliedFillSize;
    const observedAt = input.observedAt ?? input.state.lastUserStreamUpdateAt ?? null;
    const normalizedVenueState = normalizeStateLabel(input.venueState);
    const restConfirmed =
      input.restConfirmed === true ||
      normalizedVenueState === 'confirmed' ||
      normalizedVenueState === 'filled' ||
      normalizedVenueState === 'completed' ||
      normalizedVenueState === 'mined';

    return {
      intendedSize: input.state.intendedSize,
      cumulativeFilledSize: nextFilled,
      averageFillPrice: nextFilled > 0 ? weighted / nextFilled : null,
      remainingSize: Math.max(0, input.state.intendedSize - nextFilled),
      cumulativeFees: input.state.cumulativeFees + Math.max(0, input.fee ?? 0),
      lastVisibleVenueState: input.venueState ?? input.state.lastVisibleVenueState,
      lastUserStreamUpdateAt: observedAt,
      lastRestConfirmationAt:
        restConfirmed && observedAt != null
          ? observedAt
          : input.state.lastRestConfirmationAt ?? null,
      lastMatchedAt: observedAt,
      lastLifecycleState: restConfirmed
        ? nextFilled >= input.state.intendedSize - 1e-8
          ? 'confirmed'
          : 'mined'
        : 'matched',
      retryCount: input.state.retryCount ?? 0,
      cancelRequestedAt: input.state.cancelRequestedAt ?? null,
      cancelConfirmedAt: input.state.cancelConfirmedAt ?? null,
    };
  }

  assessLifecycle(input: OrderExecutionLifecycleInput): OrderExecutionLifecycleAssessment {
    const orderStatus = normalizeStateLabel(input.orderStatus);
    const venueState = normalizeStateLabel(input.venueState ?? input.state.lastVisibleVenueState);
    const lastError = String(input.lastError ?? '').toLowerCase();
    const retryCount = input.retryCount ?? input.state.retryCount ?? 0;
    const cancelRequestedAt = input.cancelRequestedAt ?? input.state.cancelRequestedAt ?? null;
    const cancelConfirmedAt = input.cancelConfirmedAt ?? input.state.cancelConfirmedAt ?? null;
    const hasRestConfirmation =
      input.hasRestConfirmation ?? input.state.lastRestConfirmationAt != null;
    const nearlyFilled = input.state.remainingSize <= 1e-8;
    const partiallyFilled = input.state.cumulativeFilledSize > 0 && !nearlyFilled;
    const reasons: string[] = [];

    if (cancelConfirmedAt != null || orderStatus === 'canceled' || venueState === 'canceled') {
      reasons.push('cancel_confirmed');
      return {
        lifecycleState:
          input.state.cumulativeFilledSize > 0 || hasRestConfirmation
            ? 'economically_final_enough'
            : 'cancel_confirmed',
        economicallyFinalEnough:
          input.state.cumulativeFilledSize > 0 || hasRestConfirmation,
        confidence: hasRestConfirmation ? 'high' : 'medium',
        reasonCodes: reasons,
      };
    }

    if (
      lastError.includes('retry') ||
      orderStatus === 'retrying' ||
      venueState === 'retrying' ||
      retryCount > 0
    ) {
      reasons.push('retry_pending');
      return {
        lifecycleState: 'retrying',
        economicallyFinalEnough: false,
        confidence: 'low',
        reasonCodes: reasons,
      };
    }

    if (
      lastError.includes('failed') ||
      lastError.includes('reject') ||
      orderStatus === 'failed' ||
      orderStatus === 'rejected' ||
      venueState === 'failed' ||
      venueState === 'rejected'
    ) {
      reasons.push('terminal_failure_detected');
      return {
        lifecycleState: 'failed',
        economicallyFinalEnough: false,
        confidence: 'high',
        reasonCodes: reasons,
      };
    }

    if (cancelRequestedAt != null || venueState === 'cancel_requested' || orderStatus === 'cancel_requested') {
      reasons.push('cancel_pending_confirmation');
      return {
        lifecycleState: 'cancel_pending',
        economicallyFinalEnough: false,
        confidence: 'medium',
        reasonCodes: reasons,
      };
    }

    if (nearlyFilled && hasRestConfirmation) {
      reasons.push('full_fill_rest_confirmed');
      return {
        lifecycleState: 'economically_final_enough',
        economicallyFinalEnough: true,
        confidence: 'high',
        reasonCodes: reasons,
      };
    }

    if (nearlyFilled) {
      reasons.push('full_fill_user_truth_only');
      return {
        lifecycleState: 'confirmed',
        economicallyFinalEnough: false,
        confidence: 'medium',
        reasonCodes: reasons,
      };
    }

    if (partiallyFilled && hasRestConfirmation) {
      reasons.push('partial_fill_rest_confirmed');
      return {
        lifecycleState: 'mined',
        economicallyFinalEnough: false,
        confidence: 'medium',
        reasonCodes: reasons,
      };
    }

    if (partiallyFilled && (venueState === 'matched' || venueState === 'mined')) {
      reasons.push('partial_fill_matched_not_final');
      return {
        lifecycleState: venueState === 'mined' ? 'mined' : 'matched',
        economicallyFinalEnough: false,
        confidence: 'low',
        reasonCodes: reasons,
      };
    }

    if (partiallyFilled) {
      reasons.push('partial_fill_in_progress');
      return {
        lifecycleState: 'matched',
        economicallyFinalEnough: false,
        confidence: 'low',
        reasonCodes: reasons,
      };
    }

    return {
      lifecycleState: 'working',
      economicallyFinalEnough: false,
      confidence: 'low',
      reasonCodes: ['still_working'],
    };
  }

  decideResidual(input: ResidualDecisionInput): 'keep' | 'replace' | 'cancel' {
    if (input.remainingSize < input.minMeaningfulSize) {
      return 'cancel';
    }
    if (input.signalAgeMs > input.maxSignalAgeMs) {
      return 'cancel';
    }
    if (input.fillProbability < 0.2 && input.priceDriftBps > 8) {
      return 'replace';
    }
    return 'keep';
  }

  detectGhostExposure(input: GhostExposureCheckInput): boolean {
    return this.detectGhostExposureDetails(input).ghostExposureDetected;
  }

  detectGhostExposureDetails(input: GhostExposureCheckInput): GhostExposureCheckResult {
    const local = new Set(input.localOrderIds);
    const venue = new Set(input.venueOrderIds);
    const stream = new Set(input.userStreamOrderIds);
    const unresolved = new Set(input.unresolvedIntentIds);
    const reasonCodes: string[] = [];
    let disagreementCount = 0;

    for (const id of local) {
      if (!venue.has(id) && !stream.has(id)) {
        disagreementCount += 1;
      }
    }
    for (const id of venue) {
      if (!local.has(id) && !stream.has(id)) {
        disagreementCount += 1;
      }
    }
    if (disagreementCount > 0) {
      reasonCodes.push('order_truth_disagreement');
    }
    if (unresolved.size > 0) {
      reasonCodes.push('unresolved_intent_after_reconnect');
    }

    return {
      ghostExposureDetected: disagreementCount > 0 || unresolved.size > 0,
      reasonCodes,
      disagreementCount,
    };
  }
}

function normalizeStateLabel(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.trim().toLowerCase();
}
