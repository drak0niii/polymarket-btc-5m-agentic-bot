import { KillSwitchTrigger } from './kill-switch';
import { LossAttributionSummary } from './loss-attribution';
import {
  SafetyState,
  SafetyStateControls,
  compareSafetyStateSeverity,
  controlsForSafetyState,
  maxSafetyState,
} from './safety-state';

export interface SafetyStateMachineInput {
  currentState: SafetyState | null;
  currentStateEnteredAt?: string | null;
  dailyLossRatio: number;
  consecutiveLosses: number;
  maxConsecutiveLosses: number;
  killSwitchTriggers: KillSwitchTrigger[];
  lossAttributionSummary: LossAttributionSummary | null;
  now?: string;
}

export interface SafetyStateMachineResult extends SafetyStateControls {
  previousState: SafetyState;
  changed: boolean;
  reasonCodes: string[];
  evidence: Record<string, unknown>;
  enteredAt: string;
}

export class SafetyStateMachine {
  evaluate(input: SafetyStateMachineInput): SafetyStateMachineResult {
    const now = input.now ? new Date(input.now) : new Date();
    const previousState = input.currentState ?? 'normal';
    let recommendedState: SafetyState = 'normal';
    const reasonCodes: string[] = [];
    const evidence: Record<string, unknown> = {
      dailyLossRatio: input.dailyLossRatio,
      consecutiveLosses: input.consecutiveLosses,
      triggerCount: input.killSwitchTriggers.length,
      dominantLossCause: input.lossAttributionSummary?.dominantCause ?? null,
      dominantLossCauseConfidence:
        input.lossAttributionSummary?.dominantConfidence ?? 0,
    };

    if (input.dailyLossRatio >= 1.25) {
      recommendedState = maxSafetyState(recommendedState, 'halt');
      reasonCodes.push('daily_loss_ratio_critical');
    } else if (input.dailyLossRatio >= 1) {
      recommendedState = maxSafetyState(recommendedState, 'no_new_entries');
      reasonCodes.push('daily_loss_ratio_limit_reached');
    } else if (input.dailyLossRatio >= 0.75) {
      recommendedState = maxSafetyState(recommendedState, 'passive_only');
      reasonCodes.push('daily_loss_ratio_elevated');
    } else if (input.dailyLossRatio >= 0.5) {
      recommendedState = maxSafetyState(recommendedState, 'reduced_size');
      reasonCodes.push('daily_loss_ratio_warning');
    }

    if (input.consecutiveLosses >= input.maxConsecutiveLosses + 1) {
      recommendedState = maxSafetyState(recommendedState, 'halt');
      reasonCodes.push('consecutive_losses_critical');
    } else if (input.consecutiveLosses >= input.maxConsecutiveLosses) {
      recommendedState = maxSafetyState(recommendedState, 'no_new_entries');
      reasonCodes.push('consecutive_losses_limit_reached');
    } else if (input.consecutiveLosses >= Math.max(1, input.maxConsecutiveLosses - 1)) {
      recommendedState = maxSafetyState(recommendedState, 'reduced_frequency');
      reasonCodes.push('consecutive_losses_warning');
    }

    for (const trigger of input.killSwitchTriggers) {
      recommendedState = maxSafetyState(recommendedState, trigger.recommendedState);
      reasonCodes.push(trigger.reasonCode);
    }

    const dominantCause = input.lossAttributionSummary?.dominantCause ?? null;
    const dominantCauseConfidence =
      input.lossAttributionSummary?.dominantConfidence ?? 0;
    if (dominantCause && dominantCauseConfidence >= 0.55) {
      if (dominantCause === 'execution_error') {
        recommendedState = maxSafetyState(recommendedState, 'passive_only');
        reasonCodes.push('loss_attribution_execution_error');
      } else if (dominantCause === 'stale_data' || dominantCause === 'venue_rejection') {
        recommendedState = maxSafetyState(recommendedState, 'no_new_entries');
        reasonCodes.push(`loss_attribution_${dominantCause}`);
      } else if (dominantCause === 'liquidity_decay') {
        recommendedState = maxSafetyState(recommendedState, 'reduced_frequency');
        reasonCodes.push('loss_attribution_liquidity_decay');
      } else if (dominantCause === 'regime_mismatch' || dominantCause === 'model_error') {
        recommendedState = maxSafetyState(recommendedState, 'reduced_size');
        reasonCodes.push(`loss_attribution_${dominantCause}`);
      }
    }

    const enteredAt =
      compareSafetyStateSeverity(recommendedState, previousState) !== 0
        ? now.toISOString()
        : input.currentStateEnteredAt ?? now.toISOString();

    const cooldownElapsed = this.cooldownElapsed({
      state: previousState,
      currentStateEnteredAt: input.currentStateEnteredAt ?? null,
      now,
    });
    const nextState =
      compareSafetyStateSeverity(recommendedState, previousState) < 0 && !cooldownElapsed
        ? previousState
        : recommendedState;

    const controls = controlsForSafetyState(nextState);

    return {
      ...controls,
      previousState,
      changed: nextState !== previousState,
      reasonCodes: [...new Set(reasonCodes)],
      evidence,
      enteredAt:
        nextState === previousState
          ? input.currentStateEnteredAt ?? enteredAt
          : enteredAt,
    };
  }

  private cooldownElapsed(input: {
    state: SafetyState;
    currentStateEnteredAt: string | null;
    now: Date;
  }): boolean {
    if (!input.currentStateEnteredAt) {
      return true;
    }

    const enteredAt = new Date(input.currentStateEnteredAt);
    if (Number.isNaN(enteredAt.getTime())) {
      return true;
    }

    const cooldownMs =
      input.state === 'reduced_size'
        ? 5 * 60_000
        : input.state === 'reduced_frequency'
          ? 10 * 60_000
          : input.state === 'passive_only'
            ? 10 * 60_000
            : input.state === 'no_new_entries'
              ? 15 * 60_000
              : input.state === 'halt'
                ? 30 * 60_000
                : 0;

    return input.now.getTime() - enteredAt.getTime() >= cooldownMs;
  }
}
