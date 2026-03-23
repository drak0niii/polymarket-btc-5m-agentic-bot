export interface FeedLatencySnapshot {
  source: string;
  observedAt: string;
  upstreamTimestamp: string;
  latencyMs: number;
  stale: boolean;
}

export class FeedLatencyMonitor {
  constructor(private readonly staleThresholdMs = 2_000) {}

  measure(source: string, upstreamTimestamp: string): FeedLatencySnapshot {
    const observedAt = new Date().toISOString();
    const latencyMs =
      new Date(observedAt).getTime() - new Date(upstreamTimestamp).getTime();

    return {
      source,
      observedAt,
      upstreamTimestamp,
      latencyMs,
      stale: latencyMs > this.staleThresholdMs,
    };
  }
}