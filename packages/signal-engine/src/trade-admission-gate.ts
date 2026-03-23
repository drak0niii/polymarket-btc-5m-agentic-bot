export type TradeAdmissionReasonCode =
  | 'edge_definition_missing'
  | 'no_signal'
  | 'weak_signal'
  | 'bad_liquidity'
  | 'stale_data'
  | 'venue_unhealthy'
  | 'reconciliation_unhealthy'
  | 'risk_blocked'
  | 'friction_input_missing'
  | 'no_trade_zone'
  | 'edge_half_life_expired'
  | 'paper_edge_only'
  | 'positive_direction_but_negative_ev'
  | 'positive_ev_but_below_confidence'
  | 'regime_blocked'
  | 'trade_permitted';

export interface ExecutableEdgeEstimate {
  edgeDefinitionVersion: string | null;
  executionStyle: 'taker' | 'maker' | 'hybrid';
  rawModelEdge: number | null;
  spreadAdjustedEdge: number | null;
  slippageAdjustedEdge: number | null;
  feeAdjustedEdge: number | null;
  timeoutAdjustedEdge: number | null;
  staleSignalAdjustedEdge: number | null;
  inventoryAdjustedEdge: number | null;
  finalNetEdge: number | null;
  threshold: number;
  missingInputs: string[];
  staleInputs: string[];
  paperEdgeBlocked: boolean;
  confidence: number;
}

export interface TradeAdmissionGateInput {
  edgeDefinitionVersion: string | null;
  signalPresent: boolean;
  directionalEdge: number | null;
  executableEv: number | null;
  signalConfidence: number | null;
  walkForwardConfidence: number | null;
  liquidityHealthy: boolean;
  freshnessHealthy: boolean;
  venueHealthy: boolean;
  reconciliationHealthy: boolean;
  riskHealthy: boolean;
  regimeAllowed: boolean;
  noTradeZoneBlocked?: boolean;
  halfLifeExpired?: boolean;
  paperEdgeDetected?: boolean;
  admissionThreshold?: number;
  executableEdge: ExecutableEdgeEstimate;
  minimumConfidence?: number;
}

export interface TradeAdmissionGateResult {
  admitted: boolean;
  reasonCode: TradeAdmissionReasonCode;
  reasonMessage: string;
  executableEdge: ExecutableEdgeEstimate;
}

export class TradeAdmissionGate {
  evaluate(input: TradeAdmissionGateInput): TradeAdmissionGateResult {
    const minimumConfidence = input.minimumConfidence ?? 0.6;
    const threshold = input.admissionThreshold ?? input.executableEdge.threshold ?? 0;

    if (!input.edgeDefinitionVersion) {
      return this.reject(
        'edge_definition_missing',
        'Trade admission is blocked because no canonical edge definition was supplied.',
        input.executableEdge,
      );
    }

    if (!input.signalPresent || input.directionalEdge == null) {
      return this.reject('no_signal', 'No executable signal is present.', input.executableEdge);
    }

    if (input.noTradeZoneBlocked) {
      return this.reject(
        'no_trade_zone',
        'A strict no-trade zone is active for this setup.',
        input.executableEdge,
      );
    }

    if (input.halfLifeExpired) {
      return this.reject(
        'edge_half_life_expired',
        'The signal edge decayed beyond its admissible half-life.',
        input.executableEdge,
      );
    }

    if (!input.regimeAllowed) {
      return this.reject(
        'regime_blocked',
        'Current regime does not permit new entries.',
        input.executableEdge,
      );
    }

    if (input.executableEdge.missingInputs.length > 0) {
      return this.reject(
        'friction_input_missing',
        'Required executable-friction inputs are missing.',
        input.executableEdge,
      );
    }

    if (!input.liquidityHealthy) {
      return this.reject('bad_liquidity', 'Liquidity gate failed.', input.executableEdge);
    }

    if (!input.freshnessHealthy || input.executableEdge.staleInputs.length > 0) {
      return this.reject('stale_data', 'Freshness gate failed.', input.executableEdge);
    }

    if (!input.venueHealthy) {
      return this.reject('venue_unhealthy', 'Venue health gate failed.', input.executableEdge);
    }

    if (!input.reconciliationHealthy) {
      return this.reject(
        'reconciliation_unhealthy',
        'Reconciliation health gate failed.',
        input.executableEdge,
      );
    }

    if (!input.riskHealthy) {
      return this.reject('risk_blocked', 'Risk gate failed.', input.executableEdge);
    }

    if (Math.abs(input.directionalEdge) < 0.0025) {
      return this.reject('weak_signal', 'Directional edge is too weak.', input.executableEdge);
    }

    if (input.paperEdgeDetected && (input.executableEdge.finalNetEdge ?? 0) <= threshold) {
      return this.reject(
        'paper_edge_only',
        'Raw directional edge is positive but executable net edge is not.',
        input.executableEdge,
      );
    }

    if (
      input.executableEv == null ||
      input.executableEdge.finalNetEdge == null ||
      input.executableEdge.finalNetEdge <= threshold
    ) {
      return this.reject(
        'positive_direction_but_negative_ev',
        'Directional edge exists but executable EV is non-positive.',
        input.executableEdge,
      );
    }

    const combinedConfidence = Math.min(
      input.signalConfidence ?? 0,
      input.walkForwardConfidence ?? 0,
    );
    if (combinedConfidence < minimumConfidence) {
      return this.reject(
        'positive_ev_but_below_confidence',
        'Executable EV is positive but confidence is below the deployment threshold.',
        input.executableEdge,
      );
    }

    return {
      admitted: true,
      reasonCode: 'trade_permitted',
      reasonMessage: 'All trade-admission gates passed.',
      executableEdge: input.executableEdge,
    };
  }

  private reject(
    reasonCode: Exclude<TradeAdmissionReasonCode, 'trade_permitted'>,
    reasonMessage: string,
    executableEdge: ExecutableEdgeEstimate,
  ): TradeAdmissionGateResult {
    return {
      admitted: false,
      reasonCode,
      reasonMessage,
      executableEdge,
    };
  }
}
