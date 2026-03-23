export interface ExecutionDiagnosticsInput {
  orderId: string | null;
  strategyVersionId: string | null;
  expectedEv: number | null;
  realizedEv: number | null;
  expectedFee: number | null;
  realizedFee: number | null;
  expectedSlippage: number | null;
  realizedSlippage: number | null;
  edgeAtSignal: number | null;
  edgeAtFill: number | null;
  fillRate: number | null;
  staleOrder: boolean;
  regime: string | null;
}

export interface ExecutionDiagnosticsSnapshot {
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
}

export class ExecutionDiagnostics {
  create(input: ExecutionDiagnosticsInput): ExecutionDiagnosticsSnapshot {
    return {
      orderId: input.orderId,
      strategyVersionId: input.strategyVersionId,
      expectedEv: input.expectedEv,
      realizedEv: input.realizedEv,
      evDrift:
        input.expectedEv !== null && input.realizedEv !== null
          ? input.realizedEv - input.expectedEv
          : null,
      expectedFee: input.expectedFee,
      realizedFee: input.realizedFee,
      expectedSlippage: input.expectedSlippage,
      realizedSlippage: input.realizedSlippage,
      edgeAtSignal: input.edgeAtSignal,
      edgeAtFill: input.edgeAtFill,
      fillRate: input.fillRate,
      staleOrder: input.staleOrder,
      regime: input.regime,
      capturedAt: new Date().toISOString(),
    };
  }
}