import type { SignalFeatures } from '../feature-builder';
import { AdverseSelectionRisk } from './adverse-selection-risk';
import { BookInstabilityScore } from './book-instability-score';
import { FlowToxicityScore } from './flow-toxicity-score';
import { ToxicityTrend, type ToxicityTrendPoint } from './toxicity-trend';

export type ToxicityState = 'normal' | 'elevated' | 'high' | 'blocked';
export type ToxicityRecommendedAction =
  | 'no_change'
  | 'widen_threshold'
  | 'reduce_size'
  | 'disable_aggressive_execution'
  | 'temporarily_block_regime';
export type ExecutionAggressionLock = 'none' | 'passive_only';

export interface ToxicityPolicyInput {
  features: Pick<
    SignalFeatures,
    | 'flowImbalanceProxy'
    | 'flowIntensity'
    | 'micropriceBias'
    | 'btcMoveTransmission'
    | 'signalDecayPressure'
    | 'bookUpdateStress'
    | 'orderbookNoiseScore'
    | 'spread'
    | 'spreadToDepthRatio'
    | 'topLevelDepth'
    | 'timeToExpirySeconds'
    | 'lastReturnPct'
    | 'rollingReturnPct'
    | 'marketStateTransition'
  >;
  regimeLabel?: string | null;
  structuralToxicityBias?: number | null;
  signalAgeMs?: number | null;
  recentHistory?: ToxicityTrendPoint[] | null;
}

export interface ToxicityPolicyDecision {
  toxicityScore: number;
  bookInstabilityScore: number;
  adverseSelectionRisk: number;
  toxicityMomentum: number;
  toxicityShock: number;
  toxicityPersistence: number;
  toxicityState: ToxicityState;
  recommendedAction: ToxicityRecommendedAction;
  executionAggressionLock: ExecutionAggressionLock;
  passiveOnly: boolean;
  aggressionReasonCodes: string[];
  thresholdMultiplier: number;
  sizeMultiplier: number;
  posteriorPenalty: number;
  disableAggressiveExecution: boolean;
  temporarilyBlockRegime: boolean;
  reasons: string[];
  evidence: Record<string, unknown>;
  capturedAt: string;
}

export class ToxicityPolicy {
  private readonly flowToxicityScore = new FlowToxicityScore();
  private readonly bookInstabilityScore = new BookInstabilityScore();
  private readonly adverseSelectionRisk = new AdverseSelectionRisk();
  private readonly toxicityTrend = new ToxicityTrend();

