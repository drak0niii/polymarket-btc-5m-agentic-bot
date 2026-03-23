export interface PredictionTarget {
  kind:
    | 'net_executable_ev'
    | 'profitable_exit_probability'
    | 'setup_conditioned_edge';
  description: string;
  targetVariable: string;
}

export interface ForecastHorizon {
  entryWindowSeconds: number;
  holdWindowSeconds: number;
  expiryBufferSeconds: number;
}

export interface ExecutableBenchmark {
  style: 'taker' | 'maker' | 'hybrid';
  description: string;
  includesFees: boolean;
  includesSlippage: boolean;
  includesTimeoutRisk: boolean;
  includesStaleSignalRisk: boolean;
  includesInventoryConstraints: boolean;
}

export interface AdmissionThresholdPolicy {
  minimumNetEdge: number;
  minimumConfidence: number;
  minimumRobustnessScore: number;
  failClosedOnMissingInputs: boolean;
  rewardsIncludedByDefault: boolean;
}

export interface EdgeDefinition {
  version: string;
  predictiveTarget: PredictionTarget;
  forecastHorizon: ForecastHorizon;
  executableBenchmark: ExecutableBenchmark;
  admissionThresholdPolicy: AdmissionThresholdPolicy;
}

export interface CanonicalEdgeComputation {
  definitionVersion: string;
  targetProbability: number;
  marketImpliedProbability: number;
  rawModelEdge: number;
  executableNetEdge: number;
  confidence: number;
  computedAt: string;
}

export interface EdgeSnapshot {
  marketId: string;
  signalId: string | null;
  posteriorProbability: number;
  marketImpliedProbability: number;
  edge: number;
  definitionVersion?: string;
  capturedAt: string;
}
