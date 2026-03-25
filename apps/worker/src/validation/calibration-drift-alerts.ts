export type CalibrationDriftState = 'stable' | 'watch' | 'alert';

export interface CalibrationDriftObservation {
  regime?: string | null;
  archetype?: string | null;
  predictedProbability: number | null;
  realizedOutcome: number | null;
}

export interface CalibrationDriftAlertEntry {
  contextType: 'regime' | 'archetype';
  contextValue: string;
  sampleCount: number;
  averagePredictedProbability: number;
  realizedOutcomeRate: number;
  averageCalibrationGap: number;
  absoluteCalibrationGap: number;
  calibrationDriftState: CalibrationDriftState;
  driftReasonCodes: string[];
}

export interface CalibrationDriftAlertsReport {
  generatedAt: string;
  sampleCount: number;
  calibrationDriftState: CalibrationDriftState;
  regimeCalibrationAlert: CalibrationDriftAlertEntry[];
  archetypeCalibrationAlert: CalibrationDriftAlertEntry[];
  driftReasonCodes: string[];
}

export function buildCalibrationDriftAlerts(input: {
  observations: CalibrationDriftObservation[];
  now?: Date;
}): CalibrationDriftAlertsReport {
  const generatedAt = (input.now ?? new Date()).toISOString();
  const normalized = input.observations
    .map(normalizeObservation)
    .filter((entry): entry is NormalizedObservation => entry != null);
  const regimeCalibrationAlert = buildAlerts(normalized, 'regime');
  const archetypeCalibrationAlert = buildAlerts(normalized, 'archetype');
  const allAlerts = [...regimeCalibrationAlert, ...archetypeCalibrationAlert];
  const driftReasonCodes = [...new Set(allAlerts.flatMap((entry) => entry.driftReasonCodes))];

  return {
    generatedAt,
    sampleCount: normalized.length,
    calibrationDriftState: summarizeState(allAlerts),
    regimeCalibrationAlert,
    archetypeCalibrationAlert,
    driftReasonCodes,
  };
}

interface NormalizedObservation {
  regime: string;
  archetype: string;
  predictedProbability: number;
  realizedOutcome: number;
}

function normalizeObservation(
  observation: CalibrationDriftObservation,
): NormalizedObservation | null {
  const predictedProbability = normalizeProbability(observation.predictedProbability);
  const realizedOutcome = normalizeOutcome(observation.realizedOutcome);
  if (predictedProbability == null || realizedOutcome == null) {
    return null;
  }

  return {
    regime: normalizeLabel(observation.regime),
    archetype: normalizeLabel(observation.archetype),
    predictedProbability,
    realizedOutcome,
  };
}

function buildAlerts(
  observations: NormalizedObservation[],
  contextType: 'regime' | 'archetype',
): CalibrationDriftAlertEntry[] {
  const grouped = new Map<string, NormalizedObservation[]>();
  for (const observation of observations) {
    const key = contextType === 'regime' ? observation.regime : observation.archetype;
    const bucket = grouped.get(key) ?? [];
    bucket.push(observation);
    grouped.set(key, bucket);
  }

  return Array.from(grouped.entries())
    .map(([contextValue, entries]) => {
      const averagePredictedProbability = average(
        entries.map((entry) => entry.predictedProbability),
      );
      const realizedOutcomeRate = average(entries.map((entry) => entry.realizedOutcome));
      const averageCalibrationGap = realizedOutcomeRate - averagePredictedProbability;
      const absoluteCalibrationGap = Math.abs(averageCalibrationGap);

      return {
        contextType,
        contextValue,
        sampleCount: entries.length,
        averagePredictedProbability,
        realizedOutcomeRate,
        averageCalibrationGap,
        absoluteCalibrationGap,
        calibrationDriftState: classifyState(entries.length, absoluteCalibrationGap),
        driftReasonCodes: buildReasonCodes({
          sampleCount: entries.length,
          averageCalibrationGap,
          absoluteCalibrationGap,
        }),
      };
    })
    .sort(compareAlerts);
}

function buildReasonCodes(input: {
  sampleCount: number;
  averageCalibrationGap: number;
  absoluteCalibrationGap: number;
}): string[] {
  const reasonCodes: string[] = [];
  if (input.sampleCount < 3) {
    reasonCodes.push('insufficient_context_samples');
  }
  if (input.absoluteCalibrationGap >= 0.18) {
    reasonCodes.push('absolute_gap_alert');
  } else if (input.absoluteCalibrationGap >= 0.1) {
    reasonCodes.push('absolute_gap_watch');
  }
  if (input.averageCalibrationGap <= -0.12) {
    reasonCodes.push('overprediction_drift');
  } else if (input.averageCalibrationGap >= 0.12) {
    reasonCodes.push('underprediction_drift');
  }
  return reasonCodes;
}

function classifyState(
  sampleCount: number,
  absoluteCalibrationGap: number,
): CalibrationDriftState {
  if (sampleCount >= 4 && absoluteCalibrationGap >= 0.18) {
    return 'alert';
  }
  if (sampleCount >= 2 && absoluteCalibrationGap >= 0.1) {
    return 'watch';
  }
  return 'stable';
}

function summarizeState(
  alerts: CalibrationDriftAlertEntry[],
): CalibrationDriftState {
  if (alerts.some((entry) => entry.calibrationDriftState === 'alert')) {
    return 'alert';
  }
  if (alerts.some((entry) => entry.calibrationDriftState === 'watch')) {
    return 'watch';
  }
  return 'stable';
}

function compareAlerts(
  left: CalibrationDriftAlertEntry,
  right: CalibrationDriftAlertEntry,
): number {
  const stateScore =
    driftStateScore(right.calibrationDriftState) -
    driftStateScore(left.calibrationDriftState);
  if (stateScore !== 0) {
    return stateScore;
  }
  const gapScore = right.absoluteCalibrationGap - left.absoluteCalibrationGap;
  if (Math.abs(gapScore) > 1e-9) {
    return gapScore;
  }
  return right.sampleCount - left.sampleCount;
}

function driftStateScore(state: CalibrationDriftState): number {
  switch (state) {
    case 'alert':
      return 2;
    case 'watch':
      return 1;
    case 'stable':
    default:
      return 0;
  }
}

function normalizeProbability(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeOutcome(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeLabel(value: string | null | undefined): string {
  if (typeof value !== 'string') {
    return 'unknown';
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : 'unknown';
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
