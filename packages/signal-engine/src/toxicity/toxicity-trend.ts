export interface ToxicityTrendPoint {
  toxicityScore: number;
  toxicityState?: string | null;
  recommendedAction?: string | null;
  capturedAt?: string | null;
}

export interface ToxicityTrendInput {
  currentToxicityScore: number;
  currentCapturedAt?: string | null;
  recentHistory?: ToxicityTrendPoint[] | null;
}

export interface ToxicityTrendOutput {
  toxicityMomentum: number;
  toxicityShock: number;
  toxicityPersistence: number;
  reasons: string[];
  evidence: {
    historyCount: number;
    baselineAverage: number | null;
    trailingAverage: number | null;
    priorPeak: number | null;
    elevatedShare: number;
    highShare: number;
    blockedShare: number;
  };
}

const ELEVATED_THRESHOLD = 0.32;
const HIGH_THRESHOLD = 0.5;
const BLOCKED_THRESHOLD = 0.82;

export class ToxicityTrend {
  evaluate(input: ToxicityTrendInput): ToxicityTrendOutput {
    const history = this.normalizeHistory(input.recentHistory ?? []);
    if (history.length === 0) {
      return {
        toxicityMomentum: 0,
        toxicityShock: 0,
        toxicityPersistence: 0,
        reasons: [],
        evidence: {
          historyCount: 0,
          baselineAverage: null,
          trailingAverage: null,
          priorPeak: null,
          elevatedShare: 0,
          highShare: 0,
          blockedShare: 0,
        },
      };
    }

    const scores = history.map((entry) => entry.toxicityScore);
    const trailingScores = scores.slice(-4);
    const baselineScores = scores.slice(0, Math.max(1, scores.length - trailingScores.length));
    const baselineAverage = average(baselineScores);
    const trailingAverage = average(trailingScores);
    const priorScore = scores[scores.length - 1] ?? 0;
    const priorPeak = max(scores);
    const currentScore = clamp01(input.currentToxicityScore);
    const weightedPersistence = this.weightedPersistence(history);
    const elevatedShare =
      scores.length > 0 ? scores.filter((score) => score >= ELEVATED_THRESHOLD).length / scores.length : 0;
    const highShare =
      scores.length > 0 ? scores.filter((score) => score >= HIGH_THRESHOLD).length / scores.length : 0;
    const blockedShare =
      scores.length > 0 ? scores.filter((score) => score >= BLOCKED_THRESHOLD).length / scores.length : 0;

    const toxicityMomentum = clamp01(
      Math.max(
        0,
        (currentScore - trailingAverage) / 0.18,
        (currentScore - priorScore) / 0.12,
      ),
    );
    const toxicityShock = clamp01(
      Math.max(
        0,
        (currentScore - baselineAverage) / 0.22,
        (currentScore - priorPeak) / 0.1,
      ),
    );
    const toxicityPersistence = clamp01(
      weightedPersistence * 0.72 + elevatedShare * 0.12 + highShare * 0.1 + blockedShare * 0.06,
    );

    const reasons: string[] = [];
    if (toxicityMomentum >= 0.55) {
      reasons.push('toxicity_momentum_rising');
    }
    if (toxicityShock >= 0.55) {
      reasons.push('toxicity_shock_detected');
    }
    if (toxicityPersistence >= 0.55) {
      reasons.push('toxicity_persistence_elevated');
    }

    return {
      toxicityMomentum,
      toxicityShock,
      toxicityPersistence,
      reasons,
      evidence: {
        historyCount: history.length,
        baselineAverage,
        trailingAverage,
        priorPeak,
        elevatedShare,
        highShare,
        blockedShare,
      },
    };
  }

  private normalizeHistory(history: ToxicityTrendPoint[]): ToxicityTrendPoint[] {
    return history
      .map((entry) => ({
        ...entry,
        toxicityScore: clamp01(entry.toxicityScore),
      }))
      .filter((entry) => Number.isFinite(entry.toxicityScore))
      .sort((left, right) => {
        const leftTime = left.capturedAt ? Date.parse(left.capturedAt) : Number.NaN;
        const rightTime = right.capturedAt ? Date.parse(right.capturedAt) : Number.NaN;
        if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
          return leftTime - rightTime;
        }
        if (Number.isFinite(leftTime)) {
          return -1;
        }
        if (Number.isFinite(rightTime)) {
          return 1;
        }
        return 0;
      })
      .slice(-8);
  }

  private weightedPersistence(history: ToxicityTrendPoint[]): number {
    if (history.length === 0) {
      return 0;
    }

    let weightedScore = 0;
    let totalWeight = 0;
    for (let index = 0; index < history.length; index += 1) {
      const entry = history[index];
      if (!entry) {
        continue;
      }
      const recencyWeight = index + 1;
      totalWeight += recencyWeight;
      weightedScore += recencyWeight * this.persistenceContribution(entry);
    }

    return totalWeight > 0 ? weightedScore / totalWeight : 0;
  }

  private persistenceContribution(entry: ToxicityTrendPoint): number {
    const normalizedState = typeof entry.toxicityState === 'string' ? entry.toxicityState : null;
    if (normalizedState === 'blocked') {
      return 1;
    }
    if (normalizedState === 'high') {
      return 0.8;
    }
    if (normalizedState === 'elevated') {
      return 0.55;
    }
    if (entry.toxicityScore >= BLOCKED_THRESHOLD) {
      return 1;
    }
    if (entry.toxicityScore >= HIGH_THRESHOLD) {
      return 0.8;
    }
    if (entry.toxicityScore >= ELEVATED_THRESHOLD) {
      return 0.55;
    }
    return 0;
  }
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function max(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((largest, value) => Math.max(largest, value), Number.NEGATIVE_INFINITY);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}
