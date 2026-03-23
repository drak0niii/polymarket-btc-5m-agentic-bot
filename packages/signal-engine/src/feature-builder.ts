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

interface Orderbook {
  bidLevels: Array<{ price: number; size: number }>;
  askLevels: Array<{ price: number; size: number }>;
  spread: number;
}

export interface SignalFeatures {
  lastReturnPct: number;
  rollingReturnPct: number;
  realizedVolatility: number;
  realizedRangePct: number;
  spread: number;
  spreadToDepthRatio: number;
  topLevelImbalance: number;
  bidDepth: number;
  askDepth: number;
  combinedDepth: number;
  topLevelDepth: number;
  depthConcentration: number;
  midpointPrice: number;
  midpointDriftPct: number;
  micropriceBias: number;
  volumeTrend: number;
  orderbookNoiseScore: number;
  sampleCount: number;
  timeToExpirySeconds: number | null;
  capturedAt: string;
}

export class FeatureBuilder {
  build(params: {
    candles: CandleSeries;
    orderbook: Orderbook | null;
    expiresAt?: string | null;
  }): SignalFeatures {
    const candles = params.candles.candles;
    const last = candles[candles.length - 1];
    const first = candles[0];

    const lastReturnPct =
      last && last.open !== 0 ? (last.close - last.open) / last.open : 0;

    const rollingReturnPct =
      first && last && first.open !== 0 ? (last.close - first.open) / first.open : 0;

    const returns: number[] = [];

    for (let index = 1; index < candles.length; index += 1) {
      const previous = candles[index - 1];
      const current = candles[index];

      if (previous.close > 0 && current.close > 0) {
        returns.push(Math.log(current.close / previous.close));
      }
    }

    const mean =
      returns.length > 0
        ? returns.reduce((sum, value) => sum + value, 0) / returns.length
        : 0;

    const variance =
      returns.length > 0
        ? returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
          returns.length
        : 0;

    const bidDepth =
      params.orderbook?.bidLevels.reduce((sum, level) => sum + level.size, 0) ?? 0;

    const askDepth =
      params.orderbook?.askLevels.reduce((sum, level) => sum + level.size, 0) ?? 0;

    const combinedDepth = bidDepth + askDepth;

    const topBid = params.orderbook?.bidLevels[0]?.size ?? 0;
    const topAsk = params.orderbook?.askLevels[0]?.size ?? 0;
    const topLevelDepth = topBid + topAsk;

    const topLevelImbalance =
      topBid + topAsk > 0 ? (topBid - topAsk) / (topBid + topAsk) : 0;

    const midpointPrice =
      params.orderbook && params.orderbook.bidLevels[0] && params.orderbook.askLevels[0]
        ? (params.orderbook.bidLevels[0].price + params.orderbook.askLevels[0].price) / 2
        : 0;

    const previousMidpoint =
      candles.length >= 2 && candles[candles.length - 2]
        ? (candles[candles.length - 2].close + last.close) / 2
        : midpointPrice;

    const midpointDriftPct =
      previousMidpoint > 0 ? (midpointPrice - previousMidpoint) / previousMidpoint : 0;

    const micropriceBias =
      topBid + topAsk > 0
        ? ((params.orderbook?.askLevels[0]?.price ?? midpointPrice) * topBid -
            (params.orderbook?.bidLevels[0]?.price ?? midpointPrice) * topAsk) /
          ((topBid + topAsk) * Math.max(midpointPrice, 0.0001))
        : 0;

    const candleRanges = candles
      .filter((candle) => candle.open > 0)
      .map((candle) => (candle.high - candle.low) / candle.open);

    const realizedRangePct =
      candleRanges.length > 0
        ? candleRanges.reduce((sum, value) => sum + value, 0) / candleRanges.length
        : 0;

    const recentVolumes = candles.slice(-3).map((candle) => candle.volume);
    const baselineVolumes = candles.slice(0, Math.max(1, candles.length - 3)).map((candle) => candle.volume);
    const recentVolumeMean =
      recentVolumes.length > 0
        ? recentVolumes.reduce((sum, value) => sum + value, 0) / recentVolumes.length
        : 0;
    const baselineVolumeMean =
      baselineVolumes.length > 0
        ? baselineVolumes.reduce((sum, value) => sum + value, 0) / baselineVolumes.length
        : recentVolumeMean;
    const volumeTrend =
      baselineVolumeMean > 0 ? recentVolumeMean / baselineVolumeMean - 1 : 0;

    const depthConcentration =
      combinedDepth > 0 ? topLevelDepth / combinedDepth : 1;

    const spreadToDepthRatio =
      combinedDepth > 0 ? (params.orderbook?.spread ?? 0) / combinedDepth : params.orderbook?.spread ?? 0;

    const orderbookNoiseScore =
      clamp01(
        (params.orderbook?.spread ?? 0) * 16 +
          Math.abs(topLevelImbalance - micropriceBias) * 2.5 +
          Math.max(0, depthConcentration - 0.5) * 0.4,
      );

    const now = new Date();
    const timeToExpirySeconds =
      params.expiresAt != null
        ? Math.max(
            0,
            Math.floor(
              (new Date(params.expiresAt).getTime() - now.getTime()) / 1000,
            ),
          )
        : null;

    return {
      lastReturnPct,
      rollingReturnPct,
      realizedVolatility: Math.sqrt(variance),
      realizedRangePct,
      spread: params.orderbook?.spread ?? 0,
      spreadToDepthRatio,
      topLevelImbalance,
      bidDepth,
      askDepth,
      combinedDepth,
      topLevelDepth,
      depthConcentration,
      midpointPrice,
      midpointDriftPct,
      micropriceBias,
      volumeTrend,
      orderbookNoiseScore,
      sampleCount: candles.length,
      timeToExpirySeconds,
      capturedAt: now.toISOString(),
    };
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}
