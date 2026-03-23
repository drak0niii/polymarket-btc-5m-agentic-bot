export type Outcome = 'YES' | 'NO';

export type TradeIntent = 'ENTER' | 'REDUCE' | 'EXIT' | 'FLIP';

export type VenueSide = 'BUY' | 'SELL';

export type InventoryEffect = 'INCREASE' | 'DECREASE' | 'NEUTRAL';

export type OrderStatus =
  | 'created'
  | 'submitted'
  | 'acknowledged'
  | 'partially_filled'
  | 'filled'
  | 'canceled'
  | 'rejected'
  | 'expired';

export interface Order {
  id: string;
  marketId: string;

  /**
   * Specific Polymarket outcome token being traded.
   * This is the primary execution identity of the order.
   */
  tokenId: string;

  signalId: string | null;
  strategyVersionId: string | null;

  /**
   * Venue lifecycle status.
   */
  status: OrderStatus | string;

  /**
   * Exchange-facing order side only.
   * BUY means acquire inventory of tokenId.
   * SELL means dispose of inventory of tokenId.
   *
   * This is NOT the same thing as market thesis.
   * Example:
   * - Buying the NO token => side=BUY, outcome=NO
   * - Selling held YES inventory => side=SELL, outcome=YES
   */
  side: VenueSide;

  /**
   * Explicit token thesis.
   */
  outcome: Outcome | null;

  /**
   * Strategy / portfolio intent for this order.
   * ENTER  = open/add inventory on tokenId
   * REDUCE = partially reduce inventory on tokenId
   * EXIT   = fully close inventory on tokenId
   * FLIP   = transition from one side to the opposite side;
   *          usually should be decomposed into multiple orders upstream
   */
  intent: TradeIntent | null;

  /**
   * Inventory meaning of the order.
   * INCREASE = adds token inventory
   * DECREASE = reduces token inventory
   * NEUTRAL  = transitional / bookkeeping / unsupported direct semantics
   */
  inventoryEffect: InventoryEffect | null;

  price: number;
  size: number;
  expectedEv: number | null;

  postedAt: string | null;
  acknowledgedAt: string | null;
  canceledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function isBuyOrder(order: Pick<Order, 'side'>): boolean {
  return order.side === 'BUY';
}

export function isSellOrder(order: Pick<Order, 'side'>): boolean {
  return order.side === 'SELL';
}

export function increasesInventory(
  order: Pick<Order, 'inventoryEffect' | 'side'>,
): boolean {
  if (order.inventoryEffect) {
    return order.inventoryEffect === 'INCREASE';
  }
  return order.side === 'BUY';
}

export function decreasesInventory(
  order: Pick<Order, 'inventoryEffect' | 'side'>,
): boolean {
  if (order.inventoryEffect) {
    return order.inventoryEffect === 'DECREASE';
  }
  return order.side === 'SELL';
}