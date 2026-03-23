import { SafetyState } from './safety-state';

export type KillSwitchFamily =
  | 'intraday_drawdown'
  | 'hourly_drawdown'
  | 'consecutive_losses'
  | 'exposure_concentration'
  | 'execution_quality_drift'
  | 'venue_instability'
  | 'data_freshness';

export interface KillSwitchTrigger {
  family: KillSwitchFamily | string;
  reasonCode: string;
  severity: number;
  recommendedState: SafetyState;
  blockNewEntries: boolean;
  forceReduction: boolean;
  evidence: Record<string, number | string | boolean | null>;
}
