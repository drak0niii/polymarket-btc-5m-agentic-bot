export type DecisionLogCategory =
  | 'edge'
  | 'research'
  | 'admission'
  | 'post_trade'
  | 'promotion'
  | 'readiness'
  | 'replay'
  | 'chaos'
  | 'deployment_tier'
  | 'capital_ramp';

export interface AuditDecisionLog {
  category: DecisionLogCategory;
  eventType: string;
  summary: string;
  signalId?: string | null;
  marketId?: string | null;
  orderId?: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}
