import { useCallback, useEffect, useState } from 'react';
import {
  apiClient,
  type SentinelStatusResponse,
  type TradingOperatingMode,
} from '../lib/api';

interface BotStateResponse {
  state:
    | 'bootstrapping'
    | 'running'
    | 'degraded'
    | 'reconciliation_only'
    | 'cancel_only'
    | 'halted_hard'
    | 'stopped';
  liveConfig: {
    maxOpenPositions: number;
    maxDailyLossPct: number;
    maxPerTradeRiskPct: number;
    maxKellyFraction: number;
    maxConsecutiveLosses: number;
    noTradeWindowSeconds: number;
    evaluationIntervalMs: number;
    orderReconcileIntervalMs: number;
    portfolioRefreshIntervalMs: number;
  };
  operatingMode: TradingOperatingMode;
  sentinelEnabled: boolean;
  recommendedLiveEnable: boolean;
  sentinelStatus: SentinelStatusResponse | null;
  lastTransitionAt: string | null;
  lastTransitionReason: string | null;
  readiness: {
    ready: boolean;
    checks: {
      env: boolean;
      signing: boolean;
      credentials: boolean;
      liveMode: boolean;
      riskConfig: boolean;
    };
  };
}

const defaultState: BotStateResponse = {
  state: 'stopped',
  liveConfig: {
    maxOpenPositions: 1,
    maxDailyLossPct: 5,
    maxPerTradeRiskPct: 1,
    maxKellyFraction: 0.05,
    maxConsecutiveLosses: 2,
    noTradeWindowSeconds: 30,
    evaluationIntervalMs: 1000,
    orderReconcileIntervalMs: 2000,
    portfolioRefreshIntervalMs: 5000,
  },
  operatingMode: 'live_trading',
  sentinelEnabled: false,
  recommendedLiveEnable: false,
  sentinelStatus: null,
  lastTransitionAt: null,
  lastTransitionReason: null,
  readiness: {
    ready: false,
    checks: {
      env: false,
      signing: false,
      credentials: false,
      liveMode: false,
      riskConfig: false,
    },
  },
};

export function useBotState() {
  const [botState, setBotState] = useState<BotStateResponse>(defaultState);
  const [modeLoading, setModeLoading] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const nextState = await apiClient.getBotState();
      setBotState(nextState);
    } catch {
      // noop
    }
  }, []);

  const setOperatingMode = useCallback(
    async (operatingMode: TradingOperatingMode) => {
      setModeLoading(true);
      setModeError(null);
      try {
        await apiClient.setOperatingMode({
          operatingMode,
          requestedBy: 'web',
        });
        await refresh();
      } catch (error) {
        setModeError(error instanceof Error ? error.message : 'Failed to update mode.');
      } finally {
        setModeLoading(false);
      }
    },
    [refresh],
  );

  useEffect(() => {
    void refresh();

    const interval = window.setInterval(() => {
      void refresh();
    }, 5000);

    return () => {
      window.clearInterval(interval);
    };
  }, [refresh]);

  return {
    botState,
    operatingMode: botState.operatingMode,
    sentinelStatus: botState.sentinelStatus,
    setOperatingMode,
    modeLoading,
    modeError,
    refresh,
  };
}
