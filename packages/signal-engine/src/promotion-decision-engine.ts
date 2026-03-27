import type {
  ShadowEvaluationEvidence,
  StrategyPromotionDecision,
  StrategyRolloutStage,
} from '@polymarket-btc-5m-agentic-bot/domain';
import type { CapitalGrowthPromotionGateDecision } from './capital-growth-promotion-gate';
import type { LiveDemotionGateDecision } from './live-demotion-gate';
import type {
  LivePromotionEvidencePacket,
  LivePromotionGateDecision,
} from './live-promotion-gate';
import type { PromotionStabilityCheckDecision } from './promotion-stability-check';

interface PromotionEconomicControls {
  capitalGrowthGate: CapitalGrowthPromotionGateDecision;
  stabilityCheck: PromotionStabilityCheckDecision;
  netEdgeQuality: number | null;
  maxDrawdownPct: number | null;
  capitalLeakageRatio: number | null;
  executionEvRetention: number | null;
  regimeStabilityScore: number | null;
  stabilityAdjustedCapitalGrowthScore: number | null;
  compoundingEfficiencyScore: number | null;
}

interface PromotionLiveControls {
  livePromotionGate?: LivePromotionGateDecision;
  liveDemotionGate?: LiveDemotionGateDecision;
  liveEvidencePacket?: LivePromotionEvidencePacket;
}

export class PromotionDecisionEngine {
  evaluate(input: {
    evidence: ShadowEvaluationEvidence;
    currentRolloutStage: StrategyRolloutStage;
    economicControls?: PromotionEconomicControls;
    liveControls?: PromotionLiveControls;
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
    const livePromotionGate = input.liveControls?.livePromotionGate;
    const liveDemotionGate = input.liveControls?.liveDemotionGate;

    if (!input.evidence.sufficientSample) {
      reasons.push('sample_sufficiency_not_met');
      return buildDecision('shadow_only', 'shadow_only', reasons, input.evidence, now, input);
    }

    if (liveDemotionGate?.action === 'quarantine') {
      reasons.push(...liveDemotionGate.reasonCodes);
      return buildDecision('rollback', 'shadow_only', reasons, input.evidence, now, input);
    }

    if (liveDemotionGate?.action === 'demote') {
      reasons.push(...liveDemotionGate.reasonCodes);
      return buildDecision('rollback', 'paper', reasons, input.evidence, now, input);
    }

    if (liveDemotionGate?.action === 'probation') {
      reasons.push(...liveDemotionGate.reasonCodes);
    }

    if (severeHealthFailure) {
      reasons.push('health_guardrail_failed');
      if (input.currentRolloutStage !== 'shadow_only') {
        return buildDecision('rollback', 'shadow_only', reasons, input.evidence, now, input);
      }
      return buildDecision('reject', 'shadow_only', reasons, input.evidence, now, input);
    }

    if (realizedVsExpectedWeak) {
      reasons.push('realized_vs_expected_not_supportive');
      return buildDecision('shadow_only', 'shadow_only', reasons, input.evidence, now, input);
    }

    if (improvementMissing) {
      reasons.push('incumbent_outperforms_candidate');
      return buildDecision('shadow_only', 'shadow_only', reasons, input.evidence, now, input);
    }

    if (livePromotionGate && !livePromotionGate.passed) {
      reasons.push(...livePromotionGate.reasonCodes);
      return buildDecision('shadow_only', 'shadow_only', reasons, input.evidence, now, input);
    }

    if (input.economicControls && !input.economicControls.stabilityCheck.stable) {
      reasons.push(...input.economicControls.stabilityCheck.reasons);
      if (input.currentRolloutStage !== 'shadow_only') {
        return buildDecision('rollback', 'shadow_only', reasons, input.evidence, now, input);
      }
      return buildDecision('reject', 'shadow_only', reasons, input.evidence, now, input);
    }

    if (input.economicControls && !input.economicControls.capitalGrowthGate.passed) {
      reasons.push(...input.economicControls.capitalGrowthGate.reasons);
      return buildDecision('shadow_only', 'shadow_only', reasons, input.evidence, now, input);
    }

    const targetStage = nextRolloutStage(input.currentRolloutStage);

    if (degradedHealth) {
      reasons.push('degraded_health_limits_rollout');
      return buildDecision('canary', targetStage, reasons, input.evidence, now, input);
    }

    if (
      input.evidence.sampleCount >= 10 &&
      input.evidence.calibrationHealth === 'healthy' &&
      input.evidence.executionHealth === 'healthy' &&
      (input.evidence.improvementVsIncumbent ?? 0) > 0.05 &&
      (input.evidence.realizedVsExpected ?? 0) >= 1.05
    ) {
      reasons.push('multi_factor_promotion_evidence_satisfied');
      return buildDecision(
        targetStage === 'scaled_live' ? 'promote' : 'canary',
        targetStage,
        reasons,
        input.evidence,
        now,
        input,
      );
    }

    reasons.push('candidate_enters_bounded_rollout');
    return buildDecision(
      targetStage === 'scaled_live' ? 'promote' : 'canary',
      targetStage,
      reasons,
      input.evidence,
      now,
      input,
    );
  }
}

function buildDecision(
  verdict: StrategyPromotionDecision['verdict'],
  targetRolloutStage: StrategyRolloutStage,
  reasons: string[],
  evidence: ShadowEvaluationEvidence,
  now: Date,
  input: {
    economicControls?: PromotionEconomicControls;
    liveControls?: PromotionLiveControls;
  },
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
      netEdgeQuality: input.economicControls?.netEdgeQuality ?? null,
      maxDrawdownPct: input.economicControls?.maxDrawdownPct ?? null,
      capitalLeakageRatio: input.economicControls?.capitalLeakageRatio ?? null,
      executionEvRetention: input.economicControls?.executionEvRetention ?? null,
      regimeStabilityScore: input.economicControls?.regimeStabilityScore ?? null,
      stabilityAdjustedCapitalGrowthScore:
        input.economicControls?.stabilityAdjustedCapitalGrowthScore ?? null,
      compoundingEfficiencyScore: input.economicControls?.compoundingEfficiencyScore ?? null,
      promotionGate: input.economicControls?.capitalGrowthGate.evidence,
      stabilityCheck: input.economicControls?.stabilityCheck.evidence,
      livePromotionGate: input.liveControls?.livePromotionGate ?? null,
      liveDemotionGate: input.liveControls?.liveDemotionGate ?? null,
      liveEvidencePacket: input.liveControls?.liveEvidencePacket ?? null,
      promotionOrDemotionDecision: verdict,
      reasonCodes: [...reasons, ...evidence.reasons],
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

function nextRolloutStage(current: StrategyRolloutStage): StrategyRolloutStage {
  switch (current) {
    case 'shadow_only':
      return 'paper';
    case 'paper':
    case 'canary_1pct':
      return 'canary';
    case 'canary':
    case 'canary_5pct':
      return 'cautious_live';
    case 'cautious_live':
    case 'partial':
      return 'scaled_live';
    case 'scaled_live':
    case 'full':
      return 'scaled_live';
  }
}