  evaluate(input: ToxicityPolicyInput): ToxicityPolicyDecision {
    const flow = this.flowToxicityScore.score(input.features);
    const book = this.bookInstabilityScore.score(input.features);
    const adverseSelection = this.adverseSelectionRisk.evaluate({
      flowToxicityScore: flow.toxicityScore,
      bookInstabilityScore: book.bookInstabilityScore,
      micropriceBias: input.features.micropriceBias,
      lastReturnPct: input.features.lastReturnPct,
      rollingReturnPct: input.features.rollingReturnPct,
      signalDecayPressure: input.features.signalDecayPressure,
      marketStateTransition: input.features.marketStateTransition,
      timeToExpirySeconds: input.features.timeToExpirySeconds,
    });
    const signalAgePressure =
      input.signalAgeMs != null ? clamp01(input.signalAgeMs / 45_000) * 0.08 : 0;
    const regimeBias = this.resolveRegimeBias(
      input.regimeLabel ?? null,
      input.structuralToxicityBias ?? null,
    );
    const baseToxicityScore = clamp01(
      flow.toxicityScore * 0.34 +
        book.bookInstabilityScore * 0.33 +
        adverseSelection.adverseSelectionRisk * 0.33 +
        signalAgePressure +
        regimeBias,
    );
    const trend = this.toxicityTrend.evaluate({
      currentToxicityScore: baseToxicityScore,
      recentHistory: input.recentHistory,
    });
    const trendPenalty =
      trend.toxicityMomentum * 0.08 +
      trend.toxicityShock * 0.1 +
      trend.toxicityPersistence * 0.12;
    const toxicityScore = clamp01(baseToxicityScore + trendPenalty);
    const reasons = Array.from(
      new Set([
        ...flow.reasons,
        ...book.reasons,
        ...adverseSelection.reasons,
        ...trend.reasons,
        ...(signalAgePressure >= 0.05 ? ['signal_age_pressure_elevated'] : []),
        ...(regimeBias >= 0.08 ? ['regime_structurally_toxic'] : []),
        ...(trendPenalty >= 0.08 ? ['toxicity_trend_penalty_applied'] : []),
      ]),
    );

    if (toxicityScore >= 0.82) {
      return this.decision(
        input,
        toxicityScore,
        book.bookInstabilityScore,
        adverseSelection.adverseSelectionRisk,
        trend.toxicityMomentum,
        trend.toxicityShock,
        trend.toxicityPersistence,
        'blocked',
        'temporarily_block_regime',
        'passive_only',
        true,
        ['toxicity_state_blocked', 'toxicity_aggression_lock_passive_only'],
        1.8,
        0.2,
        0.03,
        true,
        true,
        reasons,
      );
    }

    if (toxicityScore >= 0.68) {
      return this.decision(
        input,
        toxicityScore,
        book.bookInstabilityScore,
        adverseSelection.adverseSelectionRisk,
        trend.toxicityMomentum,
        trend.toxicityShock,
        trend.toxicityPersistence,
        'high',
        'disable_aggressive_execution',
        'passive_only',
        true,
        ['toxicity_state_high', 'toxicity_aggression_lock_passive_only'],
        1.45,
        0.55,
        0.02,
        true,
        false,
        reasons,
      );
    }

    if (toxicityScore >= 0.5) {
      return this.decision(
        input,
        toxicityScore,
        book.bookInstabilityScore,
        adverseSelection.adverseSelectionRisk,
        trend.toxicityMomentum,
        trend.toxicityShock,
        trend.toxicityPersistence,
        'high',
        'reduce_size',
        'none',
        false,
        [],
        1.25,
        0.72,
        0.012,
        false,
        false,
        reasons,
      );
    }

    if (toxicityScore >= 0.32) {
      return this.decision(
        input,
        toxicityScore,
        book.bookInstabilityScore,
        adverseSelection.adverseSelectionRisk,
        trend.toxicityMomentum,
        trend.toxicityShock,
        trend.toxicityPersistence,
        'elevated',
        'widen_threshold',
        'none',
        false,
        [],
        1.12,
        0.95,
        0.006,
        false,
        false,
        reasons,
      );
    }

    return this.decision(
      input,
      toxicityScore,
      book.bookInstabilityScore,
      adverseSelection.adverseSelectionRisk,
      trend.toxicityMomentum,
      trend.toxicityShock,
      trend.toxicityPersistence,
      'normal',
      'no_change',
      'none',
      false,
      [],
      1,
      1,
      0,
      false,
      false,
      reasons,
    );
  }

  private decision(
    input: ToxicityPolicyInput,
    toxicityScore: number,
    bookInstabilityScore: number,
    adverseSelectionRisk: number,
    toxicityMomentum: number,
    toxicityShock: number,
    toxicityPersistence: number,
    toxicityState: ToxicityState,
    recommendedAction: ToxicityRecommendedAction,
    executionAggressionLock: ExecutionAggressionLock,
    passiveOnly: boolean,
    aggressionReasonCodes: string[],
    thresholdMultiplier: number,
    sizeMultiplier: number,
    posteriorPenalty: number,
    disableAggressiveExecution: boolean,
    temporarilyBlockRegime: boolean,
    reasons: string[],
  ): ToxicityPolicyDecision {
    return {
      toxicityScore,
      bookInstabilityScore,
      adverseSelectionRisk,
      toxicityMomentum,
      toxicityShock,
      toxicityPersistence,
      toxicityState,
      recommendedAction,
      executionAggressionLock,
      passiveOnly,
      aggressionReasonCodes,
      thresholdMultiplier,
      sizeMultiplier,
      posteriorPenalty,
      disableAggressiveExecution,
      temporarilyBlockRegime,
      reasons,
      evidence: {
        regimeLabel: input.regimeLabel ?? null,
        structuralToxicityBias: input.structuralToxicityBias ?? null,
        signalAgeMs: input.signalAgeMs ?? null,
        recentHistorySampleCount: input.recentHistory?.length ?? 0,
        features: input.features,
      },
      capturedAt: new Date().toISOString(),
    };
  }

  private resolveRegimeBias(
    regimeLabel: string | null,
    structuralToxicityBias: number | null,
  ): number {
    const explicitBias =
      structuralToxicityBias != null ? clamp01(structuralToxicityBias) * 0.12 : 0;

    if (regimeLabel === 'near_resolution_microstructure_chaos') {
      return Math.max(explicitBias, 0.12);
    }
    if (regimeLabel === 'illiquid_noisy_book') {
      return Math.max(explicitBias, 0.08);
    }

    return explicitBias;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}
