import { useEffect, useState } from 'react';
import { apiClient } from '../lib/api';

interface ActivityItem {
  id: string;
  marketId: string | null;
  signalId: string | null;
  orderId: string | null;
  eventType: string;
  message: string;
  metadata: unknown;
  createdAt: string;
}

export function useActivity() {
  const [activity, setActivity] = useState<ActivityItem[]>([]);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const nextActivity = await apiClient.getAuditEvents();
        if (!active) return;
        setActivity(nextActivity);
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
    activity,
  };
}