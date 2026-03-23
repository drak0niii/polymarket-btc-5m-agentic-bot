export interface ConsecutiveLossKillSwitchInput {
  consecutiveLosses: number;
  maxConsecutiveLosses: number;
}

export interface ConsecutiveLossKillSwitchResult {
  passed: boolean;
  reasonCode: string;
  reasonMessage: string | null;
}

export class ConsecutiveLossKillSwitch {
  evaluate(
    input: ConsecutiveLossKillSwitchInput,
  ): ConsecutiveLossKillSwitchResult {
    if (input.consecutiveLosses >= input.maxConsecutiveLosses) {
      return {
        passed: false,
        reasonCode: 'consecutive_loss_kill_switch_triggered',
        reasonMessage: `Consecutive losses ${input.consecutiveLosses} reached limit ${input.maxConsecutiveLosses}.`,
      };
    }

    return {
      passed: true,
      reasonCode: 'passed',
      reasonMessage: null,
    };
  }
}