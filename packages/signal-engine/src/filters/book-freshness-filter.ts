export interface BookFreshnessFilterInput {
  observedAt: string;
  maxAgeMs: number;
  now?: string;
}

export interface BookFreshnessFilterResult {
  passed: boolean;
  reasonCode: string;
  reasonMessage: string | null;
  ageMs: number;
}

export class BookFreshnessFilter {
  evaluate(input: BookFreshnessFilterInput): BookFreshnessFilterResult {
    const now = input.now ? new Date(input.now) : new Date();
    const observedAt = new Date(input.observedAt);
    const ageMs = now.getTime() - observedAt.getTime();

    if (Number.isNaN(observedAt.getTime())) {
      return {
        passed: false,
        reasonCode: 'book_timestamp_invalid',
        reasonMessage: 'Orderbook observedAt timestamp is invalid.',
        ageMs: Number.NaN,
      };
    }

    if (ageMs > input.maxAgeMs) {
      return {
        passed: false,
        reasonCode: 'book_stale',
        reasonMessage: `Orderbook age ${ageMs}ms exceeds max ${input.maxAgeMs}ms.`,
        ageMs,
      };
    }

    return {
      passed: true,
      reasonCode: 'passed',
      reasonMessage: null,
      ageMs,
    };
  }
}