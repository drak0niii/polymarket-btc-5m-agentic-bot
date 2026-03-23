export interface ExecutionQualitySnapshot {
  orderId: string | null;
  signalId: string | null;
  edgeAtSignal: number | null;
  edgeAtFill: number | null;
  expectedEv: number | null;
  realizedEv: number | null;
  expectedFee: number | null;
  realizedFee: number | null;
  expectedSlippage: number | null;
  realizedSlippage: number | null;
  fillDelayMs: number | null;
  staleOrder: boolean;
  fillRate: number | null;
  capturedAt: string;
}