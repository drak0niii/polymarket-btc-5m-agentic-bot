import type {
  CalibrationState,
  HealthLabel,
  LearningEvent,
} from '@polymarket-btc-5m-agentic-bot/domain';
import {
  buildCalibrationContextKey,
  LiveCalibrationStore,
} from './live-calibration-store';

export interface CalibrationObservation {
  strategyVariantId: string;
  regime: string | null;
  predictedProbability: number;
  realizedOutcome: number;
  observedAt: string;
}

export interface CalibrationUpdateResult {
  calibration: Record<string, CalibrationState>;
  events: LearningEvent[];
  updates: number;
  degradedContexts: string[];
}

export class LiveCalibrationUpdater {
  constructor(private readonly store: LiveCalibrationStore) {}

  async update(
    observations: CalibrationObservation[],
    cycleId: string,
    now = new Date(),
  ): Promise<CalibrationUpdateResult> {
    const existing = await this.store.getAll();
    const grouped = new Map<string, CalibrationObservation[]>();

    for (const observation of observations) {
      const keys = [
        buildCalibrationContextKey(observation.strategyVariantId, observation.regime),
        buildCalibrationContextKey(observation.strategyVariantId, null),
      ];
      for (const key of keys) {
        const list = grouped.get(key) ?? [];
        list.push(observation);
        grouped.set(key, list);
      }
    }

    const nextCalibration: Record<string, CalibrationState> = {
      ...existing,
    };
    const events: LearningEvent[] = [];
    const degradedContexts: string[] = [];
    let updates = 0;

    for (const [contextKey, contextObservations] of [...grouped.entries()].sort((left, right) =>
      left[0].localeCompare(right[0]),
    )) {
      const first = contextObservations[0];
      if (!first) {
        continue;
      }

      const predicted = contextObservations.map((item) => clampProbability(item.predictedProbability));
      const realized = contextObservations.map((item) => (item.realizedOutcome > 0 ? 1 : 0));
      const sampleCount = contextObservations.length;
      const brierScore =
        predicted.reduce((sum, value, index) => sum + (value - realized[index]!) ** 2, 0) /
        sampleCount;
      const logLoss =
        predicted.reduce(
          (sum, value, index) =>
            sum - (realized[index]! * Math.log(value) + (1 - realized[index]!) * Math.log(1 - value)),
          0,
        ) / sampleCount;
      const overconfidenceScore =
        predicted.reduce((sum, value, index) => {
          const realizedConfidence = realized[index] === 1 ? 1 : 0;
          return sum + Math.max(0, Math.abs(value - 0.5) * 2 - realizedConfidence);
        }, 0) / sampleCount;

      const previous = existing[contextKey];
      const health = inferCalibrationHealth(sampleCount, brierScore, logLoss, overconfidenceScore);
      const shrinkageFactor = inferShrinkageFactor(health, brierScore, logLoss, overconfidenceScore);
      const driftSignals = collectDriftSignals(brierScore, logLoss, overconfidenceScore);
      const version = (previous?.version ?? 0) + 1;
      const nextState: CalibrationState = {
        contextKey,
        strategyVariantId: first.strategyVariantId,
        regime: contextKey.includes('|regime:all')
          ? null
          : (first.regime ?? 'unknown_regime'),
        sampleCount,
        brierScore,
        logLoss,
        shrinkageFactor,
        overconfidenceScore,
        health,
        version,
        driftSignals,
        lastUpdatedAt: now.toISOString(),
      };

      nextCalibration[contextKey] = nextState;
      updates += 1;
      if (health === 'degraded' || health === 'quarantine_candidate') {
        degradedContexts.push(contextKey);
      }

      const changedShrinkage =
        previous == null || Math.abs(previous.shrinkageFactor - shrinkageFactor) >= 0.01;
      const severity =
        health === 'quarantine_candidate'
          ? 'critical'
          : health === 'degraded'
            ? 'warning'
            : 'info';

      events.push({
        id: `${cycleId}:calibration:${contextKey}`,
        type: 'calibration_updated',
        severity,
        createdAt: now.toISOString(),
        cycleId,
        strategyVariantId: first.strategyVariantId,
        contextKey,
        summary: `Calibration updated for ${contextKey}.`,
        details: {
          sampleCount,
          brierScore,
          logLoss,
          overconfidenceScore,
          health,
          shrinkageFactor,
          driftSignals,
        },
      });

      if (changedShrinkage) {
        events.push({
          id: `${cycleId}:shrinkage:${contextKey}`,
          type: 'confidence_shrinkage_changed',
          severity,
          createdAt: now.toISOString(),
          cycleId,
          strategyVariantId: first.strategyVariantId,
          contextKey,
          summary: `Confidence shrinkage changed for ${contextKey}.`,
          details: {
            previousShrinkageFactor: previous?.shrinkageFactor ?? null,
            shrinkageFactor,
            health,
          },
        });
      }
    }

    return {
      calibration: nextCalibration,
      events,
      updates,
      degradedContexts,
    };
  }
}

function inferCalibrationHealth(
  sampleCount: number,
  brierScore: number,
  logLoss: number,
  overconfidenceScore: number,
): HealthLabel {
  if (sampleCount >= 8 && (brierScore >= 0.35 || logLoss >= 0.9 || overconfidenceScore >= 0.35)) {
    return 'quarantine_candidate';
  }

  if (sampleCount >= 5 && (brierScore >= 0.25 || logLoss >= 0.75 || overconfidenceScore >= 0.2)) {
    return 'degraded';
  }

  if (sampleCount >= 3 && (brierScore >= 0.18 || logLoss >= 0.6 || overconfidenceScore >= 0.12)) {
    return 'watch';
  }

  return 'healthy';
}

function inferShrinkageFactor(
  health: HealthLabel,
  brierScore: number,
  logLoss: number,
  overconfidenceScore: number,
): number {
  const softPenalty = Math.max(0, brierScore - 0.1) + Math.max(0, logLoss - 0.4) * 0.5 + overconfidenceScore;
  const base =
    health === 'quarantine_candidate'
      ? 0.35
      : health === 'degraded'
        ? 0.6
        : health === 'watch'
          ? 0.82
          : 1;
  return clampFactor(base - Math.min(0.25, softPenalty * 0.1));
}

function collectDriftSignals(
  brierScore: number,
  logLoss: number,
  overconfidenceScore: number,
): string[] {
  const signals: string[] = [];
  if (brierScore >= 0.18) {
    signals.push('brier_deterioration');
  }
  if (logLoss >= 0.6) {
    signals.push('log_loss_deterioration');
  }
  if (overconfidenceScore >= 0.12) {
    signals.push('overconfidence_detected');
  }
  if (signals.length === 0) {
    signals.push('calibration_stable');
  }
  return signals;
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.max(0.0001, Math.min(0.9999, value));
}

function clampFactor(value: number): number {
  return Math.max(0.2, Math.min(1, value));
}
