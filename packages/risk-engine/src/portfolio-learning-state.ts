import type {
  PortfolioAllocationDecisionRecord,
  PortfolioAllocationSlice,
  PortfolioConcentrationSignal,
  PortfolioDrawdownState,
  PortfolioLearningSleeveType,
  PortfolioLearningState,
  StrategyCorrelationSignal,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { createDefaultPortfolioLearningState } from '@polymarket-btc-5m-agentic-bot/domain';

export interface PortfolioLearningObservation {
  strategyVariantId: string;
  regime: string | null;
  opportunityClass: string | null;
  allocatedCapital: number;
  expectedEv: number;
  realizedEv: number;
  observedAt: string;
}

export interface PortfolioLearningStateUpdate {
  state: PortfolioLearningState;
  updatedSliceCount: number;
  concentrationWarnings: string[];
}

export class PortfolioLearningStateBuilder {
  update(input: {
    priorState: PortfolioLearningState;
    observations: PortfolioLearningObservation[];
    correlationSignals: Record<string, StrategyCorrelationSignal>;
    now?: Date;
  }): PortfolioLearningStateUpdate {
    const now = input.now ?? new Date();
    const sorted = [...input.observations].sort((left, right) =>
      left.observedAt.localeCompare(right.observedAt),
    );
    const state: PortfolioLearningState = {
      ...createDefaultPortfolioLearningState(),
      ...input.priorState,
      allocationByVariant: mergeSlices(
        input.priorState.allocationByVariant,
        aggregateObservations(sorted, 'variant'),
        now,
      ),
      allocationByRegime: mergeSlices(
        input.priorState.allocationByRegime,
        aggregateObservations(sorted, 'regime'),
        now,
      ),
      allocationByOpportunityClass: mergeSlices(
        input.priorState.allocationByOpportunityClass,
        aggregateObservations(sorted, 'opportunity_class'),
        now,
      ),
      drawdownBySleeve: updateDrawdowns(input.priorState.drawdownBySleeve, sorted, now),
      correlationSignals: {
        ...input.correlationSignals,
      },
      updatedAt: sorted.length > 0 ? now.toISOString() : input.priorState.updatedAt,
      lastCorrelationUpdatedAt:
        Object.keys(input.correlationSignals).length > 0
          ? now.toISOString()
          : input.priorState.lastCorrelationUpdatedAt,
    };

    applyAllocationShares(state.allocationByVariant);
    applyAllocationShares(state.allocationByRegime);
    applyAllocationShares(state.allocationByOpportunityClass);
    state.concentrationSignals = buildConcentrationSignals(state, now);

    return {
      state,
      updatedSliceCount:
        Object.keys(state.allocationByVariant).length +
        Object.keys(state.allocationByRegime).length +
        Object.keys(state.allocationByOpportunityClass).length,
      concentrationWarnings: Object.values(state.concentrationSignals)
        .filter((signal) => signal.severity === 'medium' || signal.severity === 'high')
        .map((signal) => signal.signalKey),
    };
  }
}

export function applyPortfolioAllocationDecisions(
  state: PortfolioLearningState,
  decisions: Record<string, PortfolioAllocationDecisionRecord>,
  now = new Date(),
): PortfolioLearningState {
  const next: PortfolioLearningState = {
    ...state,
    allocationByVariant: { ...state.allocationByVariant },
    allocationDecisions: { ...state.allocationDecisions, ...decisions },
    updatedAt: now.toISOString(),
    lastAllocationUpdatedAt: now.toISOString(),
  };

  for (const decision of Object.values(decisions)) {
    const sliceKey = buildPortfolioSliceKey('variant', decision.strategyVariantId);
    const slice = next.allocationByVariant[sliceKey];
    if (slice) {
      next.allocationByVariant[sliceKey] = {
        ...slice,
        targetMultiplier: decision.targetMultiplier,
        lastUpdatedAt: now.toISOString(),
      };
    }
  }

  return next;
}

export function buildPortfolioSliceKey(
  sleeveType: PortfolioLearningSleeveType,
  sleeveValue: string,
): string {
  return `${sleeveType}:${normalizeKeyPart(sleeveValue)}`;
}

export function buildPortfolioDrawdownKey(
  sleeveType: PortfolioLearningSleeveType,
  sleeveValue: string,
): string {
  return `drawdown:${buildPortfolioSliceKey(sleeveType, sleeveValue)}`;
}

function aggregateObservations(
  observations: PortfolioLearningObservation[],
  sleeveType: PortfolioLearningSleeveType,
): Map<
  string,
  {
    sliceKey: string;
    sleeveValue: string;
    sampleCount: number;
    allocatedCapital: number;
    expectedEvSum: number;
    realizedEvSum: number;
  }
> {
  const aggregated = new Map<
    string,
    {
      sliceKey: string;
      sleeveValue: string;
      sampleCount: number;
      allocatedCapital: number;
      expectedEvSum: number;
      realizedEvSum: number;
    }
  >();

  for (const observation of observations) {
    const sleeveValue = resolveSleeveValue(observation, sleeveType);
    const sliceKey = buildPortfolioSliceKey(sleeveType, sleeveValue);
    const current = aggregated.get(sliceKey) ?? {
      sliceKey,
      sleeveValue,
      sampleCount: 0,
      allocatedCapital: 0,
      expectedEvSum: 0,
      realizedEvSum: 0,
    };
    current.sampleCount += 1;
    current.allocatedCapital += Math.max(0, observation.allocatedCapital);
    current.expectedEvSum += observation.expectedEv;
    current.realizedEvSum += observation.realizedEv;
    aggregated.set(sliceKey, current);
  }

  return aggregated;
}

function mergeSlices(
  prior: Record<string, PortfolioAllocationSlice>,
  current: ReturnType<typeof aggregateObservations>,
  now: Date,
): Record<string, PortfolioAllocationSlice> {
  const next: Record<string, PortfolioAllocationSlice> = { ...prior };

  for (const [sliceKey, aggregate] of current.entries()) {
    const priorSlice = prior[sliceKey];
    const expectedEvSum = (priorSlice?.expectedEvSum ?? 0) + aggregate.expectedEvSum;
    const realizedEvSum = (priorSlice?.realizedEvSum ?? 0) + aggregate.realizedEvSum;
    next[sliceKey] = {
      sliceKey,
      sleeveType: inferSleeveTypeFromSliceKey(sliceKey),
      sleeveValue: aggregate.sleeveValue,
      sampleCount: (priorSlice?.sampleCount ?? 0) + aggregate.sampleCount,
      allocatedCapital: (priorSlice?.allocatedCapital ?? 0) + aggregate.allocatedCapital,
      expectedEvSum,
      realizedEvSum,
      realizedVsExpected:
        Math.abs(expectedEvSum) > 1e-9 ? realizedEvSum / expectedEvSum : null,
      allocationShare: priorSlice?.allocationShare ?? 0,
      targetMultiplier: priorSlice?.targetMultiplier ?? 1,
      lastUpdatedAt: now.toISOString(),
    };
  }

  return next;
}

function updateDrawdowns(
  prior: Record<string, PortfolioDrawdownState>,
  observations: PortfolioLearningObservation[],
  now: Date,
): Record<string, PortfolioDrawdownState> {
  const next = { ...prior };

  for (const observation of observations) {
    for (const sleeveType of ['variant', 'regime', 'opportunity_class'] as const) {
      const sleeveValue = resolveSleeveValue(observation, sleeveType);
      const sleeveKey = buildPortfolioDrawdownKey(sleeveType, sleeveValue);
      const previous = next[sleeveKey] ?? {
        sleeveKey,
        sleeveType,
        sleeveValue,
        realizedEvCumulative: 0,
        peakRealizedEv: 0,
        troughRealizedEv: 0,
        currentDrawdown: 0,
        maxDrawdown: 0,
        lastUpdatedAt: null,
      };
      const realizedEvCumulative = previous.realizedEvCumulative + observation.realizedEv;
      const peakRealizedEv = Math.max(previous.peakRealizedEv, realizedEvCumulative);
      const troughRealizedEv = Math.min(previous.troughRealizedEv, realizedEvCumulative);
      const currentDrawdown = Math.max(0, peakRealizedEv - realizedEvCumulative);
      next[sleeveKey] = {
        ...previous,
        realizedEvCumulative,
        peakRealizedEv,
        troughRealizedEv,
        currentDrawdown,
        maxDrawdown: Math.max(previous.maxDrawdown, currentDrawdown),
        lastUpdatedAt: now.toISOString(),
      };
    }
  }

  return next;
}

function applyAllocationShares(slices: Record<string, PortfolioAllocationSlice>): void {
  const totalAllocatedCapital = Object.values(slices).reduce(
    (sum, slice) => sum + Math.max(0, slice.allocatedCapital),
    0,
  );

  for (const slice of Object.values(slices)) {
    slice.allocationShare =
      totalAllocatedCapital > 0 ? slice.allocatedCapital / totalAllocatedCapital : 0;
  }
}

function buildConcentrationSignals(
  state: PortfolioLearningState,
  now: Date,
): Record<string, PortfolioConcentrationSignal> {
  const signals: Record<string, PortfolioConcentrationSignal> = {};
  const collections = [
    state.allocationByVariant,
    state.allocationByRegime,
    state.allocationByOpportunityClass,
  ];

  for (const collection of collections) {
    for (const slice of Object.values(collection)) {
      const severity =
        slice.allocationShare >= 0.65
          ? 'high'
          : slice.allocationShare >= 0.45
            ? 'medium'
            : slice.allocationShare >= 0.3
              ? 'low'
              : 'none';
      const signalKey = `concentration:${slice.sliceKey}`;
      signals[signalKey] = {
        signalKey,
        sleeveType: slice.sleeveType,
        sleeveValue: slice.sleeveValue,
        allocationShare: slice.allocationShare,
        concentrationScore: slice.allocationShare,
        penaltyMultiplier:
          severity === 'high'
            ? 0.6
            : severity === 'medium'
              ? 0.8
              : severity === 'low'
                ? 0.9
                : 1,
        severity,
        reasons:
          severity === 'none'
            ? ['allocation_concentration_within_limits']
            : [`allocation_share_${Math.round(slice.allocationShare * 100)}pct`],
        lastUpdatedAt: now.toISOString(),
      };
    }
  }

  return signals;
}

function resolveSleeveValue(
  observation: PortfolioLearningObservation,
  sleeveType: PortfolioLearningSleeveType,
): string {
  if (sleeveType === 'variant') {
    return observation.strategyVariantId;
  }
  if (sleeveType === 'regime') {
    return observation.regime ?? 'unknown_regime';
  }
  return observation.opportunityClass ?? 'unknown_opportunity_class';
}

function inferSleeveTypeFromSliceKey(sliceKey: string): PortfolioLearningSleeveType {
  if (sliceKey.startsWith('regime:')) {
    return 'regime';
  }
  if (sliceKey.startsWith('opportunity_class:')) {
    return 'opportunity_class';
  }
  return 'variant';
}

function normalizeKeyPart(value: string): string {
  return value.trim().length > 0 ? value.trim() : 'unknown';
}
