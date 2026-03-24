import type {
  HealthLabel,
  TradeQualityBreakdown,
  TradeQualityComponentScore,
  TradeQualityLabel,
  TradeQualityScore,
} from '@polymarket-btc-5m-agentic-bot/domain';

export interface TradeQualityScorerInput {
  tradeId: string;
  orderId: string | null;
  signalId: string | null;
  marketId: string | null;
  strategyVariantId: string | null;
  regime: string | null;
  marketContext: string | null;
  executionStyle: string | null;
  evaluatedAt: string;
  expectedEv: number | null;
  realizedEv: number | null;
  forecastEdge: number | null;
  calibrationHealth: HealthLabel | null;
  fillRate: number | null;
  expectedSlippage: number | null;
  realizedSlippage: number | null;
  fillDelayMs: number | null;
  policyBreaches: string[];
}

export class TradeQualityScorer {
  score(input: TradeQualityScorerInput): TradeQualityScore {
    const breakdown: TradeQualityBreakdown = {
      forecastQuality: this.forecastQuality(input),
      calibrationQuality: this.calibrationQuality(input),
      executionQuality: this.executionQuality(input),
      timingQuality: this.timingQuality(input),
      policyCompliance: this.policyCompliance(input),
      realizedOutcomeQuality: this.realizedOutcomeQuality(input),
      overallScore: 0,
      reasons: [],
    };

    breakdown.overallScore =
      breakdown.forecastQuality.score * 0.2 +
      breakdown.calibrationQuality.score * 0.15 +
      breakdown.executionQuality.score * 0.2 +
      breakdown.timingQuality.score * 0.1 +
      breakdown.policyCompliance.score * 0.15 +
      breakdown.realizedOutcomeQuality.score * 0.2;
    breakdown.reasons = [
      ...breakdown.forecastQuality.reasons,
      ...breakdown.calibrationQuality.reasons,
      ...breakdown.executionQuality.reasons,
      ...breakdown.timingQuality.reasons,
      ...breakdown.policyCompliance.reasons,
      ...breakdown.realizedOutcomeQuality.reasons,
    ];

    return {
      tradeId: input.tradeId,
      orderId: input.orderId,
      signalId: input.signalId,
      marketId: input.marketId,
      strategyVariantId: input.strategyVariantId,
      regime: input.regime,
      marketContext: input.marketContext,
      executionStyle: input.executionStyle,
      evaluatedAt: input.evaluatedAt,
      label: this.labelForScore(breakdown.overallScore),
      breakdown,
    };
  }

  private forecastQuality(input: TradeQualityScorerInput): TradeQualityComponentScore {
    let score = 0.5;
    const reasons: string[] = [];
    if ((input.forecastEdge ?? 0) > 0 && (input.expectedEv ?? 0) > 0) {
      score += 0.25;
      reasons.push('positive_forecast_edge');
    }
    if ((input.expectedEv ?? 0) <= 0) {
      score -= 0.3;
      reasons.push('non_positive_expected_ev');
    }
    if ((input.realizedEv ?? 0) < 0 && (input.expectedEv ?? 0) > 0) {
      score -= 0.15;
      reasons.push('forecast_underperformed_realized_outcome');
    }
    return this.component(score, reasons, {
      forecastEdge: input.forecastEdge,
      expectedEv: input.expectedEv,
      realizedEv: input.realizedEv,
    });
  }

  private calibrationQuality(input: TradeQualityScorerInput): TradeQualityComponentScore {
    let score = 0.8;
    const reasons: string[] = [];
    if (input.calibrationHealth === 'watch') {
      score -= 0.2;
      reasons.push('calibration_watch');
    } else if (input.calibrationHealth === 'degraded') {
      score -= 0.4;
      reasons.push('calibration_degraded');
    } else if (input.calibrationHealth === 'quarantine_candidate') {
      score -= 0.6;
      reasons.push('calibration_quarantine_candidate');
    }
    return this.component(score, reasons, {
      calibrationHealth: input.calibrationHealth,
    });
  }

  private executionQuality(input: TradeQualityScorerInput): TradeQualityComponentScore {
    let score = 0.8;
    const reasons: string[] = [];
    const slippageGap = Math.max(0, (input.realizedSlippage ?? 0) - (input.expectedSlippage ?? 0));
    if (slippageGap > 0.003) {
      score -= 0.25;
      reasons.push('slippage_worse_than_expected');
    }
    if ((input.fillRate ?? 1) < 0.7) {
      score -= 0.25;
      reasons.push('fill_rate_weak');
    }
    return this.component(score, reasons, {
      expectedSlippage: input.expectedSlippage,
      realizedSlippage: input.realizedSlippage,
      fillRate: input.fillRate,
    });
  }

  private timingQuality(input: TradeQualityScorerInput): TradeQualityComponentScore {
    let score = 0.8;
    const reasons: string[] = [];
    if ((input.fillDelayMs ?? 0) > 60_000) {
      score -= 0.2;
      reasons.push('entry_timing_slow');
    }
    if ((input.fillDelayMs ?? 0) > 180_000) {
      score -= 0.3;
      reasons.push('entry_timing_very_slow');
    }
    return this.component(score, reasons, {
      fillDelayMs: input.fillDelayMs,
    });
  }

  private policyCompliance(input: TradeQualityScorerInput): TradeQualityComponentScore {
    let score = 1;
    const reasons: string[] = [];
    if (input.policyBreaches.length > 0) {
      score -= Math.min(0.8, input.policyBreaches.length * 0.2);
      reasons.push(...input.policyBreaches.map((breach) => `policy_breach:${breach}`));
    }
    return this.component(score, reasons, {
      policyBreaches: input.policyBreaches,
    });
  }

  private realizedOutcomeQuality(input: TradeQualityScorerInput): TradeQualityComponentScore {
    let score = 0.5;
    const reasons: string[] = [];
    if ((input.realizedEv ?? 0) > 0) {
      score += 0.35;
      reasons.push('positive_realized_ev');
    } else if ((input.realizedEv ?? 0) < 0) {
      score -= 0.35;
      reasons.push('negative_realized_ev');
    }
    if ((input.realizedEv ?? 0) < (input.expectedEv ?? 0)) {
      score -= 0.1;
      reasons.push('realized_ev_below_expected');
    }
    return this.component(score, reasons, {
      expectedEv: input.expectedEv,
      realizedEv: input.realizedEv,
    });
  }

  private component(
    score: number,
    reasons: string[],
    evidence: Record<string, unknown>,
  ): TradeQualityComponentScore {
    const boundedScore = Math.max(0, Math.min(1, score));
    return {
      score: boundedScore,
      label: this.labelForScore(boundedScore),
      reasons,
      evidence,
    };
  }

  private labelForScore(score: number): TradeQualityLabel {
    if (score >= 0.85) {
      return 'excellent';
    }
    if (score >= 0.7) {
      return 'good';
    }
    if (score >= 0.5) {
      return 'mixed';
    }
    if (score >= 0.3) {
      return 'poor';
    }
    return 'destructive';
  }
}
