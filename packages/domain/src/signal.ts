export type Outcome = 'YES' | 'NO';

export type TradeAction = 'ENTER' | 'REDUCE' | 'EXIT' | 'FLIP';

export type VenueSide = 'BUY' | 'SELL';

export type InventoryEffect = 'INCREASE' | 'DECREASE' | 'NEUTRAL';

export type SignalStatus =
  | 'created'
  | 'approved'
  | 'rejected'
  | 'executed'
  | 'expired'
  | 'canceled';

export type SignalDecisionVerdict = 'approved' | 'rejected';

export interface Signal {
  id: string;
  marketId: string;
  strategyVersionId: string | null;

  /**
   * Exchange-facing side, if already resolved.
   * This must NOT be treated as the full semantic meaning of the trade.
   */
  side: VenueSide | null;

  /**
   * Explicit target token, when already known.
   */
  tokenId: string | null;

  /**
   * Explicit thesis / target outcome.
   * YES means the YES token is intended.
   * NO means the NO token is intended.
   */
  outcome: Outcome | null;

  /**
   * Explicit trade action semantics.
   * ENTER  = open / add exposure on the intended token
   * REDUCE = reduce held inventory on the intended token
   * EXIT   = fully close held inventory on the intended token
   * FLIP   = close one side and rotate into the opposite side
   */
  action: TradeAction | null;

  /**
   * Inventory-level meaning of the signal.
   * INCREASE = adds inventory
   * DECREASE = reduces inventory
   * NEUTRAL  = non-directional / bookkeeping / unsupported transitional state
   */
  inventoryEffect: InventoryEffect | null;

  priorProbability: number;
  posteriorProbability: number;
  marketImpliedProb: number;
  edge: number;
  expectedEv: number;
  regime: string | null;
  status: SignalStatus | string;
  observedAt: string;
  createdAt: string;
}

export interface SignalDecision {
  id: string;
  signalId: string;
  verdict: SignalDecisionVerdict | string;
  reasonCode: string;
  reasonMessage: string | null;
  expectedEv: number | null;
  positionSize: number | null;
  decisionAt: string;
  createdAt: string;
}

/**
 * Runtime-safe helper used by execution / risk / evaluation layers.
 * A signal is considered execution-resolvable only when token intent is explicit.
 */
export function isResolvableSignal(signal: Signal): boolean {
  return Boolean(
    (signal.tokenId && signal.tokenId.trim().length > 0) ||
      signal.outcome,
  );
}

/**
 * Action-to-venue-side mapping.
 * ENTER usually means BUY on the target token.
 * REDUCE / EXIT usually mean SELL on the target token.
 * FLIP should generally be decomposed into multiple child signals/orders upstream.
 */
export function resolveVenueSideFromAction(
  action: TradeAction | null,
): VenueSide | null {
  if (!action) {
    return null;
  }

  if (action === 'ENTER') {
    return 'BUY';
  }

  if (action === 'REDUCE' || action === 'EXIT') {
    return 'SELL';
  }

  return null;
}

export function resolveInventoryEffectFromAction(
  action: TradeAction | null,
): InventoryEffect | null {
  if (!action) {
    return null;
  }

  if (action === 'ENTER') {
    return 'INCREASE';
  }

  if (action === 'REDUCE' || action === 'EXIT') {
    return 'DECREASE';
  }

  if (action === 'FLIP') {
    return 'NEUTRAL';
  }

  return null;
}