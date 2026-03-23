export interface ExecutionDiagnostic {
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

export interface EvDriftDiagnostic {
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

export interface RegimeDiagnostic {
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