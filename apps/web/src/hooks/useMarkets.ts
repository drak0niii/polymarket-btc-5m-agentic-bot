import { useEffect, useState } from 'react';
import { apiClient } from '../lib/api';

interface MarketItem {
  id: string;
  slug: string;
  title: string;
  status: string;
  tokenIdYes: string | null;
  tokenIdNo: string | null;
  resolutionSource: string | null;
  createdAt: string;
  updatedAt: string;
}

export function useMarkets() {
  const [markets, setMarkets] = useState<MarketItem[]>([]);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const nextMarkets = await apiClient.getMarkets();
        if (!active) return;
        setMarkets(nextMarkets);
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
    markets,
  };
}