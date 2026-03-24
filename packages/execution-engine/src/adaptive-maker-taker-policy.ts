import type {
  ExecutionPolicyMode,
  ExecutionPolicyVersion,
} from '@polymarket-btc-5m-agentic-bot/domain';

export interface AdaptiveExecutionPolicyInput {
  activePolicyVersion: ExecutionPolicyVersion | null;
  marketContext: {
    strategyVariantId: string;
    regime: string | null;
    action: 'ENTER' | 'REDUCE' | 'EXIT';
    urgency: 'low' | 'medium' | 'high';
    spread: number | null;
    topLevelDepth: number;
  };
}

export interface AdaptiveExecutionPolicyDecision {
  mode: ExecutionPolicyMode;
  route: 'maker' | 'taker';
  executionStyle: 'rest' | 'cross';
  preferResting: boolean;
  policyVersionId: string | null;
  rationale: string[];
}

export class AdaptiveMakerTakerPolicy {
  decide(input: AdaptiveExecutionPolicyInput): AdaptiveExecutionPolicyDecision {
    const policy = input.activePolicyVersion;
    const spread = input.marketContext.spread ?? Number.POSITIVE_INFINITY;
    const shallowBook = input.marketContext.topLevelDepth < 10;
    const highUrgency = input.marketContext.urgency === 'high';
    const delayedFills = (policy?.expectedFillDelayMs ?? 0) >= 20_000;
    const elevatedAdverseSelection = (policy?.adverseSelectionScore ?? 0) >= 0.45;
    const stressedSlippage = (policy?.expectedSlippage ?? 0) >= 0.01;
    const cancellationFragile = (policy?.cancelSuccessRate ?? 1) < 0.65;

    if (!policy) {
      return {
        mode: 'balanced',
        route: highUrgency ? 'taker' : 'maker',
        executionStyle: highUrgency ? 'cross' : 'rest',
        preferResting: !highUrgency,
        policyVersionId: null,
        rationale: ['no_execution_policy_version_fallback'],
      };
    }

    if (
      policy.mode === 'taker_preferred' ||
      elevatedAdverseSelection ||
      (delayedFills && input.marketContext.action === 'ENTER') ||
      cancellationFragile
    ) {
      return {
        mode: policy.mode,
        route: 'taker',
        executionStyle: 'cross',
        preferResting: false,
        policyVersionId: policy.versionId,
        rationale: [
          policy.mode === 'taker_preferred'
            ? 'learned_taker_preference_active'
            : 'learned_execution_risk_overrides_resting',
          ...(delayedFills ? ['learned_fill_delay_excessive'] : []),
          ...(elevatedAdverseSelection ? ['learned_adverse_selection_elevated'] : []),
          ...(cancellationFragile ? ['cancel_success_fragile'] : []),
          ...policy.rationale,
        ],
      };
    }

    if (highUrgency || shallowBook || spread > 0.04 || stressedSlippage) {
      return {
        mode: policy.mode,
        route: 'taker',
        executionStyle: 'cross',
        preferResting: false,
        policyVersionId: policy.versionId,
        rationale: [
          'market_context_overrides_resting_preference',
          ...(stressedSlippage ? ['learned_slippage_stressed'] : []),
          ...policy.rationale,
        ],
      };
    }

    if (policy.mode === 'maker_preferred') {
      return {
        mode: policy.mode,
        route: 'maker',
        executionStyle: 'rest',
        preferResting: true,
        policyVersionId: policy.versionId,
        rationale: [
          'learned_maker_preference_active',
          ...policy.rationale,
        ],
      };
    }

    return {
      mode: policy.mode,
      route: input.marketContext.action === 'ENTER' ? 'maker' : 'taker',
      executionStyle: input.marketContext.action === 'ENTER' ? 'rest' : 'cross',
      preferResting: input.marketContext.action === 'ENTER',
      policyVersionId: policy.versionId,
      rationale: [
        'balanced_execution_policy_uses_market_context',
        ...(delayedFills ? ['balanced_policy_fill_delay_watch'] : []),
        ...policy.rationale,
      ],
    };
  }
}
