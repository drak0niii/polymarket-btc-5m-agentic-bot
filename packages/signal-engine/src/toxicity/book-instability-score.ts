import type { SignalFeatures } from '../feature-builder';

export interface BookInstabilityScoreInput {
  bookUpdateStress: number;
  orderbookNoiseScore: number;
  spread: number;
  spreadToDepthRatio: number;
  topLevelDepth: number;
  timeToExpirySeconds: number | null;
}

export interface BookInstabilityScoreOutput {
  bookInstabilityScore: number;
  reasons: string[];
  capturedAt: string;
}

export class BookInstabilityScore {
  score(
    input: BookInstabilityScoreInput | Pick<
      SignalFeatures,
      | 'bookUpdateStress'
      | 'orderbookNoiseScore'
      | 'spread'
      | 'spreadToDepthRatio'
      | 'topLevelDepth'
      | 'timeToExpirySeconds'
    >,
  ): BookInstabilityScoreOutput {
    const updateStress = clamp01(input.bookUpdateStress) * 0.38;
    const noiseStress = clamp01(input.orderbookNoiseScore) * 0.24;
    const spreadStress = clamp01(input.spread / 0.05) * 0.16;
    const spreadDepthStress = clamp01(input.spreadToDepthRatio * 800) * 0.12;
    const shallowDepthStress =
      clamp01((20 - Math.max(0, input.topLevelDepth)) / 20) * 0.06;
    const expiryStress =
      input.timeToExpirySeconds != null
        ? clamp01((120 - Math.max(0, input.timeToExpirySeconds)) / 120) * 0.04
        : 0;
    const bookInstabilityScore = clamp01(
      updateStress +
        noiseStress +
        spreadStress +
        spreadDepthStress +
        shallowDepthStress +
        expiryStress,
    );
    const reasons: string[] = [];

    if (input.bookUpdateStress >= 0.7) {
      reasons.push('book_update_stress_elevated');
    }
    if (input.orderbookNoiseScore >= 0.55) {
      reasons.push('orderbook_noise_elevated');
    }
    if (input.spread >= 0.03) {
      reasons.push('spread_instability_elevated');
    }
    if (input.topLevelDepth < 12) {
      reasons.push('top_level_depth_shallow');
    }
    if (input.timeToExpirySeconds != null && input.timeToExpirySeconds <= 90) {
      reasons.push('expiry_microstructure_fragile');
    }

    return {
      bookInstabilityScore,
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
