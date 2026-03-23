export interface DuplicateExposureWorkingOrder {
  id: string | null;
  signalId?: string | null;
  tokenId: string;
  side: 'BUY' | 'SELL';
  size: number;
  matchedSize?: number | null;
  remainingSize?: number | null;
  status?: string | null;
}

export interface DuplicateExposureGuardInput {
  marketId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  inventoryEffect: 'INCREASE' | 'DECREASE';
  desiredSize: number;
  currentPositionSize: number;
  localWorkingOrders: DuplicateExposureWorkingOrder[];
  venueWorkingOrders: DuplicateExposureWorkingOrder[];
  allowExplicitScaleIn?: boolean;
}

export interface DuplicateExposureGuardResult {
  allowed: boolean;
  reasonCode: string;
  reasonMessage: string;
  currentPositionSize: number;
  localWorkingExposure: number;
  venueWorkingExposure: number;
  proposedAggregateExposure: number;
}

export class DuplicateExposureGuard {
  evaluate(input: DuplicateExposureGuardInput): DuplicateExposureGuardResult {
    const localWorkingExposure = this.sumRemainingExposure(
      input.localWorkingOrders.filter(
        (order) => order.tokenId === input.tokenId && order.side === input.side,
      ),
    );
    const venueWorkingExposure = this.sumRemainingExposure(
      input.venueWorkingOrders.filter(
        (order) => order.tokenId === input.tokenId && order.side === input.side,
      ),
    );
    const proposedAggregateExposure =
      input.currentPositionSize + localWorkingExposure + venueWorkingExposure + input.desiredSize;

    if (input.inventoryEffect === 'INCREASE') {
      if (!input.allowExplicitScaleIn && input.currentPositionSize > 1e-8) {
        return {
          allowed: false,
          reasonCode: 'duplicate_open_position_exposure',
          reasonMessage:
            'Execution policy blocks additive entry exposure while a position already exists on this token.',
          currentPositionSize: input.currentPositionSize,
          localWorkingExposure,
          venueWorkingExposure,
          proposedAggregateExposure,
        };
      }

      if (localWorkingExposure > 1e-8 || venueWorkingExposure > 1e-8) {
        return {
          allowed: false,
          reasonCode: 'duplicate_working_order_exposure',
          reasonMessage:
            'Execution policy blocks a new entry while same-side working venue exposure still exists.',
          currentPositionSize: input.currentPositionSize,
          localWorkingExposure,
          venueWorkingExposure,
          proposedAggregateExposure,
        };
      }
    }

    if (input.inventoryEffect === 'DECREASE') {
      if (input.currentPositionSize <= 1e-8) {
        return {
          allowed: false,
          reasonCode: 'position_to_reduce_missing',
          reasonMessage:
            'Execution policy blocks reduction or exit orders when no current external position exists.',
          currentPositionSize: input.currentPositionSize,
          localWorkingExposure,
          venueWorkingExposure,
          proposedAggregateExposure,
        };
      }

      if (localWorkingExposure > 1e-8 || venueWorkingExposure > 1e-8) {
        return {
          allowed: false,
          reasonCode: 'duplicate_exit_order_exposure',
          reasonMessage:
            'Execution policy blocks a new reduction or exit while venue-facing working reduction exposure still exists.',
          currentPositionSize: input.currentPositionSize,
          localWorkingExposure,
          venueWorkingExposure,
          proposedAggregateExposure,
        };
      }

      if (input.desiredSize - input.currentPositionSize > 1e-8) {
        return {
          allowed: false,
          reasonCode: 'reduction_size_exceeds_position',
          reasonMessage:
            'Execution policy blocks reduction or exit size that would exceed current external position quantity.',
          currentPositionSize: input.currentPositionSize,
          localWorkingExposure,
          venueWorkingExposure,
          proposedAggregateExposure,
        };
      }
    }

    return {
      allowed: true,
      reasonCode: 'duplicate_exposure_clear',
      reasonMessage: 'No conflicting working or filled venue exposure was detected for this token.',
      currentPositionSize: input.currentPositionSize,
      localWorkingExposure,
      venueWorkingExposure,
      proposedAggregateExposure,
    };
  }

  private sumRemainingExposure(orders: DuplicateExposureWorkingOrder[]): number {
    return orders.reduce((sum, order) => sum + this.remainingSize(order), 0);
  }

  private remainingSize(order: DuplicateExposureWorkingOrder): number {
    const explicitRemaining = Number(order.remainingSize ?? Number.NaN);
    if (Number.isFinite(explicitRemaining) && explicitRemaining > 0) {
      return explicitRemaining;
    }

    const matchedSize = Number(order.matchedSize ?? 0);
    return Math.max(0, Number(order.size) - (Number.isFinite(matchedSize) ? matchedSize : 0));
  }
}
