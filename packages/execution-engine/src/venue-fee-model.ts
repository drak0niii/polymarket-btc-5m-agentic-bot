export type VenueFeeRoute = 'maker' | 'taker';
export type VenueFeeSource = 'venue_live' | 'fallback';

export interface VenueFeeModelInput {
  tokenId: string;
  route: VenueFeeRoute;
  price: number;
  size: number;
  venueFeeRateBps?: number | null;
  venueFeeFetchedAt?: string | null;
  source?: VenueFeeSource;
  fallbackFeeRateBps?: number;
  maxFeeAgeMs?: number;
}

export interface VenueFeeModelResult {
  tokenId: string;
  route: VenueFeeRoute;
  feeRateBps: number;
  expectedFee: number;
  expectedFeePerUnit: number;
  expectedRebateBps: number;
  netFeeBps: number;
  source: VenueFeeSource;
  fresh: boolean;
  conservative: boolean;
  reasonCode: string;
  reasonMessage: string;
  fetchedAt: string | null;
}

export class VenueFeeModel {
  evaluate(input: VenueFeeModelInput): VenueFeeModelResult {
    const fallbackFeeRateBps = this.normalizeRequiredNonNegative(input.fallbackFeeRateBps, 20);
    const feeRateBps = this.normalizeNonNegative(input.venueFeeRateBps, null);
    const fetchedAt = this.normalizeTimestamp(input.venueFeeFetchedAt ?? null);
    const maxFeeAgeMs = this.normalizePositive(input.maxFeeAgeMs, 60_000);
    const feeSource: VenueFeeSource =
      feeRateBps !== null ? input.source ?? 'venue_live' : 'fallback';
    const fresh =
      feeSource === 'venue_live' &&
      fetchedAt !== null &&
      Date.now() - new Date(fetchedAt).getTime() <= maxFeeAgeMs;

    const appliedFeeRateBps =
      feeSource === 'venue_live' && feeRateBps !== null && fresh ? feeRateBps : fallbackFeeRateBps;
    const normalizedAppliedFeeRateBps = Math.max(0, appliedFeeRateBps ?? fallbackFeeRateBps);
    const expectedRebateBps = 0;
    const netFeeBps = Math.max(0, normalizedAppliedFeeRateBps - expectedRebateBps);
    const expectedFee = input.price * input.size * (netFeeBps / 10_000);
    const expectedFeePerUnit = input.price * (netFeeBps / 10_000);

    if (feeSource === 'venue_live' && feeRateBps !== null && fresh) {
      return {
        tokenId: input.tokenId,
        route: input.route,
        feeRateBps: normalizedAppliedFeeRateBps,
        expectedFee,
        expectedFeePerUnit,
        expectedRebateBps,
        netFeeBps,
        source: 'venue_live',
        fresh: true,
        conservative: true,
        reasonCode:
          input.route === 'maker' ? 'venue_live_fee_conservative_maker' : 'venue_live_fee_taker',
        reasonMessage:
          input.route === 'maker'
            ? 'Live venue fee rate was loaded. Maker rebates are not assumed into EV until reward realization is proven.'
            : 'Live venue fee rate was loaded for immediate execution planning.',
        fetchedAt,
      };
    }

    return {
      tokenId: input.tokenId,
      route: input.route,
      feeRateBps: normalizedAppliedFeeRateBps,
      expectedFee,
      expectedFeePerUnit,
      expectedRebateBps,
      netFeeBps,
      source: 'fallback',
      fresh: false,
      conservative: true,
      reasonCode: 'fee_rate_fallback_applied',
      reasonMessage:
        'Live venue fee data was unavailable or stale, so the explicit fallback fee rate was applied conservatively.',
      fetchedAt,
    };
  }

  private normalizePositive(value: number | undefined, fallback: number): number {
    return Number.isFinite(value) && (value as number) > 0 ? (value as number) : fallback;
  }

  private normalizeNonNegative(value: number | null | undefined, fallback: number | null): number | null {
    if (!Number.isFinite(value)) {
      return fallback;
    }

    return Math.max(0, Number(value));
  }

  private normalizeRequiredNonNegative(value: number | null | undefined, fallback: number): number {
    return this.normalizeNonNegative(value, fallback) ?? fallback;
  }

  private normalizeTimestamp(value: string | null): string | null {
    if (!value) {
      return null;
    }

    const timestamp = new Date(value);
    return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
  }
}
