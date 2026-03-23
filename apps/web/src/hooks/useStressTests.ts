import { useEffect, useState } from 'react';
import { apiClient } from '../lib/api';

interface StressTestRun {
  id: string;
  family: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  summary: unknown;
  verdict: string | null;
  createdAt: string;
}

export function useStressTests() {
  const [stressTests, setStressTests] = useState<StressTestRun[]>([]);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const nextRuns = await apiClient.getStressTestRuns();
        if (!active) return;
        setStressTests(nextRuns);
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
    stressTests,
  };
}