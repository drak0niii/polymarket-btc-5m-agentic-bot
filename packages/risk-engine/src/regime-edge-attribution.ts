import type {
  EntryTimingBucket,
  ExecutionStyle,
  HealthLabel,
  LearningTradeSide,
  LiquidityBucket,
  RegimePerformanceSnapshot,
  SpreadBucket,
  TimeToExpiryBucket,
} from '@polymarket-btc-5m-agentic-bot/domain';

export interface RegimeEdgeAttributionTrade {
  strategyVariantId: string;
  regime: string | null;
  side: LearningTradeSide;
  expectedEv: number;
  realizedEv: number;
  fillRate: number | null;
  realizedSlippage: number | null;
  liquidityDepth: number | null;
  spread: number | null;
  timeToExpirySeconds: number | null;
  entryDelayMs: number | null;
  executionStyle: ExecutionStyle;
  observedAt: string;
}

export class RegimeEdgeAttribution {
  attribute(
    trades: RegimeEdgeAttributionTrade[],
  ): RegimePerformanceSnapshot[] {
    const buckets = new Map<
      string,
      {
        strategyVariantId: string;
        regime: string;
        liquidityBucket: LiquidityBucket;
        spreadBucket: SpreadBucket;
        timeToExpiryBucket: TimeToExpiryBucket;
        entryTimingBucket: EntryTimingBucket;
        executionStyle: ExecutionStyle;
        side: LearningTradeSide;
        sampleCount: number;
        wins: number;
        expectedEvSum: number;
        realizedEvSum: number;
        fillRateSum: number;
        fillRateCount: number;
        slippageSum: number;
        slippageCount: number;
        lastObservedAt: string | null;
      }
    >();

    for (const trade of trades) {
      const strategyVariantId = normalizeVariantId(trade.strategyVariantId);
      const regime = normalizeRegime(trade.regime);
      const liquidityBucket = bucketLiquidity(trade.liquidityDepth);
      const spreadBucket = bucketSpread(trade.spread);
      const timeToExpiryBucket = bucketTimeToExpiry(trade.timeToExpirySeconds);
      const entryTimingBucket = bucketEntryTiming(trade.entryDelayMs);
      const executionStyle = trade.executionStyle ?? 'unknown';
      const side = trade.side ?? 'unknown';
      const key = [
        strategyVariantId,
        regime,
        liquidityBucket,
        spreadBucket,
        timeToExpiryBucket,
        entryTimingBucket,
        executionStyle,
        side,
      ].join('|');

      const existing = buckets.get(key) ?? {
        strategyVariantId,
        regime,
        liquidityBucket,
        spreadBucket,
        timeToExpiryBucket,
        entryTimingBucket,
        executionStyle,
        side,
        sampleCount: 0,
        wins: 0,
        expectedEvSum: 0,
        realizedEvSum: 0,
        fillRateSum: 0,
        fillRateCount: 0,
        slippageSum: 0,
        slippageCount: 0,
        lastObservedAt: null,
      };

      existing.sampleCount += 1;
      existing.expectedEvSum += finiteOrZero(trade.expectedEv);
      existing.realizedEvSum += finiteOrZero(trade.realizedEv);
      if (finiteOrZero(trade.realizedEv) > 0) {
        existing.wins += 1;
      }
      if (trade.fillRate != null && Number.isFinite(trade.fillRate)) {
        existing.fillRateSum += trade.fillRate;
        existing.fillRateCount += 1;
      }
      if (trade.realizedSlippage != null && Number.isFinite(trade.realizedSlippage)) {
        existing.slippageSum += trade.realizedSlippage;
        existing.slippageCount += 1;
      }
      if (!existing.lastObservedAt || trade.observedAt > existing.lastObservedAt) {
        existing.lastObservedAt = trade.observedAt;
      }

      buckets.set(key, existing);
    }

    return [...buckets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, bucket]) => {
        const avgExpectedEv =
          bucket.sampleCount > 0 ? bucket.expectedEvSum / bucket.sampleCount : 0;
        const avgRealizedEv =
          bucket.sampleCount > 0 ? bucket.realizedEvSum / bucket.sampleCount : 0;
        const realizedVsExpected =
          Math.abs(bucket.expectedEvSum) > 0.000001
            ? bucket.realizedEvSum / bucket.expectedEvSum
            : bucket.realizedEvSum > 0
              ? 1
              : 0;

        return {
          key,
          regime: bucket.regime,
          liquidityBucket: bucket.liquidityBucket,
          spreadBucket: bucket.spreadBucket,
          timeToExpiryBucket: bucket.timeToExpiryBucket,
          entryTimingBucket: bucket.entryTimingBucket,
          executionStyle: bucket.executionStyle,
          side: bucket.side,
          strategyVariantId: bucket.strategyVariantId,
          sampleCount: bucket.sampleCount,
          winRate: bucket.sampleCount > 0 ? bucket.wins / bucket.sampleCount : 0,
          expectedEvSum: bucket.expectedEvSum,
          realizedEvSum: bucket.realizedEvSum,
          avgExpectedEv,
          avgRealizedEv,
          realizedVsExpected,
          avgFillRate:
            bucket.fillRateCount > 0 ? bucket.fillRateSum / bucket.fillRateCount : 0,
          avgSlippage:
            bucket.slippageCount > 0 ? bucket.slippageSum / bucket.slippageCount : 0,
          health: inferBaselineHealth(bucket.sampleCount),
          lastObservedAt: bucket.lastObservedAt,
        };
      });
  }
}

function inferBaselineHealth(sampleCount: number): HealthLabel {
  if (sampleCount < 3) {
    return 'healthy';
  }

  if (sampleCount < 5) {
    return 'watch';
  }

  return 'healthy';
}

function normalizeVariantId(value: string | null | undefined): string {
  return value && value.trim().length > 0 ? value : 'unknown_strategy_variant';
}

function normalizeRegime(value: string | null | undefined): string {
  return value && value.trim().length > 0 ? value : 'unknown_regime';
}

function bucketLiquidity(depth: number | null): LiquidityBucket {
  if (depth == null || !Number.isFinite(depth) || depth <= 0) {
    return 'unknown';
  }
  if (depth < 20) {
    return 'thin';
  }
  if (depth < 100) {
    return 'balanced';
  }
  return 'deep';
}

function bucketSpread(spread: number | null): SpreadBucket {
  if (spread == null || !Number.isFinite(spread) || spread < 0) {
    return 'unknown';
  }
  if (spread <= 0.01) {
    return 'tight';
  }
  if (spread <= 0.03) {
    return 'normal';
  }
  if (spread <= 0.06) {
    return 'wide';
  }
  return 'stressed';
}

function bucketTimeToExpiry(seconds: number | null): TimeToExpiryBucket {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) {
    return 'unknown';
  }
  if (seconds <= 300) {
    return 'under_5m';
  }
  if (seconds <= 900) {
    return 'under_15m';
  }
  if (seconds <= 3600) {
    return 'under_60m';
  }
  return 'over_60m';
}

function bucketEntryTiming(delayMs: number | null): EntryTimingBucket {
  if (delayMs == null || !Number.isFinite(delayMs) || delayMs < 0) {
    return 'unknown';
  }
  if (delayMs <= 1_500) {
    return 'instant';
  }
  if (delayMs <= 5_000) {
    return 'early';
  }
  if (delayMs <= 15_000) {
    return 'delayed';
  }
  return 'late';
}

function finiteOrZero(value: number | null | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0;
}
