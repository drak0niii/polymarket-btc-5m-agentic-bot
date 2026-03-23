export type AccountFreshnessState = 'healthy' | 'degraded' | 'stale';

export interface AccountStateReservation {
  orderId: string;
  marketId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  remainingSize: number;
  reservedNotional: number;
}

export interface AccountStateInventory {
  marketId: string | null;
  tokenId: string;
  outcome: 'YES' | 'NO' | 'UNKNOWN';
  quantity: number;
  availableQuantity: number;
  reservedQuantity: number;
  allowance: number;
  markPrice: number | null;
  markedValue: number;
}

export interface AccountStateConcentration {
  largestMarketId: string | null;
  largestMarketExposure: number;
  largestMarketRatio: number;
  largestTokenId: string | null;
  largestTokenExposure: number;
  largestTokenRatio: number;
}

export interface AccountStateFreshness {
  state: AccountFreshnessState;
  allowNewEntries: boolean;
  allowPositionManagement: boolean;
  reasonCodes: string[];
  externalSnapshotHealthy: boolean;
  marketStreamHealthy: boolean | null;
  userStreamHealthy: boolean | null;
}

export interface CanonicalAccountState {
  source: 'canonical_account_state_v1';
  capturedAt: string;
  portfolioSnapshotId: string | null;
  externalSnapshotId: string | null;
  bankroll: number;
  grossCash: number;
  availableCash: number;
  reservedCash: number;
  unresolvedBuyReservation: number;
  workingBuyNotional: number;
  workingSellQuantity: number;
  deployableRiskNow: number;
  openExposure: number;
  openOrderExposure: number;
  realizedPnlDay: number;
  realizedPnlHour: number;
  unrealizedPnl: number;
  feesPaidDay: number;
  rewardsPaidDay: number;
  consecutiveLosses: number;
  inventories: AccountStateInventory[];
  reservations: AccountStateReservation[];
  concentration: AccountStateConcentration;
  freshness: AccountStateFreshness;
}
