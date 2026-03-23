export interface StrategyVersion {
  id: string;
  name: string;
  isActive: boolean;
  priorModelConfig: Record<string, unknown>;
  posteriorConfig: Record<string, unknown>;
  filtersConfig: Record<string, unknown>;
  riskConfig: Record<string, unknown>;
  executionConfig: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}