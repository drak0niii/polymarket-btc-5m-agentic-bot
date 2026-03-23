export class ExecutionDiagnosticResponseDto {
  id!: string;
  orderId!: string | null;
  strategyVersionId!: string | null;
  expectedEv!: number | null;
  realizedEv!: number | null;
  evDrift!: number | null;
  expectedFee!: number | null;
  realizedFee!: number | null;
  expectedSlippage!: number | null;
  realizedSlippage!: number | null;
  edgeAtSignal!: number | null;
  edgeAtFill!: number | null;
  fillRate!: number | null;
  staleOrder!: boolean;
  regime!: string | null;
  capturedAt!: Date;
  createdAt!: Date;
}