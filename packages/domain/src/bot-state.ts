import type { TradingOperatingMode } from './sentinel';

export type BotRuntimeState =
  | 'bootstrapping'
  | 'degraded'
  | 'reconciliation_only'
  | 'cancel_only'
  | 'halted_hard'
  | 'stopped'
  | 'running';

export interface BotStateSnapshot {
  state: BotRuntimeState;
  operatingMode: TradingOperatingMode;
  sentinelEnabled: boolean;
  recommendedLiveEnable: boolean;
  lastTransitionAt: string | null;
  lastTransitionReason: string | null;
  readiness: {
    ready: boolean;
    checks: {
      startupRunbook: boolean;
      authenticatedVenueSmoke: boolean;
      recovery: boolean;
      secrets: boolean;
    };
  };
}
