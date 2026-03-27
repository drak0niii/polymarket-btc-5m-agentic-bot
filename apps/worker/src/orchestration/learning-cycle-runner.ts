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
    const nextState: LearningState = cloneLearningState(input.priorState);
    const samples = normalizeLearningCycleSamples(input.samples);

    let attributedSnapshots: ReturnType<RegimeEdgeAttribution['attribute']> = [];
    try {
      attributedSnapshots = this.attribution
        .attribute(samples)
        .sort((left, right) => left.key.localeCompare(right.key));
    } catch (error) {
      errors.push(`regime_edge_attribution_failed:${errorMessage(error)}`);
    }

    let assessedSnapshots = attributedSnapshots.map((snapshot) => ({
      ...snapshot,
      decayReasons: [] as string[],
    }));
    try {
      assessedSnapshots = this.edgeDecayDetector
        .assessAll(attributedSnapshots)
        .sort((left, right) => left.key.localeCompare(right.key));
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
        samples.map(
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
      degradedContexts = dedupeAndSortStrings(calibrationResult.degradedContexts);
      events.push(...calibrationResult.events);
    } catch (error) {
      errors.push(`live_calibration_update_failed:${errorMessage(error)}`);
    }

    this.reconcileVariantHealth(nextState);

    const shrinkageActions = Object.values(nextState.calibration).filter(
      (calibration) => calibration.shrinkageFactor < 0.999,
    ).length;

    if (samples.length === 0) {
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
      realizedOutcomeCount: samples.length,
      attributionSliceCount: assessedSnapshots.length,
      calibrationUpdates,
      shrinkageActions,
      degradedContexts,
      warnings: dedupeAndSortStrings(warnings),
      errors: dedupeAndSortStrings(errors),
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
      events: sortLearningEvents(events),
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

function normalizeLearningCycleSamples(
  samples: LearningCycleSample[],
): LearningCycleSample[] {
  return [...samples]
    .map((sample) => ({
      ...sample,
      strategyVariantId: normalizeString(sample.strategyVariantId, 'unknown_strategy_variant'),
      regime: normalizeNullableString(sample.regime),
      side: sample.side ?? 'unknown',
      expectedEv: finiteOrZero(sample.expectedEv),
      realizedEv: finiteOrZero(sample.realizedEv),
      fillRate: finiteOrNull(sample.fillRate),
      realizedSlippage: finiteOrNull(sample.realizedSlippage),
      liquidityDepth: finiteOrNull(sample.liquidityDepth),
      spread: finiteOrNull(sample.spread),
      timeToExpirySeconds: finiteOrNull(sample.timeToExpirySeconds),
      entryDelayMs: finiteOrNull(sample.entryDelayMs),
      executionStyle: sample.executionStyle ?? 'unknown',
      observedAt: normalizeString(sample.observedAt, new Date(0).toISOString()),
      predictedProbability: clampProbability(sample.predictedProbability),
      realizedOutcome: sample.realizedOutcome > 0 ? 1 : 0,
    }))
    .sort(compareLearningCycleSamples);
}

function compareLearningCycleSamples(
  left: LearningCycleSample,
  right: LearningCycleSample,
): number {
  return (
    compareStrings(left.strategyVariantId, right.strategyVariantId) ||
    compareNullableStrings(left.regime, right.regime) ||
    compareStrings(left.observedAt, right.observedAt) ||
    compareStrings(left.side, right.side) ||
    compareStrings(left.executionStyle, right.executionStyle) ||
    compareNumbers(left.expectedEv, right.expectedEv) ||
    compareNumbers(left.realizedEv, right.realizedEv) ||
    compareNullableNumbers(left.fillRate, right.fillRate) ||
    compareNullableNumbers(left.realizedSlippage, right.realizedSlippage) ||
    compareNullableNumbers(left.liquidityDepth, right.liquidityDepth) ||
    compareNullableNumbers(left.spread, right.spread) ||
    compareNullableNumbers(left.timeToExpirySeconds, right.timeToExpirySeconds) ||
    compareNullableNumbers(left.entryDelayMs, right.entryDelayMs) ||
    compareNumbers(left.predictedProbability, right.predictedProbability) ||
    compareNumbers(left.realizedOutcome, right.realizedOutcome)
  );
}

function sortLearningEvents(events: LearningEvent[]): LearningEvent[] {
  return [...events].sort((left, right) => {
    return (
      compareStrings(left.createdAt, right.createdAt) ||
      compareNumbers(eventTypePriority(left.type), eventTypePriority(right.type)) ||
      compareNullableStrings(left.strategyVariantId, right.strategyVariantId) ||
      compareNullableStrings(left.contextKey, right.contextKey) ||
      compareStrings(left.id, right.id)
    );
  });
}

function eventTypePriority(type: LearningEvent['type']): number {
  switch (type) {
    case 'edge_decay_detected':
      return 10;
    case 'calibration_updated':
      return 20;
    case 'confidence_shrinkage_changed':
      return 30;
    case 'learning_cycle_completed':
      return 90;
    case 'learning_cycle_failed':
      return 100;
    default:
      return 50;
  }
}

function cloneLearningState(state: LearningState): LearningState {
  return JSON.parse(JSON.stringify(state)) as LearningState;
}

function dedupeAndSortStrings(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizeString(value: string | null | undefined, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function normalizeNullableString(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function compareNullableStrings(left: string | null, right: string | null): number {
  if (left == null && right == null) {
    return 0;
  }
  if (left == null) {
    return -1;
  }
  if (right == null) {
    return 1;
  }
  return left.localeCompare(right);
}

function compareNumbers(left: number, right: number): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function compareNullableNumbers(left: number | null, right: number | null): number {
  if (left == null && right == null) {
    return 0;
  }
  if (left == null) {
    return -1;
  }
  if (right == null) {
    return 1;
  }
  return compareNumbers(left, right);
}

function finiteOrZero(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.max(0.0001, Math.min(0.9999, value));
}
