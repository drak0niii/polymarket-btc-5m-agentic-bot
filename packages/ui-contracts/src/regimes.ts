export interface RegimeStateContract {
  label:
    | 'trend_burst'
    | 'low_vol_chop'
    | 'reversal_shock'
    | 'spread_blowout'
    | 'correlated_rush';
  confidence: number;
  observedAt: string;
}

export interface RegimeBreakdownContract {
  label: RegimeStateContract['label'];
  tradeCount: number;
  winRate: number | null;
  expectedEvAvg: number | null;
  realizedEvAvg: number | null;
  fillRate: number | null;
}