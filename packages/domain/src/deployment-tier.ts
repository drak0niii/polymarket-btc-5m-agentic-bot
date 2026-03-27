export type DeploymentTier =
  | 'research'
  | 'paper'
  | 'canary'
  | 'cautious_live'
  | 'scaled_live';

export interface DeploymentTierVerdict {
  tier: DeploymentTier;
  allowLiveOrders: boolean;
  allowNewEntries: boolean;
  maxOpenPositionsMultiplier: number;
  perTradeRiskMultiplier: number;
  requiresRobustnessEvidence: boolean;
  requiresAuditability: boolean;
  reasons: string[];
}

export interface CapitalRampVerdict {
  stage: 'frozen' | 'canary' | 'limited' | 'scaled';
  allowScaling: boolean;
  capitalMultiplier: number;
  reasons: string[];
  currentTrustLevel?: number | null;
  evidenceThresholdsMet?: string[];
  evidenceThresholdsUnmet?: string[];
  promotionAllowed?: boolean;
}
