import type { NoTradeClassifierOutput } from './no-trade/no-trade-classifier';

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
  | 'regime_confidence_too_low'
  | 'regime_evidence_insufficient'
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
  noTradeClassifier?: NoTradeClassifierOutput | null;
  halfLifeExpired?: boolean;
  paperEdgeDetected?: boolean;
  admissionThreshold?: number;
  executableEdge: ExecutableEdgeEstimate;
  minimumConfidence?: number;
  regimeLabel?: string | null;
  regimeConfidence?: number | null;
  regimeTransitionRisk?: number | null;
  minimumRegimeConfidence?: number;
  regimeEvidenceSampleCount?: number | null;
  minimumRegimeEvidenceSampleCount?: number;
}

export interface TradeAdmissionEvidenceQualitySummary {
  regimeEvidenceSampleCount: number | null;
  minimumRegimeEvidenceSampleCount: number;
  regimeEvidenceQuality: 'strong' | 'limited' | 'insufficient';
}

export interface TradeAdmissionGateResult {
  admitted: boolean;
  reasonCode: TradeAdmissionReasonCode;
  reasonMessage: string;
  executableEdge: ExecutableEdgeEstimate;
  rejectionReasons: string[];
  regimeContext: {
    regimeLabel: string | null;
    regimeConfidence: number | null;
    regimeTransitionRisk: number | null;
  };
  evidenceQualitySummary: TradeAdmissionEvidenceQualitySummary;
}

export class TradeAdmissionGate {
  evaluate(input: TradeAdmissionGateInput): TradeAdmissionGateResult {
    const minimumConfidence = input.minimumConfidence ?? 0.6;
    const minimumRegimeConfidence = input.minimumRegimeConfidence ?? 0.58;
    const minimumRegimeEvidenceSampleCount = input.minimumRegimeEvidenceSampleCount ?? 0;
    const threshold = input.admissionThreshold ?? input.executableEdge.threshold ?? 0;
    const evidenceQualitySummary = summarizeEvidenceQuality(
      input.regimeEvidenceSampleCount ?? null,
      minimumRegimeEvidenceSampleCount,
    );

    if (!input.edgeDefinitionVersion) {
      return this.reject(
        'edge_definition_missing',
        'Trade admission is blocked because no canonical edge definition was supplied.',
        input.executableEdge,
        input,
        evidenceQualitySummary,
      );
    }

    if (!input.signalPresent || input.directionalEdge == null) {
      return this.reject(
        'no_signal',
        'No executable signal is present.',
        input.executableEdge,
        input,
        evidenceQualitySummary,
      );
    }

    if (input.noTradeZoneBlocked) {
      return this.reject(
        'no_trade_zone',
        'A strict no-trade zone is active for this setup.',
        input.executableEdge,
        input,
        evidenceQualitySummary,
      );
    }

    if (input.noTradeClassifier && !input.noTradeClassifier.allowTrade) {
      return this.reject(
        'no_trade_zone',
        `No-trade classifier blocked this setup: ${input.noTradeClassifier.reasonCodes.join(',')}.`,
        input.executableEdge,
        input,
        evidenceQualitySummary,
      );
    }

    if (input.halfLifeExpired) {
      return this.reject(
        'edge_half_life_expired',
        'The signal edge decayed beyond its admissible half-life.',
        input.executableEdge,
        input,
        evidenceQualitySummary,
      );
    }

    if (!input.regimeAllowed) {
      return this.reject(
        'regime_blocked',
        'Current regime does not permit new entries.',
        input.executableEdge,
        input,
        evidenceQualitySummary,
      );
    }

    if (
      typeof input.regimeConfidence === 'number' &&
      Number.isFinite(input.regimeConfidence) &&
      input.regimeConfidence < minimumRegimeConfidence
    ) {
      return this.reject(
        'regime_confidence_too_low',
        'Regime confidence is below the deployment threshold.',
        input.executableEdge,
        input,
        evidenceQualitySummary,
      );
    }

    if (
      minimumRegimeEvidenceSampleCount > 0 &&
      evidenceQualitySummary.regimeEvidenceQuality === 'insufficient'
    ) {
      return this.reject(
        'regime_evidence_insufficient',
        'Regime-specific live evidence is insufficient for admission.',
        input.executableEdge,
        input,
        evidenceQualitySummary,
      );
    }

    if (input.executableEdge.missingInputs.length > 0) {
      return this.reject(
        'friction_input_missing',
        'Required executable-friction inputs are missing.',
        input.executableEdge,
        input,
        evidenceQualitySummary,
      );
    }

    if (!input.liquidityHealthy) {
      return this.reject(
        'bad_liquidity',
        'Liquidity gate failed.',
        input.executableEdge,
        input,
        evidenceQualitySummary,
      );
    }

    if (!input.freshnessHealthy || input.executableEdge.staleInputs.length > 0) {
      return this.reject(
        'stale_data',
        'Freshness gate failed.',
        input.executableEdge,
        input,
        evidenceQualitySummary,
      );
    }

    if (!input.venueHealthy) {
      return this.reject(
        'venue_unhealthy',
        'Venue health gate failed.',
        input.executableEdge,
        input,
        evidenceQualitySummary,
      );
    }

    if (!input.reconciliationHealthy) {
      return this.reject(
        'reconciliation_unhealthy',
        'Reconciliation health gate failed.',
        input.executableEdge,
        input,
        evidenceQualitySummary,
      );
    }

    if (!input.riskHealthy) {
      return this.reject(
        'risk_blocked',
        'Risk gate failed.',
        input.executableEdge,
        input,
        evidenceQualitySummary,
      );
    }

    if (Math.abs(input.directionalEdge) < 0.0025) {
      return this.reject(
        'weak_signal',
        'Directional edge is too weak.',
        input.executableEdge,
        input,
        evidenceQualitySummary,
      );
    }

    if (input.paperEdgeDetected && (input.executableEdge.finalNetEdge ?? 0) <= threshold) {
      return this.reject(
        'paper_edge_only',
        'Raw directional edge is positive but executable net edge is not.',
        input.executableEdge,
        input,
        evidenceQualitySummary,
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
        input,
        evidenceQualitySummary,
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
        input,
        evidenceQualitySummary,
      );
    }

    return {
      admitted: true,
      reasonCode: 'trade_permitted',
      reasonMessage: 'All trade-admission gates passed.',
      executableEdge: input.executableEdge,
      rejectionReasons: [],
      regimeContext: {
        regimeLabel: input.regimeLabel ?? null,
        regimeConfidence: finiteOrNull(input.regimeConfidence),
        regimeTransitionRisk: finiteOrNull(input.regimeTransitionRisk),
      },
      evidenceQualitySummary,
    };
  }

