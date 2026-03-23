export interface MarketableLimitInput {
  side: 'BUY' | 'SELL';
  bestBid: number | null;
  bestAsk: number | null;
  aggressionBps: number;
}

export interface MarketableLimitResult {
  price: number;
  referencePrice: number;
  side: 'BUY' | 'SELL';
  createdAt: string;
}

export class MarketableLimit {
  calculate(input: MarketableLimitInput): MarketableLimitResult {
    const bestBid = input.bestBid ?? 0;
    const bestAsk = input.bestAsk ?? 0;

    if (input.side === 'BUY') {
      const referencePrice = bestAsk > 0 ? bestAsk : bestBid;
      const price = referencePrice * (1 + input.aggressionBps / 10_000);

      return {
        price,
        referencePrice,
        side: input.side,
        createdAt: new Date().toISOString(),
      };
    }

    const referencePrice = bestBid > 0 ? bestBid : bestAsk;
    const price = referencePrice * (1 - input.aggressionBps / 10_000);

    return {
      price,
      referencePrice,
      side: input.side,
      createdAt: new Date().toISOString(),
    };
  }
}