import type { HealthLabel, NetEdgeVenueUncertaintyLabel } from '@polymarket-btc-5m-agentic-bot/domain';

export type LiveFeedbackToxicityState = 'normal' | 'elevated' | 'high' | 'blocked' | null;
export type LiveFeedbackAggressionCap = 'unchanged' | 'passive_only';
export type LiveFeedbackRegimePermissionOverride =
  | 'unchanged'
  | 'reduce_only'
  | 'block_new_entries';
export type LiveFeedbackUpshiftEligibility = 'not_eligible' | 'probationary' | 'eligible';
export type LiveFeedbackRecoveryProbationState = 'none' | 'active' | 'extended';

export interface LiveSizingFeedbackInput {
  retentionRatio: number | null;
  calibrationHealth: HealthLabel | null;
  executionDrift: number | null;
  regimeDegradation: HealthLabel | null;
  toxicityState: LiveFeedbackToxicityState;
  venueUncertainty: NetEdgeVenueUncertaintyLabel | null;
  realizedVsExpected: number | null;
  trustScore?: number | null;
  evidenceQualityMultiplier?: number | null;
}

export interface LiveSizingFeedbackDecision {
  sizeMultiplier: number;
  downshiftMultiplier: number;
  executionQualityAdjustment: number;
  evidenceQualityAdjustment: number;
  finalCombinedSizingFeedback: number;
  upshiftEligibility: LiveFeedbackUpshiftEligibility;
  recoveryProbationState: LiveFeedbackRecoveryProbationState;
  sizingReasonCodes: string[];
  aggressionCap: LiveFeedbackAggressionCap;
  thresholdAdjustment: number;
  regimePermissionOverride: LiveFeedbackRegimePermissionOverride;
  reasonCodes: string[];
  evidence: Record<string, unknown>;
  capturedAt: string;
}

