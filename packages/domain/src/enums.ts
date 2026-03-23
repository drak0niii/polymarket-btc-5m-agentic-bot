export type OrderStatus =
  | 'created'
  | 'posted'
  | 'acknowledged'
  | 'partially_filled'
  | 'filled'
  | 'canceled'
  | 'rejected';

export type SignalStatus =
  | 'created'
  | 'approved'
  | 'rejected'
  | 'expired';

export type PositionStatus =
  | 'open'
  | 'closed';

export type StressTestStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed';

export type StressTestVerdict =
  | 'passed'
  | 'degraded'
  | 'failed';

export type RegimeLabel =
  | 'trend_burst'
  | 'low_vol_chop'
  | 'reversal_shock'
  | 'spread_blowout'
  | 'correlated_rush';