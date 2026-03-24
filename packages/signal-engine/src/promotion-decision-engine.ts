import type {
  ShadowEvaluationEvidence,
  StrategyPromotionDecision,
  StrategyRolloutStage,
} from '@polymarket-btc-5m-agentic-bot/domain';

export class PromotionDecisionEngine {
  evaluate(input: {
    evidence: ShadowEvaluationEvidence;
    currentRolloutStage: StrategyRolloutStage;
    now?: Date;
  }): StrategyPromotionDecision {
    const now = input.now ?? new Date();
    const reasons: string[] = [];
    const severeHealthFailure =
      input.evidence.calibrationHealth === 'quarantine_candidate' ||
      input.evidence.executionHealth === 'quarantine_candidate';
    const degradedHealth =
      input.evidence.calibrationHealth === 'degraded' ||
      input.evidence.executionHealth === 'degraded';
    const realizedVsExpectedWeak =
      input.evidence.realizedVsExpected == null ||
      input.evidence.realizedVsExpected < 0.9;
    const improvementMissing =
      input.evidence.improvementVsIncumbent != null &&
      input.evidence.improvementVsIncumbent < 0;

    if (!input.evidence.sufficientSample) {
      reasons.push('sample_sufficiency_not_met');
      return buildDecision('shadow_only', 'shadow_only', reasons, input.evidence, now);
    }

    if (severeHealthFailure) {
      reasons.push('health_guardrail_failed');
      if (input.currentRolloutStage !== 'shadow_only') {
        return buildDecision('rollback', 'shadow_only', reasons, input.evidence, now);
      }
      return buildDecision('reject', 'shadow_only', reasons, input.evidence, now);
    }

    if (realizedVsExpectedWeak) {
      reasons.push('realized_vs_expected_not_supportive');
      return buildDecision('shadow_only', 'shadow_only', reasons, input.evidence, now);
    }

    if (improvementMissing) {
      reasons.push('incumbent_outperforms_candidate');
      return buildDecision('shadow_only', 'shadow_only', reasons, input.evidence, now);
    }

    if (degradedHealth) {
      reasons.push('degraded_health_limits_rollout');
      return buildDecision('canary', 'canary_1pct', reasons, input.evidence, now);
    }

    if (
      input.evidence.sampleCount >= 10 &&
      input.evidence.calibrationHealth === 'healthy' &&
      input.evidence.executionHealth === 'healthy' &&
      (input.evidence.improvementVsIncumbent ?? 0) > 0.05 &&
      (input.evidence.realizedVsExpected ?? 0) >= 1.05
    ) {
      reasons.push('multi_factor_promotion_evidence_satisfied');
      return buildDecision('promote', 'full', reasons, input.evidence, now);
    }

    reasons.push('candidate_enters_bounded_canary');
    return buildDecision(
      'canary',
      input.evidence.sampleCount >= 8 ? 'canary_5pct' : 'canary_1pct',
      reasons,
      input.evidence,
      now,
    );
  }
}

function buildDecision(
  verdict: StrategyPromotionDecision['verdict'],
  targetRolloutStage: StrategyRolloutStage,
  reasons: string[],
  evidence: ShadowEvaluationEvidence,
  now: Date,
): StrategyPromotionDecision {
  return {
    verdict,
    candidateVariantId: evidence.variantId,
    incumbentVariantId: evidence.incumbentVariantId,
    targetRolloutStage,
    reasons: [...reasons, ...evidence.reasons],
    evidence: {
      sampleCount: evidence.sampleCount,
      calibrationHealth: evidence.calibrationHealth,
      executionHealth: evidence.executionHealth,
      realizedVsExpected: evidence.realizedVsExpected,
      realizedPnl: evidence.realizedPnl,
      improvementVsIncumbent: evidence.improvementVsIncumbent,
    },
    rollbackCriteria: [
      'realized_ev_collapse',
      'calibration_collapse',
      'execution_deterioration',
      'unexplained_drawdown',
      'quarantine_escalation',
    ],
    decidedAt: now.toISOString(),
  };
}
