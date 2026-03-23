export interface Candle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandleSeries {
  symbol: string;
  timeframe: string;
  candles: Candle[];
}

export class CandlesService {
  constructor(
    private readonly symbol: string = 'BTCUSD',
    private readonly timeframe: string = '5m',
  ) {}

  async getRecentCandles(limit = 50): Promise<CandleSeries> {
    const response = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=${Math.max(
        1,
        limit,
      )}`,
    );

    if (!response.ok) {
      throw new Error(
        `Candles fetch failed: ${response.status} ${response.statusText}`,
      );
    }

    const rows = (await response.json()) as unknown;
    if (!Array.isArray(rows)) {
      throw new Error('Candles fetch failed: unexpected payload shape.');
    }

    const candles: Candle[] = rows
      .map((row) => {
        if (!Array.isArray(row) || row.length < 6) {
          return null;
        }

        const timestamp = Number(row[0]);
        const open = Number(row[1]);
        const high = Number(row[2]);
        const low = Number(row[3]);
        const close = Number(row[4]);
        const volume = Number(row[5]);

        if (
          !Number.isFinite(timestamp) ||
          !Number.isFinite(open) ||
          !Number.isFinite(high) ||
          !Number.isFinite(low) ||
          !Number.isFinite(close) ||
          !Number.isFinite(volume)
        ) {
          return null;
        }

        return {
          timestamp: new Date(timestamp).toISOString(),
          open,
          high,
          low,
          close,
          volume,
        };
      })
      .filter((candle): candle is Candle => candle !== null);

    return {
      symbol: this.symbol,
      timeframe: this.timeframe,
      candles,
    };
  }
}
