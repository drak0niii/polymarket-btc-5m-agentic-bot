export interface CooldownFilterInput {
  now: string;
  lastLossAt: string | null;
  cooldownSeconds: number;
}

export interface CooldownFilterResult {
  passed: boolean;
  reasonCode: string;
  reasonMessage: string | null;
  remainingCooldownSeconds: number;
}

export class CooldownFilter {
  evaluate(input: CooldownFilterInput): CooldownFilterResult {
    if (!input.lastLossAt || input.cooldownSeconds <= 0) {
      return {
        passed: true,
        reasonCode: 'passed',
        reasonMessage: null,
        remainingCooldownSeconds: 0,
      };
    }

    const elapsedSeconds = Math.floor(
      (new Date(input.now).getTime() - new Date(input.lastLossAt).getTime()) /
        1000,
    );

    const remainingCooldownSeconds = Math.max(
      0,
      input.cooldownSeconds - elapsedSeconds,
    );

    if (remainingCooldownSeconds > 0) {
      return {
        passed: false,
        reasonCode: 'cooldown_active',
        reasonMessage: `Cooldown active for ${remainingCooldownSeconds} more seconds.`,
        remainingCooldownSeconds,
      };
    }

    return {
      passed: true,
      reasonCode: 'passed',
      reasonMessage: null,
      remainingCooldownSeconds: 0,
    };
  }
}