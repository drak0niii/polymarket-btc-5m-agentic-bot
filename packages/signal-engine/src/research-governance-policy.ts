import type { ResearchGovernanceRecord } from '@polymarket-btc-5m-agentic-bot/domain';
import type { WalkForwardValidationResult } from './walk-forward-validator';

export class ResearchGovernancePolicy {
  evaluate(input: {
    strategyVersionId: string | null;
    edgeDefinitionVersion: string;
    validation: WalkForwardValidationResult;
  }): ResearchGovernanceRecord {
    const failReasons: string[] = [];
    if (!input.validation.sufficientSamples) {
      failReasons.push('insufficient_samples');
    }
    if (!input.validation.leakagePrevented) {
      failReasons.push('future_leakage_detected');
    }
    if (!input.validation.tradeAllowed) {
      failReasons.push('walk_forward_not_tradeable');
    }
    if ((input.validation.aggregate.realizedVsExpected ?? 0) <= 0) {
      failReasons.push('realized_vs_expected_non_positive');
    }
    if ((input.validation.maxCalibrationGap ?? 1) > 0.18) {
      failReasons.push('calibration_gap_too_wide');
    }
    if ((input.validation.segmentCoverage ?? 0) < 0.2) {
      failReasons.push('segmentation_coverage_too_thin');
    }

    return {
      strategyVersionId: input.strategyVersionId,
      edgeDefinitionVersion: input.edgeDefinitionVersion,
      windowSpec: input.validation.windowSpec,
      segmentation: input.validation.segmentation,
      calibration: input.validation.calibration,
      costModelVersion: input.validation.costModelVersion,
      calibrationVersion: input.validation.calibrationVersion,
      confidence: input.validation.confidence,
      promotionEligible: failReasons.length === 0,
      failReasons,
      createdAt: input.validation.capturedAt,
    };
  }
}
