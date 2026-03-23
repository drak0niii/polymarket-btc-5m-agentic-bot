import type {
  CalibrationState,
  HealthLabel,
  LearningEvent,
  LearningState,
  LearningTradeSide,
  StrategyVariantState,
} from '@polymarket-btc-5m-agentic-bot/domain';
import {
  createDefaultStrategyVariantState,
  type LearningCycleSummary,
} from '@polymarket-btc-5m-agentic-bot/domain';
import {
  EdgeDecayDetector,
  RegimeEdgeAttribution,
  type RegimeEdgeAttributionTrade,
} from '@polymarket-btc-5m-agentic-bot/risk-engine';
import {
  LiveCalibrationUpdater,
  type CalibrationObservation,
} from '@polymarket-btc-5m-agentic-bot/signal-engine';

export interface LearningCycleSample extends RegimeEdgeAttributionTrade {
  predictedProbability: number;
  realizedOutcome: number;
}

export interface LearningCycleRunnerInput {
  cycleId: string;
  startedAt: Date;
  completedAt: Date;
  analyzedWindow: {
    from: Date;
    to: Date;
  };
  priorState: LearningState;
  samples: LearningCycleSample[];
}

export interface LearningCycleRunnerResult {
  nextState: LearningState;
  summary: LearningCycleSummary;
  events: LearningEvent[];
}

export class LearningCycleRunner {
  private readonly attribution = new RegimeEdgeAttribution();
  private readonly edgeDecayDetector = new EdgeDecayDetector();

  constructor(
    private readonly calibrationUpdater: LiveCalibrationUpdater,
  ) {}

  async run(input: LearningCycleRunnerInput): Promise<LearningCycleRunnerResult> {
    const warnings: string[] = [];
    const errors: string[] = [];
    const events: LearningEvent[] = [];
    const nextState: LearningState = {
      ...input.priorState,
      strategyVariants: {
        ...input.priorState.strategyVariants,
      },
      calibration: {
        ...input.priorState.calibration,
      },
    };

    let attributedSnapshots: ReturnType<RegimeEdgeAttribution['attribute']> = [];
    try {
      attributedSnapshots = this.attribution.attribute(input.samples);
    } catch (error) {
      errors.push(`regime_edge_attribution_failed:${errorMessage(error)}`);
    }

    let assessedSnapshots = attributedSnapshots.map((snapshot) => ({
      ...snapshot,
      decayReasons: [] as string[],
    }));
    try {
      assessedSnapshots = this.edgeDecayDetector.assessAll(attributedSnapshots);
    } catch (error) {
      errors.push(`edge_decay_detection_failed:${errorMessage(error)}`);
    }

    for (const snapshot of assessedSnapshots) {
      this.mergeSnapshotIntoState(nextState, snapshot);
      if (snapshot.health !== 'healthy') {
        events.push({
          id: `${input.cycleId}:decay:${snapshot.key}`,
          type: 'edge_decay_detected',
          severity:
            snapshot.health === 'quarantine_candidate'
              ? 'critical'
              : snapshot.health === 'degraded'
                ? 'warning'
                : 'info',
          createdAt: input.completedAt.toISOString(),
          cycleId: input.cycleId,
          strategyVariantId: snapshot.strategyVariantId,
          contextKey: snapshot.key,
          summary: `Edge health ${snapshot.health} for ${snapshot.key}.`,
          details: {
            sampleCount: snapshot.sampleCount,
            realizedVsExpected: snapshot.realizedVsExpected,
            reasons: snapshot.decayReasons,
          },
        });
      }
    }

    let calibrationUpdates = 0;
    let degradedContexts: string[] = [];
    try {
      const calibrationResult = await this.calibrationUpdater.update(
        input.samples.map(
          (sample): CalibrationObservation => ({
            strategyVariantId: sample.strategyVariantId,
            regime: sample.regime,
            predictedProbability: sample.predictedProbability,
            realizedOutcome: sample.realizedOutcome,
            observedAt: sample.observedAt,
          }),
        ),
        input.cycleId,
        input.completedAt,
      );
      nextState.calibration = calibrationResult.calibration;
      calibrationUpdates = calibrationResult.updates;
      degradedContexts = calibrationResult.degradedContexts;
      events.push(...calibrationResult.events);
    } catch (error) {
      errors.push(`live_calibration_update_failed:${errorMessage(error)}`);
    }

    this.reconcileVariantHealth(nextState);

    const shrinkageActions = Object.values(nextState.calibration).filter(
      (calibration) => calibration.shrinkageFactor < 0.999,
    ).length;

    if (input.samples.length === 0) {
      warnings.push('no_realized_outcomes_in_window');
    }
    if (assessedSnapshots.length === 0) {
      warnings.push('no_regime_snapshots_generated');
    }

    const status =
      errors.length > 0
        ? assessedSnapshots.length > 0 || calibrationUpdates > 0
          ? 'completed_with_warnings'
          : 'failed'
        : warnings.length > 0
          ? 'completed_with_warnings'
          : 'completed';

    const summary: LearningCycleSummary = {
      cycleId: input.cycleId,
      startedAt: input.startedAt.toISOString(),
      completedAt: input.completedAt.toISOString(),
      status,
      analyzedWindow: {
        from: input.analyzedWindow.from.toISOString(),
        to: input.analyzedWindow.to.toISOString(),
      },
      realizedOutcomeCount: input.samples.length,
      attributionSliceCount: assessedSnapshots.length,
      calibrationUpdates,
      shrinkageActions,
      degradedContexts,
      warnings,
      errors,
    };

    nextState.lastCycleStartedAt = summary.startedAt;
    nextState.lastCycleCompletedAt = summary.completedAt;
    nextState.lastCycleSummary = summary;
    nextState.updatedAt = summary.completedAt ?? input.completedAt.toISOString();
    for (const variant of Object.values(nextState.strategyVariants)) {
      variant.lastLearningAt = summary.completedAt;
    }

    events.push({
      id: `${input.cycleId}:${status}`,
      type: status === 'failed' ? 'learning_cycle_failed' : 'learning_cycle_completed',
      severity: status === 'failed' ? 'critical' : status === 'completed' ? 'info' : 'warning',
      createdAt: input.completedAt.toISOString(),
      cycleId: input.cycleId,
      strategyVariantId: null,
      contextKey: null,
      summary: `Learning cycle ${status}.`,
      details: summary as unknown as Record<string, unknown>,
    });

    return {
      nextState,
      summary,
      events,
    };
  }

