export interface StaleOrderManagerInput {
  postedAt: string;
  now?: string;
  staleAfterMs: number;
}

export interface StaleOrderManagerResult {
  stale: boolean;
  ageMs: number;
  reasonCode: string;
}

export class StaleOrderManager {
  evaluate(input: StaleOrderManagerInput): StaleOrderManagerResult {
    const now = input.now ? new Date(input.now) : new Date();
    const postedAt = new Date(input.postedAt);
    const ageMs = now.getTime() - postedAt.getTime();

    if (Number.isNaN(postedAt.getTime())) {
      return {
        stale: true,
        ageMs: Number.NaN,
        reasonCode: 'invalid_posted_at',
      };
    }

    if (ageMs >= input.staleAfterMs) {
      return {
        stale: true,
        ageMs,
        reasonCode: 'stale_order',
      };
    }

    return {
      stale: false,
      ageMs,
      reasonCode: 'fresh_order',
    };
  }
}