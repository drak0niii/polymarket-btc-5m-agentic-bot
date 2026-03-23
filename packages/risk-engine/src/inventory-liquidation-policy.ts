export type LiquidationTrigger =
  | 'near_expiry'
  | 'btc_reference_stale'
  | 'market_closed_only'
  | 'user_stream_lost'
  | 'portfolio_truth_divergence';

export type LiquidationMode = 'monitor' | 'soft_reduce' | 'hard_flatten';

export type LiquidationRuntimeTransition =
  | 'degraded'
  | 'reconciliation_only'
  | 'cancel_only'
  | 'halted_hard'
  | null;

export interface LiquidationTriggerState {
  trigger: LiquidationTrigger;
  active: boolean;
  severity: 'low' | 'medium' | 'high';
  reasonCode: string;
  affectedMarketIds?: string[];
  evidence?: Record<string, unknown>;
}

export interface LiquidationPlan {
  active: boolean;
  mode: LiquidationMode;
  transitionTo: LiquidationRuntimeTransition;
  blockNewEntries: boolean;
  forceCancelAll: boolean;
  reasonCodes: string[];
  affectedMarketIds: string[];
  evidence: Record<string, unknown>;
}

export class InventoryLiquidationPolicy {
  evaluate(triggers: LiquidationTriggerState[]): LiquidationPlan {
    const active = triggers.filter((trigger) => trigger.active);
    if (active.length === 0) {
      return {
        active: false,
        mode: 'monitor',
        transitionTo: null,
        blockNewEntries: false,
        forceCancelAll: false,
        reasonCodes: [],
        affectedMarketIds: [],
        evidence: {},
      };
    }

    const affectedMarketIds = [...new Set(active.flatMap((trigger) => trigger.affectedMarketIds ?? []))];
    const highSeverity = active.some((trigger) => trigger.severity === 'high');
    const hasUserStreamLoss = active.some((trigger) => trigger.trigger === 'user_stream_lost');
    const hasClosedOnly = active.some((trigger) => trigger.trigger === 'market_closed_only');
    const hasDivergence = active.some(
      (trigger) => trigger.trigger === 'portfolio_truth_divergence',
    );

    if (highSeverity || hasClosedOnly || hasDivergence || hasUserStreamLoss) {
      return {
        active: true,
        mode: 'hard_flatten',
        transitionTo: hasUserStreamLoss ? 'reconciliation_only' : 'cancel_only',
        blockNewEntries: true,
        forceCancelAll: true,
        reasonCodes: active.map((trigger) => trigger.reasonCode),
        affectedMarketIds,
        evidence: Object.fromEntries(
          active.map((trigger) => [trigger.reasonCode, trigger.evidence ?? {}]),
        ),
      };
    }

    return {
      active: true,
      mode: 'soft_reduce',
      transitionTo: 'degraded',
      blockNewEntries: true,
      forceCancelAll: false,
      reasonCodes: active.map((trigger) => trigger.reasonCode),
      affectedMarketIds,
      evidence: Object.fromEntries(
        active.map((trigger) => [trigger.reasonCode, trigger.evidence ?? {}]),
      ),
    };
  }
}
