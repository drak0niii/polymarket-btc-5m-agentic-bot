import { useEffect, useState } from 'react';
import { apiClient } from '../lib/api';

interface PortfolioSnapshot {
  id: string;
  bankroll: number;
  availableCapital: number;
  openExposure: number;
  realizedPnlDay: number;
  unrealizedPnl: number;
  consecutiveLosses: number;
  capturedAt: string;
  createdAt: string;
}

export function usePortfolio() {
  const [portfolio, setPortfolio] = useState<PortfolioSnapshot | null>(null);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const nextPortfolio = await apiClient.getPortfolio();
        if (!active) return;
        setPortfolio(nextPortfolio);
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
    portfolio,
  };
}