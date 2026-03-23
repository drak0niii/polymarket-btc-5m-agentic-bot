export interface LiveTradeGuardInput {
  botState:
    | 'bootstrapping'
    | 'running'
    | 'degraded'
    | 'reconciliation_only'
    | 'cancel_only'
    | 'halted_hard'
    | 'stopped';
  signerHealthy: boolean;
  credentialsHealthy: boolean;
  marketDataFresh: boolean;
}

export interface LiveTradeGuardResult {
  passed: boolean;
  reasonCode: string;
  reasonMessage: string | null;
}

export class LiveTradeGuard {
  evaluate(input: LiveTradeGuardInput): LiveTradeGuardResult {
    if (input.botState !== 'running' && input.botState !== 'degraded') {
      return {
        passed: false,
        reasonCode: 'bot_not_running',
        reasonMessage: `Bot state ${input.botState} does not allow live trading.`,
      };
    }

    if (!input.signerHealthy) {
      return {
        passed: false,
        reasonCode: 'signer_unhealthy',
        reasonMessage: 'Signer health check failed.',
      };
    }

    if (!input.credentialsHealthy) {
      return {
        passed: false,
        reasonCode: 'credentials_unhealthy',
        reasonMessage: 'Trading credentials are not healthy.',
      };
    }

    if (!input.marketDataFresh) {
      return {
        passed: false,
        reasonCode: 'market_data_stale',
        reasonMessage: 'Market data is stale.',
      };
    }

    return {
      passed: true,
      reasonCode: 'passed',
      reasonMessage: null,
    };
  }
}
