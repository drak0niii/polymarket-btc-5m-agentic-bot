export interface TimestampAlignmentResult {
  referenceTimestamp: string;
  marketTimestamp: string;
  deltaMs: number;
  aligned: boolean;
}

export class TimestampAlignment {
  constructor(private readonly maxDeltaMs = 1_000) {}

  compare(referenceTimestamp: string, marketTimestamp: string): TimestampAlignmentResult {
    const deltaMs =
      Math.abs(
        new Date(referenceTimestamp).getTime() -
          new Date(marketTimestamp).getTime(),
      );

    return {
      referenceTimestamp,
      marketTimestamp,
      deltaMs,
      aligned: deltaMs <= this.maxDeltaMs,
    };
  }
}