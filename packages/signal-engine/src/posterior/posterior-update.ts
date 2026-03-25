import type { SignalFeatures } from '../feature-builder';
import type { RegimeClassification } from '../regime-classifier';

export interface PosteriorUpdateInput {
  priorProbability: number;
  features: SignalFeatures;
  regime?: RegimeClassification;
  toxicityPenalty?: number | null;
}

export interface PosteriorAdjustments {
  flowAdjustment: number;
  archetypeAdjustment: number;
  transitionAdjustment: number;
  linkageAdjustment: number;
  transmissionLagAdjustment: number;
  nonlinearTransmissionAdjustment: number;
  transmissionConsistencyAdjustment: number;
  transmissionDivergencePenalty: number;
  imbalancePersistenceAdjustment: number;
  imbalanceReversalPenalty: number;
  quoteInstabilityPenalty: number;
  depthDepletionAdjustment: number;
  spreadPenalty: number;
  decayPenalty: number;
  instabilityPenalty: number;
  toxicityPenalty: number;
  regimeAdjustment: number;
  confidenceMultiplier: number;
}

export interface PosteriorUpdateOutput {
  posteriorProbability: number;
  confidence: number;
  adjustments: PosteriorAdjustments;
  capturedAt: string;
}

export class PosteriorUpdate {
  apply(input: PosteriorUpdateInput): PosteriorUpdateOutput {
    const flowAdjustment =
      input.features.flowImbalanceProxy * 0.06 +
      input.features.flowIntensity * 0.015;
    const archetypeAdjustment = archetypeAdjustmentFor(input.features.marketArchetype);
    const transitionAdjustment =
      transitionAdjustmentFor(input.features.marketStateTransition) *
      Math.max(0.4, input.features.marketStateTransitionStrength);
    const linkageAdjustment =
      input.features.btcMoveTransmission *
      (0.025 + input.features.btcLinkageConfidence * 0.03);
    const transmissionLagAdjustment =
      input.features.laggedBtcMoveTransmission *
      (0.016 + input.features.btcLinkageConfidence * 0.018);
    const nonlinearTransmissionAdjustment =
      input.features.nonlinearBtcMoveSensitivity *
      input.features.btcMoveTransmission *
      0.016;
    const transmissionConsistencyAdjustment =
      (input.features.transmissionConsistency - 0.5) * 0.022;
    const transmissionDivergencePenalty =
      input.features.btcPathDivergence * 0.026;
    const imbalancePersistenceAdjustment =
      (input.features.imbalancePersistence - 0.5) * 0.026;
    const imbalanceReversalPenalty =
      input.features.imbalanceReversalProbability * 0.03;
    const quoteInstabilityPenalty =
      input.features.quoteInstabilityBeforeMove * 0.024;
    const depthDepletionAdjustment =
      input.features.depthDepletionAsymmetry * 0.014;
    const spreadPenalty = input.features.spread * 0.3;
    const decayPenalty = input.features.signalDecayPressure * 0.045;
    const instabilityPenalty = input.features.bookUpdateStress * 0.035;
    const toxicityPenalty = Math.max(0, input.toxicityPenalty ?? 0);
    const regimeAdjustment =
      input.regime?.label === 'momentum_continuation'
        ? input.features.micropriceBias * 0.05
        : input.regime?.label === 'spike_and_revert'
          ? -input.features.lastReturnPct * 0.07
          : input.regime?.label === 'low_volatility_drift'
            ? input.features.midpointDriftPct * 0.04
            : -0.02;
    const expiryPenalty =
      input.features.timeToExpirySeconds !== null &&
      input.features.timeToExpirySeconds < 30
        ? 0.03
        : 0;
    const confidenceMultiplier = clamp(
      0.55 +
        input.features.marketArchetypeConfidence * 0.2 +
        input.features.btcLinkageConfidence * 0.15 -
        transmissionDivergencePenalty * 1.8 +
        imbalanceReversalPenalty * -1.2 +
        quoteInstabilityPenalty * -1.1 +
        Math.max(0, imbalancePersistenceAdjustment) * 1.5 +
        input.features.signalDecayPressure * 0.2 -
        input.features.bookUpdateStress * 0.15,
      0.3,
      1,
    );
    const netAdjustment =
      (flowAdjustment +
        archetypeAdjustment +
        transitionAdjustment +
        linkageAdjustment +
        transmissionLagAdjustment +
        nonlinearTransmissionAdjustment +
        transmissionConsistencyAdjustment +
        imbalancePersistenceAdjustment +
        depthDepletionAdjustment +
        regimeAdjustment) *
      confidenceMultiplier;

    const posteriorProbability = Math.max(
      0.01,
      Math.min(
        0.99,
        input.priorProbability +
          netAdjustment -
          spreadPenalty -
          transmissionDivergencePenalty -
          imbalanceReversalPenalty -
          quoteInstabilityPenalty -
          decayPenalty -
          instabilityPenalty -
          toxicityPenalty -
          expiryPenalty,
      ),
    );
    const confidence = clamp01(
      0.35 +
        Math.abs(netAdjustment) * 4 +
        input.features.marketArchetypeConfidence * 0.15 -
        (transmissionDivergencePenalty + decayPenalty + instabilityPenalty + toxicityPenalty),
    );

    return {
      posteriorProbability,
      confidence,
      adjustments: {
        flowAdjustment,
        archetypeAdjustment,
        transitionAdjustment,
        linkageAdjustment,
        transmissionLagAdjustment,
        nonlinearTransmissionAdjustment,
        transmissionConsistencyAdjustment,
        transmissionDivergencePenalty,
        imbalancePersistenceAdjustment,
        imbalanceReversalPenalty,
        quoteInstabilityPenalty,
        depthDepletionAdjustment,
        spreadPenalty,
        decayPenalty,
        instabilityPenalty,
        toxicityPenalty,
        regimeAdjustment,
        confidenceMultiplier,
      },
      capturedAt: new Date().toISOString(),
    };
  }
}

function archetypeAdjustmentFor(value: SignalFeatures['marketArchetype']): number {
  switch (value) {
    case 'trend_follow_through':
      return 0.018;
    case 'mean_reversion_trap':
      return -0.015;
    case 'stressed_microstructure':
      return -0.02;
    case 'expiry_pressure':
      return -0.022;
    case 'balanced_rotation':
    default:
      return 0.002;
  }
}

function transitionAdjustmentFor(value: SignalFeatures['marketStateTransition']): number {
  switch (value) {
    case 'trend_acceleration':
      return 0.014;
    case 'mean_reversion':
      return -0.012;
    case 'trend_exhaustion':
      return -0.008;
    case 'stress_transition':
      return -0.018;
    case 'range_balance':
    default:
      return 0;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
