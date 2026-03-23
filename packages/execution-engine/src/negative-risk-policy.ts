export type NegativeRiskMode = 'exclude' | 'support';

export interface NegativeRiskPolicyInput {
  negRisk: boolean;
  mode?: NegativeRiskMode;
}

export interface NegativeRiskPolicyResult {
  allowed: boolean;
  mode: NegativeRiskMode;
  reasonCode: string;
  reasonMessage: string;
}

export class NegativeRiskPolicy {
  evaluate(input: NegativeRiskPolicyInput): NegativeRiskPolicyResult {
    const mode = input.mode ?? 'exclude';

    if (!input.negRisk) {
      return {
        allowed: true,
        mode,
        reasonCode: 'negative_risk_not_present',
        reasonMessage: 'Venue metadata indicates a standard non-negative-risk market.',
      };
    }

    if (mode === 'support') {
      return {
        allowed: true,
        mode,
        reasonCode: 'negative_risk_supported',
        reasonMessage: 'Negative-risk market support is enabled explicitly.',
      };
    }

    return {
      allowed: false,
      mode,
      reasonCode: 'negative_risk_market_excluded',
      reasonMessage:
        'BTC 5-minute execution policy excludes negative-risk markets until pricing, exposure, and reconciliation semantics are deliberately extended.',
    };
  }
}
