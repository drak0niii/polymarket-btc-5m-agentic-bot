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

export interface VolatilitySnapshot {
  symbol: string;
  timeframe: string;
  realizedVolatility: number;
  capturedAt: string;
}

export class VolatilityService {
  calculate(series: CandleSeries): VolatilitySnapshot {
    if (series.candles.length < 2) {
      return {
        symbol: series.symbol,
        timeframe: series.timeframe,
        realizedVolatility: 0,
        capturedAt: new Date().toISOString(),
      };
    }

    const returns: number[] = [];

    for (let index = 1; index < series.candles.length; index += 1) {
      const previous = series.candles[index - 1];
      const current = series.candles[index];

      if (previous.close > 0 && current.close > 0) {
        returns.push(Math.log(current.close / previous.close));
      }
    }

    if (returns.length === 0) {
      return {
        symbol: series.symbol,
        timeframe: series.timeframe,
        realizedVolatility: 0,
        capturedAt: new Date().toISOString(),
      };
    }

    const mean =
      returns.reduce((sum, value) => sum + value, 0) / returns.length;

    const variance =
      returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      returns.length;

    return {
      symbol: series.symbol,
      timeframe: series.timeframe,
      realizedVolatility: Math.sqrt(variance),
      capturedAt: new Date().toISOString(),
    };
  }
}