export class LiveSizingFeedbackPolicy {
  evaluate(input: LiveSizingFeedbackInput): LiveSizingFeedbackDecision {
    let downshiftMultiplier = 1;
    let thresholdAdjustment = 0;
    let aggressionCap: LiveFeedbackAggressionCap = 'unchanged';
    let regimePermissionOverride: LiveFeedbackRegimePermissionOverride = 'unchanged';
    const sizingReasonCodes: string[] = [];

    if (input.retentionRatio != null && input.retentionRatio < 0.75) {
      downshiftMultiplier *= 0.9;
      thresholdAdjustment = Math.max(thresholdAdjustment, 0.0004);
      sizingReasonCodes.push('retention_ratio_soft_degradation');
    }
    if (input.retentionRatio != null && input.retentionRatio < 0.55) {
      downshiftMultiplier *= 0.75;
      thresholdAdjustment = Math.max(thresholdAdjustment, 0.001);
      aggressionCap = 'passive_only';
      sizingReasonCodes.push('retention_ratio_hard_degradation');
    }
    if (input.retentionRatio != null && input.retentionRatio < 0.35) {
      downshiftMultiplier *= 0.55;
      thresholdAdjustment = Math.max(thresholdAdjustment, 0.0018);
      regimePermissionOverride = strongestPermission(
        regimePermissionOverride,
        'reduce_only',
      );
      sizingReasonCodes.push('retention_ratio_critical');
    }

    if (input.realizedVsExpected != null && input.realizedVsExpected < 0.95) {
      downshiftMultiplier *= 0.9;
      thresholdAdjustment = Math.max(thresholdAdjustment, 0.0005);
      sizingReasonCodes.push('realized_vs_expected_soft_miss');
    }
    if (input.realizedVsExpected != null && input.realizedVsExpected < 0.8) {
      downshiftMultiplier *= 0.72;
      thresholdAdjustment = Math.max(thresholdAdjustment, 0.0013);
      aggressionCap = 'passive_only';
      sizingReasonCodes.push('realized_vs_expected_hard_miss');
    }
    if (input.realizedVsExpected != null && input.realizedVsExpected < 0.65) {
      downshiftMultiplier *= 0.5;
      thresholdAdjustment = Math.max(thresholdAdjustment, 0.0022);
      regimePermissionOverride = strongestPermission(
        regimePermissionOverride,
        'block_new_entries',
      );
      sizingReasonCodes.push('realized_vs_expected_critical_miss');
    }

    if (input.executionDrift != null && input.executionDrift < 0) {
      downshiftMultiplier *= 0.92;
      thresholdAdjustment = Math.max(thresholdAdjustment, 0.0004);
      sizingReasonCodes.push('execution_drift_negative');
    }
    if (input.executionDrift != null && input.executionDrift < -0.01) {
      downshiftMultiplier *= 0.8;
      thresholdAdjustment = Math.max(thresholdAdjustment, 0.0012);
      aggressionCap = 'passive_only';
      sizingReasonCodes.push('execution_drift_material');
    }
    if (input.executionDrift != null && input.executionDrift < -0.025) {
      downshiftMultiplier *= 0.55;
      thresholdAdjustment = Math.max(thresholdAdjustment, 0.002);
      regimePermissionOverride = strongestPermission(
        regimePermissionOverride,
        'reduce_only',
      );
      sizingReasonCodes.push('execution_drift_critical');
    }

    if (input.calibrationHealth === 'watch') {
      downshiftMultiplier *= 0.95;
      thresholdAdjustment = Math.max(thresholdAdjustment, 0.0003);
      sizingReasonCodes.push('calibration_watch');
    }
    if (input.calibrationHealth === 'degraded') {
      downshiftMultiplier *= 0.82;
      thresholdAdjustment = Math.max(thresholdAdjustment, 0.001);
      sizingReasonCodes.push('calibration_degraded');
    }
    if (input.calibrationHealth === 'quarantine_candidate') {
      downshiftMultiplier *= 0.55;
      thresholdAdjustment = Math.max(thresholdAdjustment, 0.0018);
      regimePermissionOverride = strongestPermission(
        regimePermissionOverride,
        'reduce_only',
      );
      sizingReasonCodes.push('calibration_quarantine_candidate');
    }

    if (input.regimeDegradation === 'watch') {
      downshiftMultiplier *= 0.96;
      thresholdAdjustment = Math.max(thresholdAdjustment, 0.0002);
      sizingReasonCodes.push('regime_watch');
    }
    if (input.regimeDegradation === 'degraded') {
      downshiftMultiplier *= 0.8;
      thresholdAdjustment = Math.max(thresholdAdjustment, 0.0011);
      sizingReasonCodes.push('regime_degraded');
    }
    if (input.regimeDegradation === 'quarantine_candidate') {
      downshiftMultiplier *= 0.45;
      thresholdAdjustment = Math.max(thresholdAdjustment, 0.0022);
      regimePermissionOverride = strongestPermission(
        regimePermissionOverride,
        'block_new_entries',
      );
      sizingReasonCodes.push('regime_quarantine_candidate');
    }

    if (input.toxicityState === 'elevated') {
      downshiftMultiplier *= 0.92;
      thresholdAdjustment = Math.max(thresholdAdjustment, 0.0006);
      sizingReasonCodes.push('toxicity_elevated');
    }
    if (input.toxicityState === 'high') {
      downshiftMultiplier *= 0.7;
      thresholdAdjustment = Math.max(thresholdAdjustment, 0.0016);
      aggressionCap = 'passive_only';
      sizingReasonCodes.push('toxicity_high');
    }
    if (input.toxicityState === 'blocked') {
      downshiftMultiplier *= 0.3;
      thresholdAdjustment = Math.max(thresholdAdjustment, 0.0028);
      aggressionCap = 'passive_only';
      regimePermissionOverride = strongestPermission(
        regimePermissionOverride,
        'block_new_entries',
      );
      sizingReasonCodes.push('toxicity_blocked');
    }

    if (input.venueUncertainty === 'degraded') {
      downshiftMultiplier *= 0.9;
      thresholdAdjustment = Math.max(thresholdAdjustment, 0.0007);
      sizingReasonCodes.push('venue_uncertainty_degraded');
    }
    if (input.venueUncertainty === 'unsafe') {
      downshiftMultiplier *= 0.55;
      thresholdAdjustment = Math.max(thresholdAdjustment, 0.0018);
      aggressionCap = 'passive_only';
      regimePermissionOverride = strongestPermission(
        regimePermissionOverride,
        'block_new_entries',
      );
      sizingReasonCodes.push('venue_uncertainty_unsafe');
    }

    downshiftMultiplier = clamp(downshiftMultiplier, 0, 1);

    const fullRecoveryReady =
      (input.retentionRatio == null || input.retentionRatio >= 0.95) &&
      (input.realizedVsExpected == null || input.realizedVsExpected >= 0.98) &&
      (input.executionDrift == null || input.executionDrift >= -0.0025) &&
      (input.calibrationHealth == null || input.calibrationHealth === 'healthy') &&
      (input.regimeDegradation == null || input.regimeDegradation === 'healthy') &&
      (input.toxicityState == null || input.toxicityState === 'normal') &&
      (input.venueUncertainty == null || input.venueUncertainty === 'healthy');
    const softRecoveryReady =
      (input.retentionRatio == null || input.retentionRatio >= 0.85) &&
      (input.realizedVsExpected == null || input.realizedVsExpected >= 0.92) &&
      (input.executionDrift == null || input.executionDrift >= -0.008) &&
      (input.calibrationHealth == null ||
        input.calibrationHealth === 'healthy' ||
        input.calibrationHealth === 'watch') &&
      (input.regimeDegradation == null ||
        input.regimeDegradation === 'healthy' ||
        input.regimeDegradation === 'watch') &&
      (input.toxicityState == null ||
        input.toxicityState === 'normal' ||
        input.toxicityState === 'elevated') &&
      input.venueUncertainty !== 'unsafe';

    let upshiftEligibility: LiveFeedbackUpshiftEligibility = 'not_eligible';
    let recoveryProbationState: LiveFeedbackRecoveryProbationState = 'none';
    let recoveryCap = 1;

    if (downshiftMultiplier < 1) {
      upshiftEligibility = 'not_eligible';
      recoveryProbationState = downshiftMultiplier <= 0.55 ? 'extended' : 'active';
      sizingReasonCodes.push(
        recoveryProbationState === 'extended'
          ? 'recovery_probation_extended'
          : 'recovery_probation_active',
      );
    } else if (fullRecoveryReady) {
      upshiftEligibility = 'eligible';
      recoveryProbationState = 'none';
    } else if (softRecoveryReady) {
      upshiftEligibility = 'probationary';
      recoveryProbationState = 'active';
      recoveryCap = 0.9;
      sizingReasonCodes.push('recovery_probation_active');
      sizingReasonCodes.push('slow_recovery_cap_applied');
    } else {
      upshiftEligibility = 'not_eligible';
      recoveryProbationState = 'extended';
      recoveryCap = 0.8;
      sizingReasonCodes.push('recovery_probation_extended');
      sizingReasonCodes.push('slow_recovery_cap_applied');
    }

    const executionQualityAdjustment = clamp(
      Math.min(downshiftMultiplier, recoveryCap),
      0,
      1,
    );
    const evidenceQualityAdjustment = clamp(
      input.evidenceQualityMultiplier ?? 1,
      0,
      1,
    );
    if (evidenceQualityAdjustment < 1) {
      sizingReasonCodes.push('evidence_quality_cap_applied');
    }
    if ((input.trustScore ?? 1) < 0.45) {
      sizingReasonCodes.push('trust_score_not_ready_for_full_size');
    }
    const sizeMultiplier = clamp(
      Math.min(executionQualityAdjustment, evidenceQualityAdjustment),
      0,
      1,
    );
    const reasonCodes = Array.from(new Set(sizingReasonCodes));

    return {
      sizeMultiplier,
      downshiftMultiplier,
      executionQualityAdjustment,
      evidenceQualityAdjustment,
      finalCombinedSizingFeedback: sizeMultiplier,
      upshiftEligibility,
      recoveryProbationState,
      sizingReasonCodes: reasonCodes,
      aggressionCap,
      thresholdAdjustment,
      regimePermissionOverride,
      reasonCodes,
      evidence: {
        retentionRatio: input.retentionRatio,
        calibrationHealth: input.calibrationHealth,
        executionDrift: input.executionDrift,
        regimeDegradation: input.regimeDegradation,
        toxicityState: input.toxicityState,
        venueUncertainty: input.venueUncertainty,
        realizedVsExpected: input.realizedVsExpected,
        downshiftMultiplier,
        recoveryCap,
        trustScore: input.trustScore ?? null,
        evidenceQualityMultiplier: input.evidenceQualityMultiplier ?? null,
        executionQualityAdjustment,
        evidenceQualityAdjustment,
        upshiftEligibility,
        recoveryProbationState,
      },
      capturedAt: new Date().toISOString(),
    };
  }
}

function strongestPermission(
  left: LiveFeedbackRegimePermissionOverride,
  right: LiveFeedbackRegimePermissionOverride,
): LiveFeedbackRegimePermissionOverride {
  const ranking: Record<LiveFeedbackRegimePermissionOverride, number> = {
    unchanged: 0,
    reduce_only: 1,
    block_new_entries: 2,
  };

  return ranking[left] >= ranking[right] ? left : right;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}
