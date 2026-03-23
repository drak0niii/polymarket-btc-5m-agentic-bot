export type TradeAttributionBucket =
  | 'bad_forecast'
  | 'bad_execution'
  | 'bad_setup_fit'
  | 'bad_market_selection'
  | 'stale_data'
  | 'fee_drag'
  | 'inventory_management'
  | 'mixed';

export interface SignalQualityMetrics {
  expectedEdge: number | null;
  expectedEv: number | null;
  marketEligible: boolean;
  signalAgeMs: number | null;
}

export interface ExecutionQualityMetrics {
  expectedEntryPrice: number | null;
  actualEntryPrice: number | null;
  realizedSlippage: number | null;
  expectedSlippage: number | null;
  fillDelayMs: number | null;
  fees: number;
  grossPnl: number | null;
  netPnl: number | null;
}

export interface TradeAttributionInput {
  signal: SignalQualityMetrics;
  execution: ExecutionQualityMetrics;
  staleData: boolean;
  inventoryManagedExit: boolean;
  setup?: {
    strategyFamily?: string | null;
    edgeDefinitionVersion?: string | null;
    admissibleNetEdge?: number | null;
    halfLifeExpired?: boolean;
    noTradeZones?: string[];
  };
}

export interface TradeAttributionRecord {
  bucket: TradeAttributionBucket;
  signalQuality: SignalQualityMetrics;
  executionQuality: ExecutionQualityMetrics;
  setup: TradeAttributionInput['setup'];
  reasons: string[];
}

export class TradeAttributionService {
  attribute(input: TradeAttributionInput): TradeAttributionRecord {
    const reasons: string[] = [];

    if (input.staleData) {
      reasons.push('stale_data');
      return this.record('stale_data', input, reasons);
    }

    if (input.execution.grossPnl != null && input.execution.netPnl != null) {
      if (input.execution.grossPnl > 0 && input.execution.netPnl <= 0) {
        reasons.push('fee_drag');
        return this.record('fee_drag', input, reasons);
      }
    }

    if (!input.signal.marketEligible) {
      reasons.push('market_eligibility_failed');
      return this.record('bad_market_selection', input, reasons);
    }

    if (
      input.setup?.halfLifeExpired ||
      (input.setup?.admissibleNetEdge ?? 0) <= 0 ||
      (input.setup?.noTradeZones?.length ?? 0) > 0
    ) {
      reasons.push('setup_became_non_admissible');
      return this.record('bad_setup_fit', input, reasons);
    }

    if (
      input.execution.realizedSlippage != null &&
      input.execution.expectedSlippage != null &&
      input.execution.realizedSlippage >
        Math.max(input.execution.expectedSlippage * 1.5, input.execution.expectedSlippage + 0.002)
    ) {
      reasons.push('slippage_materially_worse_than_expected');
      return this.record('bad_execution', input, reasons);
    }

    if (input.inventoryManagedExit) {
      reasons.push('inventory_management_exit');
      return this.record('inventory_management', input, reasons);
    }

    if ((input.signal.expectedEv ?? 0) > 0 && (input.execution.netPnl ?? 0) < 0) {
      reasons.push('forecast_underperformed');
      return this.record('bad_forecast', input, reasons);
    }

    reasons.push('mixed_trade_loss');
    return this.record('mixed', input, reasons);
  }

  private record(
    bucket: TradeAttributionBucket,
    input: TradeAttributionInput,
    reasons: string[],
  ): TradeAttributionRecord {
    return {
      bucket,
      signalQuality: input.signal,
      executionQuality: input.execution,
      setup: input.setup,
      reasons,
    };
  }
}
