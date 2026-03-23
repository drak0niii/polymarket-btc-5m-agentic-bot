import { useEffect, useState } from 'react';
import { apiClient } from '../lib/api';

interface SignalItem {
  id: string;
  marketId: string;
  strategyVersionId: string | null;
  side: string;
  priorProbability: number;
  posteriorProbability: number;
  marketImpliedProb: number;
  edge: number;
  expectedEv: number;
  regime: string | null;
  status: string;
  observedAt: string;
  createdAt: string;
}

export function useSignals() {
  const [signals, setSignals] = useState<SignalItem[]>([]);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const nextSignals = await apiClient.getSignals();
        if (!active) return;
        setSignals(nextSignals);
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
    signals,
  };
}