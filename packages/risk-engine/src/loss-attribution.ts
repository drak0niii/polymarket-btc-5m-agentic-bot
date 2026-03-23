export type LossAttributionCause =
  | 'model_error'
  | 'execution_error'
  | 'stale_data'
  | 'venue_rejection'
  | 'liquidity_decay'
  | 'regime_mismatch';

export interface LossAttributionEvidence {
  pnl: number;
  expectedEv?: number | null;
  realizedSlippage?: number | null;
  expectedSlippage?: number | null;
  reasonCodes?: string[];
  regime?: string | null;
  currentRegime?: string | null;
  executionFailure?: boolean;
  venueFailure?: boolean;
  staleData?: boolean;
  liquidityStress?: boolean;
}

export interface LossAttributionCauseScore {
  cause: LossAttributionCause;
  confidence: number;
  evidence: string[];
}

export interface LossAttributionResult {
  dominantCause: LossAttributionCause;
  dominantConfidence: number;
  causes: LossAttributionCauseScore[];
}

export interface LossAttributionSummary {
  dominantCause: LossAttributionCause | null;
  dominantConfidence: number;
  weightedConfidenceByCause: Record<LossAttributionCause, number>;
  episodeCount: number;
}

export class LossAttributionModel {
  attribute(input: LossAttributionEvidence): LossAttributionResult {
    const scores = new Map<LossAttributionCause, LossAttributionCauseScore>();
    const add = (
      cause: LossAttributionCause,
      confidence: number,
      evidence: string,
    ): void => {
      const existing = scores.get(cause) ?? {
        cause,
        confidence: 0,
        evidence: [],
      };
      existing.confidence = Math.max(existing.confidence, clamp01(confidence));
      if (!existing.evidence.includes(evidence)) {
        existing.evidence.push(evidence);
      }
      scores.set(cause, existing);
    };

    const reasons = input.reasonCodes ?? [];
    if (input.staleData || reasons.some((reason) => reason.includes('stale'))) {
      add('stale_data', 0.88, 'stale input or stale rejection evidence');
    }

    if (
      input.venueFailure ||
      reasons.some((reason) => reason.includes('venue') || reason.includes('auth') || reason.includes('reject'))
    ) {
      add('venue_rejection', 0.8, 'venue-side rejection or auth failure evidence');
    }

    if (
      input.executionFailure ||
      (input.realizedSlippage != null &&
        input.expectedSlippage != null &&
        input.realizedSlippage > input.expectedSlippage * 1.5)
    ) {
      add('execution_error', 0.76, 'realized execution underperformed expected execution');
    }

    if (
      input.liquidityStress ||
      reasons.some((reason) => reason.includes('liquidity') || reason.includes('slippage'))
    ) {
      add('liquidity_decay', 0.7, 'liquidity quality deteriorated materially');
    }

    if (
      input.regime &&
      input.currentRegime &&
      input.regime !== input.currentRegime
    ) {
      add('regime_mismatch', 0.72, 'trade regime and observed regime diverged');
    }

    if (input.pnl < 0 && (input.expectedEv ?? 0) > 0 && scores.size === 0) {
      add('model_error', 0.68, 'signal lost despite no stronger operational cause');
    }

    if (scores.size === 0) {
      add('model_error', 0.5, 'fallback attribution due to insufficient evidence');
    }

    const causes = [...scores.values()].sort((left, right) => right.confidence - left.confidence);
    const dominant = causes[0] ?? {
      cause: 'model_error' as const,
      confidence: 0.5,
      evidence: ['fallback attribution'],
    };

    return {
      dominantCause: dominant.cause,
      dominantConfidence: dominant.confidence,
      causes,
    };
  }

  summarize(evidences: LossAttributionEvidence[]): LossAttributionSummary {
    if (evidences.length === 0) {
      return {
        dominantCause: null,
        dominantConfidence: 0,
        weightedConfidenceByCause: this.emptyWeights(),
        episodeCount: 0,
      };
    }

    const weightedConfidenceByCause = this.emptyWeights();
    for (const evidence of evidences) {
      const result = this.attribute(evidence);
      for (const cause of result.causes) {
        weightedConfidenceByCause[cause.cause] += cause.confidence;
      }
    }

    const dominantEntry = (Object.entries(weightedConfidenceByCause) as Array<
      [LossAttributionCause, number]
    >).sort((left, right) => right[1] - left[1])[0] ?? ['model_error', 0];

    return {
      dominantCause: dominantEntry[0],
      dominantConfidence:
        evidences.length > 0 ? dominantEntry[1] / evidences.length : 0,
      weightedConfidenceByCause,
      episodeCount: evidences.length,
    };
  }

  private emptyWeights(): Record<LossAttributionCause, number> {
    return {
      model_error: 0,
      execution_error: 0,
      stale_data: 0,
      venue_rejection: 0,
      liquidity_decay: 0,
      regime_mismatch: 0,
    };
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}
