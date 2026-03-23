import { useEffect, useState } from 'react';
import { apiClient } from '../lib/api';

interface OrderItem {
  id: string;
  marketId: string;
  signalId: string | null;
  strategyVersionId: string | null;
  status: string;
  side: string;
  price: number;
  size: number;
  expectedEv: number | null;
  postedAt: string | null;
  acknowledgedAt: string | null;
  canceledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function useOrders() {
  const [orders, setOrders] = useState<OrderItem[]>([]);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const nextOrders = await apiClient.getOrders();
        if (!active) return;
        setOrders(nextOrders);
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
    orders,
  };
}