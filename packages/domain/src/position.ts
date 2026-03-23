export type Outcome = 'YES' | 'NO';

export type VenueSide = 'BUY' | 'SELL';

export type TradeIntent = 'ENTER' | 'REDUCE' | 'EXIT' | 'FLIP';

export type InventoryEffect = 'INCREASE' | 'DECREASE' | 'NEUTRAL';

export type PositionStatus = 'open' | 'closed';

export interface Position {
  id: string;
  marketId: string;

  /**
   * Specific Polymarket outcome token held by this position.
   * This is the primary identity of the position together with marketId.
   */
  tokenId: string;

  /**
   * Outcome represented by tokenId.
   * YES and NO positions in the same market must remain distinct.
   */
  outcome: Outcome | null;

  /**
   * Legacy venue-facing side semantics.
   * Retained for compatibility, but not sufficient on its own to identify
   * the actual position thesis or inventory.
   */
  side: VenueSide;

  /**
   * Optional portfolio / strategy semantics that describe how this position
   * was opened or is being managed.
   */
  intent: TradeIntent | null;

  /**
   * Inventory meaning of the current position record.
   */
  inventoryEffect: InventoryEffect | null;

  entryPrice: number;
  quantity: number;
  status: PositionStatus | string;
  openedAt: string;
  closedAt: string | null;
  realizedPnl: number | null;
  unrealizedPnl: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Stable identity for a held position.
 * Market-level identity alone is not enough because YES and NO are distinct.
 */
export function getPositionIdentity(
  position: Pick<Position, 'marketId' | 'tokenId'>,
): string {
  return `${position.marketId}::${position.tokenId}`;
}

export function isOpenPosition(position: Pick<Position, 'status'>): boolean {
  return position.status === 'open';
}

export function isYesPosition(position: Pick<Position, 'outcome'>): boolean {
  return position.outcome === 'YES';
}

export function isNoPosition(position: Pick<Position, 'outcome'>): boolean {
  return position.outcome === 'NO';
}