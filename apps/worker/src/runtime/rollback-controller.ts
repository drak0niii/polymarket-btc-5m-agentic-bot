import type {
  HealthLabel,
  LearningState,
  StrategyDeploymentRegistryState,
  StrategyRollbackRecord,
} from '@polymarket-btc-5m-agentic-bot/domain';

export class RollbackController {
  evaluate(input: {
    registry: StrategyDeploymentRegistryState;
    learningState: LearningState;
    now?: Date;
  }): StrategyRollbackRecord | null {
    const now = input.now ?? new Date();
    const activeRollout = input.registry.activeRollout;
    if (!activeRollout?.challengerVariantId) {
      return null;
    }

    const challengerState =
      input.learningState.strategyVariants[activeRollout.challengerVariantId] ?? null;
    if (!challengerState) {
      return null;
    }

    const calibrations = Object.values(input.learningState.calibration).filter(
      (calibration) => calibration.strategyVariantId === activeRollout.challengerVariantId,
    );
    const calibrationHealth = worstHealth(calibrations.map((calibration) => calibration.health));
    const executionHealth = worstHealth(
      Object.values(challengerState.executionLearning.contexts).map((context) => context.health),
    );
    const snapshots = Object.values(challengerState.regimeSnapshots);
    const expectedEv = snapshots.reduce((sum, snapshot) => sum + snapshot.expectedEvSum, 0);
    const realizedEv = snapshots.reduce((sum, snapshot) => sum + snapshot.realizedEvSum, 0);
    const realizedVsExpected =
      Math.abs(expectedEv) > 1e-9 ? realizedEv / expectedEv : null;
    const highSeverityQuarantine = Object.values(input.registry.quarantines).find(
      (record) =>
        record.scope.variantId === activeRollout.challengerVariantId &&
        record.severity === 'high',
    );

    if (highSeverityQuarantine) {
      return buildRollbackRecord(
        'quarantine_escalation',
        activeRollout.challengerVariantId,
        activeRollout.incumbentVariantId,
        [highSeverityQuarantine.reasonCode],
        now,
      );
    }

    if (calibrationHealth === 'quarantine_candidate') {
      return buildRollbackRecord(
        'calibration_collapse',
        activeRollout.challengerVariantId,
        activeRollout.incumbentVariantId,
        ['calibration_health_quarantine_candidate'],
        now,
      );
    }

    if (executionHealth === 'quarantine_candidate') {
      return buildRollbackRecord(
        'execution_deterioration',
        activeRollout.challengerVariantId,
        activeRollout.incumbentVariantId,
        ['execution_health_quarantine_candidate'],
        now,
      );
    }

    if (realizedVsExpected != null && realizedVsExpected < 0.5) {
      return buildRollbackRecord(
        'realized_ev_collapse',
        activeRollout.challengerVariantId,
        activeRollout.incumbentVariantId,
        [`realized_vs_expected=${realizedVsExpected.toFixed(4)}`],
        now,
      );
    }

    if (realizedEv < -0.05) {
      return buildRollbackRecord(
        'unexplained_drawdown',
        activeRollout.challengerVariantId,
        activeRollout.incumbentVariantId,
        [`realized_ev=${realizedEv.toFixed(4)}`],
        now,
      );
    }

    return null;
  }
}

function buildRollbackRecord(
  trigger: StrategyRollbackRecord['trigger'],
  fromVariantId: string,
  toVariantId: string | null,
  reasons: string[],
  now: Date,
): StrategyRollbackRecord {
  return {
    rollbackId: ['rollback', fromVariantId, trigger, now.toISOString()].join(':'),
    trigger,
    fromVariantId,
    toVariantId,
    reasons,
    createdAt: now.toISOString(),
  };
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