  private mergeSnapshotIntoState(
    state: LearningState,
    snapshot: ReturnType<EdgeDecayDetector['assessAll']>[number],
  ): void {
    const variant = ensureVariantState(state, snapshot.strategyVariantId);
    variant.regimeSnapshots[snapshot.key] = {
      key: snapshot.key,
      regime: snapshot.regime,
      liquidityBucket: snapshot.liquidityBucket,
      spreadBucket: snapshot.spreadBucket,
      timeToExpiryBucket: snapshot.timeToExpiryBucket,
      entryTimingBucket: snapshot.entryTimingBucket,
      executionStyle: snapshot.executionStyle,
      side: snapshot.side,
      strategyVariantId: snapshot.strategyVariantId,
      sampleCount: snapshot.sampleCount,
      winRate: snapshot.winRate,
      expectedEvSum: snapshot.expectedEvSum,
      realizedEvSum: snapshot.realizedEvSum,
      avgExpectedEv: snapshot.avgExpectedEv,
      avgRealizedEv: snapshot.avgRealizedEv,
      realizedVsExpected: snapshot.realizedVsExpected,
      avgFillRate: snapshot.avgFillRate,
      avgSlippage: snapshot.avgSlippage,
      health: snapshot.health,
      lastObservedAt: snapshot.lastObservedAt,
    };
    variant.lastLearningAt = state.updatedAt;
  }

  private reconcileVariantHealth(state: LearningState): void {
    const calibrationsByVariant = new Map<string, CalibrationState[]>();
    for (const calibration of Object.values(state.calibration)) {
      const list = calibrationsByVariant.get(calibration.strategyVariantId) ?? [];
      list.push(calibration);
      calibrationsByVariant.set(calibration.strategyVariantId, list);
    }

    for (const [variantId, variant] of Object.entries(state.strategyVariants)) {
      const snapshotHealths = Object.values(variant.regimeSnapshots).map((snapshot) => snapshot.health);
      const calibrationHealths = (calibrationsByVariant.get(variantId) ?? []).map(
        (calibration) => calibration.health,
      );
      variant.health = worstHealth([...snapshotHealths, ...calibrationHealths]);
      variant.lastLearningAt = state.lastCycleCompletedAt;
      variant.calibrationContexts = [...new Set((calibrationsByVariant.get(variantId) ?? []).map(
        (calibration) => calibration.contextKey,
      ))].sort();
    }
  }
}

function ensureVariantState(
  state: LearningState,
  strategyVariantId: string,
): StrategyVariantState {
  const existing =
    state.strategyVariants[strategyVariantId] ??
    createDefaultStrategyVariantState(strategyVariantId);
  state.strategyVariants[strategyVariantId] = existing;
  return existing;
}

function worstHealth(healths: HealthLabel[]): HealthLabel {
  const priority: Record<HealthLabel, number> = {
    healthy: 0,
    watch: 1,
    degraded: 2,
    quarantine_candidate: 3,
  };
  return healths.sort((left, right) => priority[right] - priority[left])[0] ?? 'healthy';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
