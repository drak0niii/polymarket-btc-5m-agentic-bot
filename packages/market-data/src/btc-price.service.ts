export interface BtcPriceSnapshot {
  symbol: string;
  price: number;
  capturedAt: string;
}

export class BtcPriceService {
  constructor(private readonly symbol: string = 'BTCUSD') {}

  async getLatestPrice(): Promise<BtcPriceSnapshot> {
    const response = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot');
    if (!response.ok) {
      throw new Error(
        `BTC spot fetch failed: ${response.status} ${response.statusText}`,
      );
    }

    const payload = (await response.json()) as {
      data?: {
        amount?: string;
      };
    };

    const price = Number(payload.data?.amount ?? Number.NaN);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error('BTC spot fetch failed: invalid price payload.');
    }

    return {
      symbol: this.symbol,
      price,
      capturedAt: new Date().toISOString(),
    };
  }
}
