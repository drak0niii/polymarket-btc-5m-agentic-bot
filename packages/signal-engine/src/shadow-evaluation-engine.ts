import type {
  CalibrationState,
  HealthLabel,
  LearningState,
  ShadowEvaluationEvidence,
  StrategyVariantRecord,
  StrategyVariantState,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { createDefaultStrategyVariantState } from '@polymarket-btc-5m-agentic-bot/domain';

export class ShadowEvaluationEngine {
  evaluate(input: {
    candidate: StrategyVariantRecord;
    incumbent: StrategyVariantRecord | null;
    learningState: LearningState;
    now?: Date;
  }): ShadowEvaluationEvidence {
    const now = input.now ?? new Date();
    const candidateState =
      input.learningState.strategyVariants[input.candidate.variantId] ??
      createDefaultStrategyVariantState(input.candidate.variantId);
    const incumbentState =
      input.incumbent &&
      input.learningState.strategyVariants[input.incumbent.variantId]
        ? input.learningState.strategyVariants[input.incumbent.variantId]
        : null;
    const candidateSnapshots = Object.values(candidateState.regimeSnapshots);
    const incumbentSnapshots = incumbentState
      ? Object.values(incumbentState.regimeSnapshots)
      : [];
    const candidateCalibrations = Object.values(input.learningState.calibration).filter(
      (calibration) => calibration.strategyVariantId === input.candidate.variantId,
    );
    const candidateSampleCount = Math.max(
      candidateSnapshots.reduce((sum, snapshot) => sum + snapshot.sampleCount, 0),
      maxCalibrationSample(candidateCalibrations),
    );
    const candidateExpectedEv = candidateSnapshots.reduce(
      (sum, snapshot) => sum + snapshot.expectedEvSum,
      0,
    );
    const candidateRealizedEv = candidateSnapshots.reduce(
      (sum, snapshot) => sum + snapshot.realizedEvSum,
      0,
    );
    const incumbentExpectedEv = incumbentSnapshots.reduce(
      (sum, snapshot) => sum + snapshot.expectedEvSum,
      0,
    );
    const incumbentRealizedEv = incumbentSnapshots.reduce(
      (sum, snapshot) => sum + snapshot.realizedEvSum,
      0,
    );
    const realizedVsExpected =
      Math.abs(candidateExpectedEv) > 1e-9
        ? candidateRealizedEv / candidateExpectedEv
        : null;
    const incumbentRealizedVsExpected =
      Math.abs(incumbentExpectedEv) > 1e-9
        ? incumbentRealizedEv / incumbentExpectedEv
        : null;
    const calibrationHealth = worstHealth(
      candidateCalibrations.map((calibration) => calibration.health),
    );
    const executionHealth = inferExecutionHealth(candidateState, candidateSnapshots);
    const sufficientSample = candidateSampleCount >= 5;
    const reasons: string[] = [];

    if (!sufficientSample) {
      reasons.push('sample_insufficient_for_promotion');
    }
    if (calibrationHealth !== 'healthy') {
      reasons.push(`calibration_health_${calibrationHealth}`);
    }
    if (executionHealth !== 'healthy') {
      reasons.push(`execution_health_${executionHealth}`);
    }
    if (realizedVsExpected == null) {
      reasons.push('realized_vs_expected_unavailable');
    } else if (realizedVsExpected < 1) {
      reasons.push('realized_vs_expected_below_parity');
    } else {
      reasons.push('realized_vs_expected_supportive');
    }

    return {
      variantId: input.candidate.variantId,
      incumbentVariantId: input.incumbent?.variantId ?? null,
      evaluationMode: 'shadow',
      sampleCount: candidateSampleCount,
      calibrationHealth,
      executionHealth,
      realizedVsExpected,
      realizedPnl: candidateRealizedEv,
      improvementVsIncumbent:
        realizedVsExpected != null && incumbentRealizedVsExpected != null
          ? realizedVsExpected - incumbentRealizedVsExpected
          : null,
      sufficientSample,
      reasons,
      evaluatedAt: now.toISOString(),
    };
  }
}

function inferExecutionHealth(
  variantState: StrategyVariantState,
  snapshots: Array<{
    avgFillRate: number;
    avgSlippage: number;
    health: HealthLabel;
  }>,
): HealthLabel {
  const contextHealths = Object.values(variantState.executionLearning.contexts).map(
    (context) => context.health,
  );
  const snapshotHealths = snapshots.map((snapshot) => snapshot.health);
  const avgFillRate =
    snapshots.length > 0
      ? snapshots.reduce((sum, snapshot) => sum + snapshot.avgFillRate, 0) / snapshots.length
      : null;
  const avgSlippage =
    snapshots.length > 0
      ? snapshots.reduce((sum, snapshot) => sum + snapshot.avgSlippage, 0) / snapshots.length
      : null;

  if ((avgFillRate ?? 1) < 0.35 || (avgSlippage ?? 0) > 0.012) {
    return worstHealth(['quarantine_candidate', ...contextHealths, ...snapshotHealths]);
  }
  if ((avgFillRate ?? 1) < 0.55 || (avgSlippage ?? 0) > 0.006) {
    return worstHealth(['degraded', ...contextHealths, ...snapshotHealths]);
  }
  return worstHealth([...contextHealths, ...snapshotHealths]);
}

function maxCalibrationSample(calibrations: CalibrationState[]): number {
  return calibrations.reduce(
    (max, calibration) => Math.max(max, calibration.sampleCount),
    0,
  );
}

function worstHealth(healths: HealthLabel[]): HealthLabel {
  const priority: Record<HealthLabel, number> = {
    healthy: 0,
    watch: 1,
    degraded: 2,
    quarantine_candidate: 3,
  };
  return [...healths].sort((left, right) => priority[right] - priority[left])[0] ?? 'healthy';
}
