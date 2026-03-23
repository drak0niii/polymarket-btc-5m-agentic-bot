export interface OrderExecutionState {
  intendedSize: number;
  cumulativeFilledSize: number;
  averageFillPrice: number | null;
  remainingSize: number;
  cumulativeFees: number;
  lastVisibleVenueState: string;
  lastUserStreamUpdateAt: string | null;
  lastRestConfirmationAt: string | null;
}

export interface FillApplicationInput {
  state: OrderExecutionState;
  fillPrice: number;
  fillSize: number;
  fee: number | null;
  venueState?: string | null;
  observedAt?: string | null;
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

export class FillStateService {
  applyFill(input: FillApplicationInput): OrderExecutionState {
    const nextFilled = Math.min(
      input.state.intendedSize,
      input.state.cumulativeFilledSize + Math.max(0, input.fillSize),
    );
    const weighted =
      (input.state.averageFillPrice ?? 0) * input.state.cumulativeFilledSize +
      input.fillPrice * Math.max(0, input.fillSize);
    return {
      intendedSize: input.state.intendedSize,
      cumulativeFilledSize: nextFilled,
      averageFillPrice: nextFilled > 0 ? weighted / nextFilled : null,
      remainingSize: Math.max(0, input.state.intendedSize - nextFilled),
      cumulativeFees: input.state.cumulativeFees + Math.max(0, input.fee ?? 0),
      lastVisibleVenueState: input.venueState ?? input.state.lastVisibleVenueState,
      lastUserStreamUpdateAt: input.observedAt ?? input.state.lastUserStreamUpdateAt,
      lastRestConfirmationAt: input.observedAt ?? input.state.lastRestConfirmationAt,
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
    const local = new Set(input.localOrderIds);
    const venue = new Set(input.venueOrderIds);
    const stream = new Set(input.userStreamOrderIds);
    const unresolved = new Set(input.unresolvedIntentIds);
    return (
      [...local].some((id) => !venue.has(id) && !stream.has(id)) ||
      [...venue].some((id) => !local.has(id) && !stream.has(id)) ||
      unresolved.size > 0
    );
  }
}
