import type { EventMicrostructureFeatures } from './event-microstructure-model';

export interface EdgeHalfLifeVerdict {
  halfLifeSeconds: number;
  ageMs: number;
  decayMultiplier: number;
  effectiveEdge: number;
  expired: boolean;
  reason: string;
}

export class EdgeHalfLifePolicy {
  evaluate(input: {
    rawEdge: number;
    signalAgeMs: number;
    timeToExpirySeconds: number | null;
    microstructure: EventMicrostructureFeatures;
  }): EdgeHalfLifeVerdict {
    const halfLifeSeconds = Math.max(
      15,
      Math.round(
        105 -
          input.microstructure.decayPressure * 50 -
          input.microstructure.expiryConvexity * 20,
      ),
    );
    const ageMs = Math.max(0, input.signalAgeMs);
    const decayMultiplier = Math.exp(-ageMs / (halfLifeSeconds * 1000));
    const effectiveEdge = input.rawEdge * decayMultiplier;
    const expiryLimited =
      input.timeToExpirySeconds != null && input.timeToExpirySeconds <= halfLifeSeconds;
    const expired = decayMultiplier < 0.35 || expiryLimited;

    return {
      halfLifeSeconds,
      ageMs,
      decayMultiplier,
      effectiveEdge,
      expired,
      reason: expired ? 'edge_half_life_expired' : 'edge_half_life_healthy',
    };
  }
}
