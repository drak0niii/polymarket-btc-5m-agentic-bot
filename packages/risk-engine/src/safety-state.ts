export type SafetyState =
  | 'normal'
  | 'reduced_size'
  | 'reduced_frequency'
  | 'passive_only'
  | 'no_new_entries'
  | 'halt';

export interface SafetyStateControls {
  state: SafetyState;
  sizeMultiplier: number;
  evaluationCadenceMultiplier: number;
  allowAggressiveEntries: boolean;
  allowNewEntries: boolean;
  haltRequested: boolean;
  maxNewSignalsPerTick: number;
}

const SAFETY_STATE_RANK: Record<SafetyState, number> = {
  normal: 0,
  reduced_size: 1,
  reduced_frequency: 2,
  passive_only: 3,
  no_new_entries: 4,
  halt: 5,
};

export function compareSafetyStateSeverity(left: SafetyState, right: SafetyState): number {
  return SAFETY_STATE_RANK[left] - SAFETY_STATE_RANK[right];
}

export function maxSafetyState(left: SafetyState, right: SafetyState): SafetyState {
  return compareSafetyStateSeverity(left, right) >= 0 ? left : right;
}

export function controlsForSafetyState(state: SafetyState): SafetyStateControls {
  if (state === 'reduced_size') {
    return {
      state,
      sizeMultiplier: 0.65,
      evaluationCadenceMultiplier: 1,
      allowAggressiveEntries: true,
      allowNewEntries: true,
      haltRequested: false,
      maxNewSignalsPerTick: 2,
    };
  }

  if (state === 'reduced_frequency') {
    return {
      state,
      sizeMultiplier: 0.8,
      evaluationCadenceMultiplier: 2,
      allowAggressiveEntries: true,
      allowNewEntries: true,
      haltRequested: false,
      maxNewSignalsPerTick: 1,
    };
  }

  if (state === 'passive_only') {
    return {
      state,
      sizeMultiplier: 0.55,
      evaluationCadenceMultiplier: 2,
      allowAggressiveEntries: false,
      allowNewEntries: true,
      haltRequested: false,
      maxNewSignalsPerTick: 1,
    };
  }

  if (state === 'no_new_entries') {
    return {
      state,
      sizeMultiplier: 0,
      evaluationCadenceMultiplier: 3,
      allowAggressiveEntries: false,
      allowNewEntries: false,
      haltRequested: false,
      maxNewSignalsPerTick: 0,
    };
  }

  if (state === 'halt') {
    return {
      state,
      sizeMultiplier: 0,
      evaluationCadenceMultiplier: 10,
      allowAggressiveEntries: false,
      allowNewEntries: false,
      haltRequested: true,
      maxNewSignalsPerTick: 0,
    };
  }

  return {
    state: 'normal',
    sizeMultiplier: 1,
    evaluationCadenceMultiplier: 1,
    allowAggressiveEntries: true,
    allowNewEntries: true,
    haltRequested: false,
    maxNewSignalsPerTick: 4,
  };
}
