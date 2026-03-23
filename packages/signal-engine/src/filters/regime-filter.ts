export interface RegimeFilterInput {
  regime:
    | 'low_volatility_drift'
    | 'spike_and_revert'
    | 'momentum_continuation'
    | 'illiquid_noisy_book'
    | 'near_resolution_microstructure_chaos';
  allowedRegimes: Array<
    | 'low_volatility_drift'
    | 'spike_and_revert'
    | 'momentum_continuation'
    | 'illiquid_noisy_book'
    | 'near_resolution_microstructure_chaos'
  >;
}

export interface RegimeFilterResult {
  passed: boolean;
  reasonCode: string;
  reasonMessage: string | null;
}

export class RegimeFilter {
  evaluate(input: RegimeFilterInput): RegimeFilterResult {
    if (!input.allowedRegimes.includes(input.regime)) {
      return {
        passed: false,
        reasonCode: 'regime_blocked',
        reasonMessage: `Regime ${input.regime} is not allowed by current strategy filters.`,
      };
    }

    return {
      passed: true,
      reasonCode: 'passed',
      reasonMessage: null,
    };
  }
}
