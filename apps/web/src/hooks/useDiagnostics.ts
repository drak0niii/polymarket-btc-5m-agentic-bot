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

interface EvDriftDiagnostic {
  id: string;
  strategyVersionId: string | null;
  windowLabel: string;
  expectedEvSum: number;
  realizedEvSum: number;
  evDrift: number;
  realizedVsExpected: number;
  capturedAt: string;
  createdAt: string;
}

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

export function useDiagnostics() {
  const [diagnostics, setDiagnostics] = useState<{
    execution: ExecutionDiagnostic[];
    evDrift: EvDriftDiagnostic[];
    regimes: RegimeDiagnostic[];
    stressTests: StressTestRun[];
  }>({
    execution: [],
    evDrift: [],
    regimes: [],
    stressTests: [],
  });

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const [execution, evDrift, regimes, stressTests] = await Promise.all([
          apiClient.getExecutionDiagnostics(),
          apiClient.getEvDriftDiagnostics(),
          apiClient.getRegimeDiagnostics(),
          apiClient.getStressTestRuns(),
        ]);

        if (!active) return;

        setDiagnostics({
          execution,
          evDrift,
          regimes,
          stressTests,
        });
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
    diagnostics,
  };
}