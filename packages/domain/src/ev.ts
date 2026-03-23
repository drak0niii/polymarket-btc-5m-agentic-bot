export interface EvSnapshot {
  marketId: string;
  signalId: string | null;
  expectedEv: number;
  expectedFee: number | null;
  expectedSlippage: number | null;
  expectedImpact: number | null;
  capturedAt: string;
}