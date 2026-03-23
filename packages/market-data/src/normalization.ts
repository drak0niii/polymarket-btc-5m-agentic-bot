interface CandleSeries {
  symbol: string;
  timeframe: string;
  candles: Array<{
    timestamp: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
}

export interface NormalizedCandlePoint {
  timestamp: string;
  returnPct: number;
  rangePct: number;
  bodyPct: number;
  volume: number;
}

export class MarketDataNormalizer {
  normalize(series: CandleSeries): NormalizedCandlePoint[] {
    return series.candles.map((candle) => {
      const open = candle.open === 0 ? 1 : candle.open;
      const close = candle.close === 0 ? open : candle.close;
      const high = candle.high === 0 ? Math.max(open, close) : candle.high;
      const low = candle.low === 0 ? Math.min(open, close) : candle.low;

      return {
        timestamp: candle.timestamp,
        returnPct: (close - open) / open,
        rangePct: (high - low) / open,
        bodyPct: (close - open) / open,
        volume: candle.volume,
      };
    });
  }
}
