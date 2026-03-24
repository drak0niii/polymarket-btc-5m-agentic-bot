export type EntryTimingEfficiencyLabel = 'efficient' | 'early' | 'late' | 'stale';

export interface EntryTimingEfficiencyInput {
  signalAgeMs: number;
  timeToExpirySeconds: number | null;
  halfLifeMultiplier: number;
  halfLifeExpired: boolean;
  expectedFillDelayMs: number | null;
  microstructureDecayPressure: number;
}

export interface EntryTimingEfficiencyScore {
  label: EntryTimingEfficiencyLabel;
  score: number;
  sizeMultiplier: number;
  blockTrade: boolean;
  reasons: string[];
  evidence: Record<string, unknown>;
}

export class EntryTimingEfficiencyScorer {
  score(input: EntryTimingEfficiencyInput): EntryTimingEfficiencyScore {
    const expectedFillDelayMs = Math.max(10_000, input.expectedFillDelayMs ?? 20_000);
    const reasons: string[] = [];

    if (
      input.halfLifeExpired ||
      input.halfLifeMultiplier < 0.45 ||
      input.signalAgeMs >= expectedFillDelayMs * 3 ||
      (input.timeToExpirySeconds != null &&
        input.timeToExpirySeconds * 1_000 <= expectedFillDelayMs)
    ) {
      reasons.push('entry_timing_stale');
      return {
        label: 'stale',
        score: 0,
        sizeMultiplier: 0,
        blockTrade: true,
        reasons,
        evidence: {
          ...input,
          expectedFillDelayMs,
        },
      };
    }

    if (
      input.signalAgeMs >= expectedFillDelayMs * 1.5 ||
      input.microstructureDecayPressure >= 0.75 ||
      input.halfLifeMultiplier < 0.7
    ) {
      reasons.push('entry_timing_late');
      return {
        label: 'late',
        score: 0.35,
        sizeMultiplier: 0.45,
        blockTrade: false,
        reasons,
        evidence: {
          ...input,
          expectedFillDelayMs,
        },
      };
    }

    if (
      input.signalAgeMs <= 5_000 &&
      input.microstructureDecayPressure <= 0.2 &&
      expectedFillDelayMs >= 30_000
    ) {
      reasons.push('entry_timing_too_early');
      return {
        label: 'early',
        score: 0.65,
        sizeMultiplier: 0.75,
        blockTrade: false,
        reasons,
        evidence: {
          ...input,
          expectedFillDelayMs,
        },
      };
    }

    reasons.push('entry_timing_efficient');
    return {
      label: 'efficient',
      score: 0.95,
      sizeMultiplier: 1,
      blockTrade: false,
      reasons,
      evidence: {
        ...input,
        expectedFillDelayMs,
      },
    };
  }
}
