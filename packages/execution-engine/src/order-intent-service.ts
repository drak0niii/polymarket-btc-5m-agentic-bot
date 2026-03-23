import { createHash } from 'crypto';

export interface OrderIntentIdentityInput {
  source: string;
  marketId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  intent: 'ENTER' | 'REDUCE' | 'EXIT' | 'FLIP';
  price: number;
  size: number;
  orderType: string;
  expiration: string | null;
  schemaVersion?: string;
}

export interface OrderIntentIdentity {
  intentId: string;
  clientOrderId: string;
  fingerprint: string;
}

export class OrderIntentService {
  identify(input: OrderIntentIdentityInput): OrderIntentIdentity {
    const schemaVersion = input.schemaVersion ?? 'v1';
    const fingerprint = [
      schemaVersion,
      input.source,
      input.marketId,
      input.tokenId,
      input.side,
      input.intent,
      this.normalizeNumber(input.price, 6),
      this.normalizeNumber(input.size, 6),
      input.orderType,
      input.expiration ? new Date(input.expiration).toISOString() : 'none',
    ].join('|');
    const hash = createHash('sha256').update(fingerprint).digest('hex');
    const intentId = `intent_${hash.slice(0, 24)}`;
    const clientOrderId = `coid_${hash.slice(0, 20)}`;
    return {
      intentId,
      clientOrderId,
      fingerprint,
    };
  }

  private normalizeNumber(value: number, decimals: number): string {
    const normalized = Number.isFinite(value) ? value : 0;
    return normalized.toFixed(decimals);
  }
}
