import type { SignalFeatures } from '../feature-builder';
import type { RegimeClassification } from '../regime-classifier';

export interface PriorModelComponents {
  bias: number;
  momentumComponent: number;
  imbalanceComponent: number;
  flowComponent: number;
  linkageComponent: number;
  transmissionLagComponent: number;
  nonlinearTransmissionComponent: number;
  transmissionConsistencyAdjustment: number;
  transmissionDivergencePenalty: number;
  imbalancePersistenceComponent: number;
  imbalanceReversalPenalty: number;
  quoteInstabilityPenalty: number;
  depthDepletionComponent: number;
  archetypeAdjustment: number;
  transitionAdjustment: number;
  volatilityPenalty: number;
  decayPenalty: number;
  regimeAdjustment: number;
}

export interface PriorModelOutput {
  probabilityUp: number;
  confidence: number;
  components: PriorModelComponents;
  capturedAt: string;
}

export class PriorModel {
  evaluate(
    features: SignalFeatures,
    regime?: RegimeClassification,
  ): PriorModelOutput {
    const bias = 0.5;
    const momentumComponent = features.rollingReturnPct * 16;
    const imbalanceComponent = features.topLevelImbalance * 0.1;
    const flowComponent = features.flowImbalanceProxy * 0.06;
    const linkageComponent =
      features.btcMoveTransmission * (0.03 + features.btcLinkageConfidence * 0.02);
    const transmissionLagComponent =
      features.laggedBtcMoveTransmission *
      (0.018 + features.btcLinkageConfidence * 0.012);
    const nonlinearTransmissionComponent =
      features.nonlinearBtcMoveSensitivity *
      features.btcMoveTransmission *
      0.018;
    const transmissionConsistencyAdjustment =
      (features.transmissionConsistency - 0.5) * 0.028;
    const transmissionDivergencePenalty = features.btcPathDivergence * 0.024;
    const imbalancePersistenceComponent =
      (features.imbalancePersistence - 0.5) * 0.034;
    const imbalanceReversalPenalty =
      features.imbalanceReversalProbability * 0.028;
    const quoteInstabilityPenalty =
      features.quoteInstabilityBeforeMove * 0.022;
    const depthDepletionComponent =
      features.depthDepletionAsymmetry * 0.016;
    const archetypeAdjustment = archetypeBias(features.marketArchetype);
    const transitionAdjustment = transitionBias(features.marketStateTransition);
    const volatilityPenalty = features.realizedVolatility * 5.5;
    const decayPenalty = features.signalDecayPressure * 0.04;
    const regimeAdjustment =
      regime?.label === 'momentum_continuation'
        ? 0.02
        : regime?.label === 'spike_and_revert'
          ? -0.01
          : regime?.label === 'low_volatility_drift'
            ? 0.005
            : -0.03;

    const score =
      bias +
      momentumComponent +
      imbalanceComponent +
      flowComponent +
      linkageComponent +
      transmissionLagComponent +
      nonlinearTransmissionComponent +
      transmissionConsistencyAdjustment +
      imbalancePersistenceComponent +
      depthDepletionComponent +
      archetypeAdjustment +
      transitionAdjustment -
      transmissionDivergencePenalty -
      imbalanceReversalPenalty -
      quoteInstabilityPenalty -
      volatilityPenalty -
      decayPenalty +
      regimeAdjustment;

    const probabilityUp = Math.max(0.01, Math.min(0.99, score));
    const confidence = clamp01(
      0.35 +
        Math.abs(momentumComponent) * 5 +
        Math.abs(flowComponent) * 3 +
        Math.abs(linkageComponent) * 6 +
        Math.abs(transmissionLagComponent) * 4 +
        nonlinearTransmissionComponent * 1.8 +
        Math.max(0, transmissionConsistencyAdjustment) * 2 -
        imbalanceReversalPenalty * 1.7 -
        quoteInstabilityPenalty * 1.5 +
        Math.max(0, imbalancePersistenceComponent) * 2 +
        Math.abs(depthDepletionComponent) * 1.2 -
        transmissionDivergencePenalty * 2.5 +
        features.marketArchetypeConfidence * 0.15 -
        features.signalDecayPressure * 0.2,
    );

    return {
      probabilityUp,
      confidence,
      components: {
        bias,
        momentumComponent,
        imbalanceComponent,
        flowComponent,
        linkageComponent,
        transmissionLagComponent,
        nonlinearTransmissionComponent,
        transmissionConsistencyAdjustment,
        transmissionDivergencePenalty,
        imbalancePersistenceComponent,
        imbalanceReversalPenalty,
        quoteInstabilityPenalty,
        depthDepletionComponent,
        archetypeAdjustment,
        transitionAdjustment,
        volatilityPenalty,
        decayPenalty,
        regimeAdjustment,
      },
      capturedAt: new Date().toISOString(),
    };
  }
}

function archetypeBias(value: SignalFeatures['marketArchetype']): number {
  switch (value) {
    case 'trend_follow_through':
      return 0.014;
    case 'mean_reversion_trap':
      return -0.012;
    case 'stressed_microstructure':
      return -0.018;
    case 'expiry_pressure':
      return -0.022;
    case 'balanced_rotation':
    default:
      return 0.002;
  }
}

function transitionBias(value: SignalFeatures['marketStateTransition']): number {
  switch (value) {
    case 'trend_acceleration':
      return 0.012;
    case 'mean_reversion':
      return -0.01;
    case 'trend_exhaustion':
      return -0.006;
    case 'stress_transition':
      return -0.016;
    case 'range_balance':
    default:
      return 0;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}
