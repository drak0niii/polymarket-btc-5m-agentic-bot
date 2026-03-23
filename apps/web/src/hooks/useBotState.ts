import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../lib/api';

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
  lastTransitionAt: string | null;
  lastTransitionReason: string | null;
  readiness: {
    ready: boolean;
    checks: {
      env: boolean;
      signing: boolean;
      credentials: boolean;
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
  lastTransitionAt: null,
  lastTransitionReason: null,
  readiness: {
    ready: false,
    checks: {
      env: false,
      signing: false,
      credentials: false,
      riskConfig: false,
    },
  },
};

export function useBotState() {
  const [botState, setBotState] = useState<BotStateResponse>(defaultState);

  const refresh = useCallback(async () => {
    try {
      const nextState = await apiClient.getBotState();
      setBotState(nextState);
    } catch {
      // noop
    }
  }, []);

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
    refresh,
  };
}
