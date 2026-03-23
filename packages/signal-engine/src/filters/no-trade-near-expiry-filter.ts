export interface NoTradeNearExpiryFilterInput {
  timeToExpirySeconds: number | null;
  blockedWindowSeconds: number;
}

export interface NoTradeNearExpiryFilterResult {
  passed: boolean;
  reasonCode: string;
  reasonMessage: string | null;
}

export class NoTradeNearExpiryFilter {
  evaluate(
    input: NoTradeNearExpiryFilterInput,
  ): NoTradeNearExpiryFilterResult {
    if (input.timeToExpirySeconds === null) {
      return {
        passed: false,
        reasonCode: 'expiry_unknown',
        reasonMessage: 'Time to expiry is unknown.',
      };
    }

    if (input.timeToExpirySeconds <= input.blockedWindowSeconds) {
      return {
        passed: false,
        reasonCode: 'no_trade_near_expiry',
        reasonMessage: `Time to expiry ${input.timeToExpirySeconds}s is inside blocked window ${input.blockedWindowSeconds}s.`,
      };
    }

    return {
      passed: true,
      reasonCode: 'passed',
      reasonMessage: null,
    };
  }
}