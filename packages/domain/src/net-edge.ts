import type { HealthLabel } from './learning-state';

export type NetEdgeVenueUncertaintyLabel = 'healthy' | 'degraded' | 'unsafe';

export interface NetEdgeInput {
  grossForecastEdge: number;
  expectedEv: number | null;
  feeRate: number;
  spread: number | null;
  signalAgeMs: number;
  halfLifeMultiplier: number;
  topLevelDepth: number | null;
  estimatedOrderSizeUnits: number | null;
  executionStyle: 'maker' | 'taker' | 'hybrid';
  calibrationHealth: HealthLabel | null;
  calibrationShrinkageFactor: number | null;
  calibrationSampleCount: number | null;
  regimeHealth: HealthLabel | null;
  venueUncertaintyLabel: NetEdgeVenueUncertaintyLabel | null;
  venueMode: string | null;
}

export interface CostEstimateBreakdown {
  feeCost: number;
  slippageCost: number;
  adverseSelectionCost: number;
  venuePenalty: number;
  spreadComponent: number;
  liquidityComponent: number;
  totalCost: number;
}

export interface UncertaintyPenalty {
  calibrationPenalty: number;
  regimePenalty: number;
  freshnessPenalty: number;
  halfLifePenalty: number;
  totalPenalty: number;
  reasons: string[];
}

export interface NetEdgeBreakdown {
  grossForecastEdge: number;
  executionStyle: 'maker' | 'taker' | 'hybrid';
  costEstimate: CostEstimateBreakdown;
  uncertaintyPenalty: UncertaintyPenalty;
  afterFeesEdge: number;
  afterSlippageEdge: number;
  afterAdverseSelectionEdge: number;
  afterUncertaintyEdge: number;
  finalNetEdge: number;
  missingInputs: string[];
  staleInputs: string[];
  paperEdgeBlocked: boolean;
  confidence: number;
  reasons: string[];
}

export interface NetEdgeDecision {
  recommendation: 'trade' | 'reject';
  reasonCodes: string[];
  breakdown: NetEdgeBreakdown;
}
