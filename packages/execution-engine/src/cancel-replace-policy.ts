export interface CancelReplacePolicyInput {
  action: 'ENTER' | 'REDUCE' | 'EXIT';
  route: 'maker' | 'taker';
  signalAgeMs: number;
  maxSignalAgeMs: number;
  ageMs: number;
  waitingBeforeReplaceMs: number;
  maxRestingAgeMs: number;
  repricesUsed: number;
  maxRepricesPerSignal: number;
  fillProbability: number;
  minimumFillProbability: number;
  priceDriftBps: number;
  adverseMoveBps: number;
  maxAllowedPriceDriftBps: number;
  maxAllowedAdverseMoveBps: number;
  scoringActive?: boolean | null;
}

export interface CancelReplacePolicyResult {
  action: 'keep' | 'cancel' | 'replace';
  lifecycleState:
    | 'new'
    | 'resting'
    | 'waiting'
    | 'eligible_for_replace'
    | 'cancel_pending'
    | 'repost_pending'
    | 'completed'
    | 'abandoned';
  reasonCode: string;
  reasonMessage: string | null;
}

export class CancelReplacePolicy {
  evaluate(
    input: CancelReplacePolicyInput,
  ): CancelReplacePolicyResult {
    if (input.route !== 'maker') {
      return {
        action: 'cancel',
        lifecycleState: 'abandoned',
        reasonCode: 'unexpected_resting_taker_order',
        reasonMessage:
          'A taker-style order remained open unexpectedly, so execution policy abandons and cancels it.',
      };
    }

    if (input.signalAgeMs >= input.maxSignalAgeMs) {
      return {
        action: 'cancel',
        lifecycleState: 'abandoned',
        reasonCode: 'signal_stale_for_replace',
        reasonMessage:
          'Signal has exceeded the maximum allowed chase window, so the resting order is abandoned.',
      };
    }

    if (
      input.action === 'ENTER' &&
      Math.abs(input.adverseMoveBps) > input.maxAllowedAdverseMoveBps
    ) {
      return {
        action: 'cancel',
        lifecycleState: 'abandoned',
        reasonCode: 'no_chase_after_adverse_move',
        reasonMessage:
          'Entry repricing is abandoned because the market moved adversely beyond the allowed chase threshold.',
      };
    }

    if (input.repricesUsed >= input.maxRepricesPerSignal) {
      return {
        action: 'cancel',
        lifecycleState: 'abandoned',
        reasonCode: 'reprice_budget_exhausted',
        reasonMessage:
          'Execution policy exhausted the maximum reprices allowed for this signal.',
      };
    }

    if (input.ageMs >= input.maxRestingAgeMs) {
      return {
        action: 'cancel',
        lifecycleState: 'abandoned',
        reasonCode: 'resting_order_stale',
        reasonMessage:
          'Resting order exceeded the maximum passive waiting budget and is being abandoned.',
      };
    }

    const effectiveWaitingBeforeReplaceMs =
      input.scoringActive === true
        ? Math.round(input.waitingBeforeReplaceMs * 1.5)
        : input.waitingBeforeReplaceMs;

    if (input.ageMs < effectiveWaitingBeforeReplaceMs) {
      return {
        action: 'keep',
        lifecycleState: input.ageMs <= 1_000 ? 'new' : 'waiting',
        reasonCode: 'waiting_before_replace_window',
        reasonMessage:
          'Resting order remains inside its deterministic waiting window before replace is considered.',
      };
    }

    if (input.fillProbability < input.minimumFillProbability) {
      return {
        action: 'replace',
        lifecycleState: 'eligible_for_replace',
        reasonCode: 'fill_probability_too_low',
        reasonMessage: `Fill probability ${input.fillProbability} is below minimum ${input.minimumFillProbability}.`,
      };
    }

    if (Math.abs(input.priceDriftBps) > input.maxAllowedPriceDriftBps) {
      return {
        action: 'replace',
        lifecycleState: 'eligible_for_replace',
        reasonCode: 'price_drift_too_high',
        reasonMessage: `Price drift ${input.priceDriftBps}bps exceeds maximum ${input.maxAllowedPriceDriftBps}bps.`,
      };
    }

    return {
      action: 'keep',
      lifecycleState: 'resting',
      reasonCode: 'keep_order',
      reasonMessage: null,
    };
  }
}