  private reject(
    reasonCode: Exclude<TradeAdmissionReasonCode, 'trade_permitted'>,
    reasonMessage: string,
    executableEdge: ExecutableEdgeEstimate,
    input: TradeAdmissionGateInput,
    evidenceQualitySummary: TradeAdmissionEvidenceQualitySummary,
  ): TradeAdmissionGateResult {
    return {
      admitted: false,
      reasonCode,
      reasonMessage,
      executableEdge,
      rejectionReasons: [
        reasonCode,
        ...(input.noTradeClassifier?.reasonCodes ?? []),
      ],
      regimeContext: {
        regimeLabel: input.regimeLabel ?? null,
        regimeConfidence: finiteOrNull(input.regimeConfidence),
        regimeTransitionRisk: finiteOrNull(input.regimeTransitionRisk),
      },
      evidenceQualitySummary,
    };
  }
}

function summarizeEvidenceQuality(
  sampleCount: number | null,
  minimumSampleCount: number,
): TradeAdmissionEvidenceQualitySummary {
  const normalized = finiteOrNull(sampleCount);
  if (minimumSampleCount <= 0) {
    return {
      regimeEvidenceSampleCount: normalized,
      minimumRegimeEvidenceSampleCount: minimumSampleCount,
      regimeEvidenceQuality: normalized == null ? 'limited' : 'strong',
    };
  }
  const regimeEvidenceQuality =
    normalized == null || normalized < minimumSampleCount
      ? 'insufficient'
      : normalized < minimumSampleCount * 2
        ? 'limited'
        : 'strong';
  return {
    regimeEvidenceSampleCount: normalized,
    minimumRegimeEvidenceSampleCount: minimumSampleCount,
    regimeEvidenceQuality,
  };
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
