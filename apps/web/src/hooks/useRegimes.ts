import { useEffect, useState } from 'react';
import { apiClient } from '../lib/api';

interface RegimeDiagnostic {
  id: string;
  strategyVersionId: string | null;
  regime: string;
  tradeCount: number;
  winRate: number | null;
  expectedEvAvg: number | null;
  realizedEvAvg: number | null;
  fillRate: number | null;
  capturedAt: string;
  createdAt: string;
}

export function useRegimes() {
  const [regimes, setRegimes] = useState<RegimeDiagnostic[]>([]);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const nextRegimes = await apiClient.getRegimeDiagnostics();
        if (!active) return;
        setRegimes(nextRegimes);
      } catch {
        // noop
      }
    };

    void load();

    const interval = window.setInterval(() => {
      void load();
    }, 5000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  return {
    regimes,
  };
}