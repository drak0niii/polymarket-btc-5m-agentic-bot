import type { SignalFeatures } from '../feature-builder';

export interface FlowToxicityScoreInput {
  flowImbalanceProxy: number;
  flowIntensity: number;
  micropriceBias: number;
  btcMoveTransmission: number;
  signalDecayPressure: number;
}

export interface FlowToxicityScoreOutput {
  toxicityScore: number;
  reasons: string[];
  capturedAt: string;
}

export class FlowToxicityScore {
  score(
    input: FlowToxicityScoreInput | Pick<
      SignalFeatures,
      | 'flowImbalanceProxy'
      | 'flowIntensity'
      | 'micropriceBias'
      | 'btcMoveTransmission'
      | 'signalDecayPressure'
    >,
  ): FlowToxicityScoreOutput {
    const directionalPressure = Math.abs(input.flowImbalanceProxy) * 0.45;
    const intensityPressure = clamp01(input.flowIntensity) * 0.2;
    const micropricePressure = clamp01(Math.abs(input.micropriceBias) * 6) * 0.15;
    const linkageDivergencePressure = clamp01(Math.max(0, -input.btcMoveTransmission) * 2) * 0.08;
    const decayPressure = clamp01(input.signalDecayPressure) * 0.12;
    const toxicityScore = clamp01(
      directionalPressure +
        intensityPressure +
        micropricePressure +
        linkageDivergencePressure +
        decayPressure,
    );
    const reasons: string[] = [];

    if (Math.abs(input.flowImbalanceProxy) >= 0.55) {
      reasons.push('one_sided_flow_pressure');
    }
    if (input.flowIntensity >= 0.7) {
      reasons.push('flow_intensity_elevated');
    }
    if (Math.abs(input.micropriceBias) >= 0.05) {
      reasons.push('microprice_bias_elevated');
    }
    if (input.btcMoveTransmission <= -0.2) {
      reasons.push('btc_linkage_divergence');
    }
    if (input.signalDecayPressure >= 0.65) {
      reasons.push('signal_decay_pressure_elevated');
    }

    return {
      toxicityScore,
      reasons,
      capturedAt: new Date().toISOString(),
    };
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}
