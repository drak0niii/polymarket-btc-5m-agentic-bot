export interface SignalContract {
  id: string;
  marketId: string;
  strategyVersionId: string | null;
  side: string;
  priorProbability: number;
  posteriorProbability: number;
  marketImpliedProb: number;
  edge: number;
  expectedEv: number;
  regime: string | null;
  status: string;
  observedAt: string;
  createdAt: string;
}

export interface SignalDecisionContract {
  id: string;
  signalId: string;
  verdict: string;
  reasonCode: string;
  reasonMessage: string | null;
  expectedEv: number | null;
  positionSize: number | null;
  decisionAt: string;
  createdAt: string;
}