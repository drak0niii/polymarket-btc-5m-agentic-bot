import { useEffect, useState } from 'react';
import { apiClient } from '../lib/api';

interface ExecutionDiagnostic {
  id: string;
  orderId: string | null;
  strategyVersionId: string | null;
  expectedEv: number | null;
  realizedEv: number | null;
  evDrift: number | null;
  expectedFee: number | null;
  realizedFee: number | null;
  expectedSlippage: number | null;
  realizedSlippage: number | null;
  edgeAtSignal: number | null;
  edgeAtFill: number | null;
  fillRate: number | null;
  staleOrder: boolean;
  regime: string | null;
  capturedAt: string;
  createdAt: string;
}

export function useExecutionQuality() {
  const [executionDiagnostics, setExecutionDiagnostics] = useState<
    ExecutionDiagnostic[]
  >([]);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const nextDiagnostics = await apiClient.getExecutionDiagnostics();
        if (!active) return;
        setExecutionDiagnostics(nextDiagnostics);
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
    executionDiagnostics,
  };
}