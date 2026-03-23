export type Outcome = 'YES' | 'NO';

export type VenueSide = 'BUY' | 'SELL';

export type PositionStatus = 'open' | 'closed';

export interface PortfolioTokenExposure {
  /**
   * Stable identity of this token exposure inside a market.
   */
  marketId: string;
  tokenId: string;

  /**
   * Explicit token thesis.
   */
  outcome: Outcome | null;

  /**
   * Retained for compatibility with venue-facing semantics.
   * BUY usually means net long token inventory.
   * SELL can represent a decreasing / legacy net short-like ledger state,
   * depending on how historical fills were recorded.
   */
  side: VenueSide;

  status: PositionStatus | string;

  /**
   * Current inventory quantity for this token.
   */
  quantity: number;

  /**
   * Average entry price for currently held inventory.
   */
  entryPrice: number;

  /**
   * Current mark used for unrealized PnL and exposure calculations.
   */
  markPrice: number | null;

  /**
   * Notional exposure attributed to this token ledger.
   * Usually abs(quantity) * entryPrice or another normalized exposure basis,
   * depending on portfolio accounting policy.
   */
  openExposure: number;

  realizedPnl: number | null;
  unrealizedPnl: number | null;
}

export interface PortfolioMarketExposure {
  /**
   * Market-level rollup built from token-level exposures.
   * A market can contain both YES and NO token records.
   */
  marketId: string;

  totalOpenExposure: number;
  realizedPnl: number | null;
  unrealizedPnl: number | null;

  yesExposure: number;
  noExposure: number;

  tokenExposures: PortfolioTokenExposure[];
}

export interface PortfolioSnapshot {
  id: string;

  /**
   * Total capital base used by the strategy.
   */
  bankroll: number;

  /**
   * Capital still available for new risk after open exposure and working-order
   * reservations are considered.
   */
  availableCapital: number;

  /**
   * Aggregate open exposure across all token ledgers.
   */
  openExposure: number;

  realizedPnlDay: number;
  unrealizedPnl: number;
  consecutiveLosses: number;
  capturedAt: string;
  createdAt: string;

  /**
   * Token-aware inventory detail.
   * This is the authoritative exposure layer for safe autonomous trading.
   */
  tokenExposures?: PortfolioTokenExposure[];

  /**
   * Market-level summaries derived from tokenExposures.
   * Useful for reporting, dashboards, and market-scoped controls.
   */
  marketExposures?: PortfolioMarketExposure[];
}

export function getTokenExposureIdentity(
  exposure: Pick<PortfolioTokenExposure, 'marketId' | 'tokenId'>,
): string {
  return `${exposure.marketId}::${exposure.tokenId}`;
}

export function getTotalTokenExposure(
  exposures: PortfolioTokenExposure[],
): number {
  return exposures.reduce((sum, exposure) => sum + exposure.openExposure, 0);
}

export function getOutcomeExposure(
  exposures: PortfolioTokenExposure[],
  outcome: Outcome,
): number {
  return exposures
    .filter((exposure) => exposure.outcome === outcome)
    .reduce((sum, exposure) => sum + exposure.openExposure, 0);
}

export function groupPortfolioByMarket(
  exposures: PortfolioTokenExposure[],
): PortfolioMarketExposure[] {
  const byMarket = new Map<string, PortfolioTokenExposure[]>();

  for (const exposure of exposures) {
    const bucket = byMarket.get(exposure.marketId) ?? [];
    bucket.push(exposure);
    byMarket.set(exposure.marketId, bucket);
  }

  return [...byMarket.entries()].map(([marketId, tokenExposures]) => {
    const totalOpenExposure = tokenExposures.reduce(
      (sum, exposure) => sum + exposure.openExposure,
      0,
    );

    const realizedPnl = tokenExposures.reduce(
      (sum, exposure) => sum + (exposure.realizedPnl ?? 0),
      0,
    );

    const unrealizedPnl = tokenExposures.reduce(
      (sum, exposure) => sum + (exposure.unrealizedPnl ?? 0),
      0,
    );

    const yesExposure = tokenExposures
      .filter((exposure) => exposure.outcome === 'YES')
      .reduce((sum, exposure) => sum + exposure.openExposure, 0);

    const noExposure = tokenExposures
      .filter((exposure) => exposure.outcome === 'NO')
      .reduce((sum, exposure) => sum + exposure.openExposure, 0);

    return {
      marketId,
      totalOpenExposure,
      realizedPnl,
      unrealizedPnl,
      yesExposure,
      noExposure,
      tokenExposures,
    };
  });
}