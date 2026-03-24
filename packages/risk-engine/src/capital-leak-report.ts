import type {
  CapitalLeakAttributionResult,
  CapitalLeakCategory,
} from './capital-leak-attribution';

export interface CapitalLeakReportGroup {
  groupKey: string;
  tradeCount: number;
  totalLeak: number;
  categoryTotals: Partial<Record<CapitalLeakCategory, number>>;
  dominantCategory: CapitalLeakCategory | null;
  dominantShare: number;
}

export interface CapitalLeakReport {
  generatedAt: string;
  window: {
    from: string;
    to: string;
  };
  tradeCount: number;
  totalLeak: number;
  categoryTotals: Partial<Record<CapitalLeakCategory, number>>;
  dominantCategory: CapitalLeakCategory | null;
  dominantShare: number;
  byStrategyVariant: CapitalLeakReportGroup[];
  byRegime: CapitalLeakReportGroup[];
  byMarketContext: CapitalLeakReportGroup[];
  byExecutionStyle: CapitalLeakReportGroup[];
  byTimeWindow: CapitalLeakReportGroup[];
}

export class CapitalLeakReportBuilder {
  build(input: {
    generatedAt: string;
    from: string;
    to: string;
    attributions: CapitalLeakAttributionResult[];
  }): CapitalLeakReport {
    return {
      generatedAt: input.generatedAt,
      window: {
        from: input.from,
        to: input.to,
      },
      tradeCount: input.attributions.length,
      totalLeak: this.sumLeak(input.attributions),
      categoryTotals: this.categoryTotals(input.attributions),
      dominantCategory: this.dominant(this.categoryTotals(input.attributions)).category,
      dominantShare: this.dominant(this.categoryTotals(input.attributions)).share,
      byStrategyVariant: this.group(
        input.attributions,
        (entry) => entry.strategyVariantId ?? 'unknown_strategy_variant',
      ),
      byRegime: this.group(input.attributions, (entry) => entry.regime ?? 'unknown_regime'),
      byMarketContext: this.group(
        input.attributions,
        (entry) => entry.marketContext ?? 'unknown_market_context',
      ),
      byExecutionStyle: this.group(
        input.attributions,
        (entry) => entry.executionStyle ?? 'unknown_execution_style',
      ),
      byTimeWindow: this.group(input.attributions, (entry) => this.timeBucket(entry.observedAt)),
    };
  }

  private group(
    attributions: CapitalLeakAttributionResult[],
    keySelector: (entry: CapitalLeakAttributionResult) => string,
  ): CapitalLeakReportGroup[] {
    const grouped = new Map<string, CapitalLeakAttributionResult[]>();
    for (const entry of attributions) {
      const key = keySelector(entry);
      const bucket = grouped.get(key) ?? [];
      bucket.push(entry);
      grouped.set(key, bucket);
    }

    return Array.from(grouped.entries())
      .map(([groupKey, entries]) => {
        const categoryTotals = this.categoryTotals(entries);
        const dominant = this.dominant(categoryTotals);
        return {
          groupKey,
          tradeCount: entries.length,
          totalLeak: this.sumLeak(entries),
          categoryTotals,
          dominantCategory: dominant.category,
          dominantShare: dominant.share,
        };
      })
      .sort((left, right) => right.totalLeak - left.totalLeak);
  }

  private categoryTotals(
    attributions: CapitalLeakAttributionResult[],
  ): Partial<Record<CapitalLeakCategory, number>> {
    const totals: Partial<Record<CapitalLeakCategory, number>> = {};
    for (const attribution of attributions) {
      for (const contribution of attribution.contributions) {
        totals[contribution.category] =
          (totals[contribution.category] ?? 0) + contribution.leakAmount;
      }
    }
    return totals;
  }

  private dominant(categoryTotals: Partial<Record<CapitalLeakCategory, number>>): {
    category: CapitalLeakCategory | null;
    share: number;
  } {
    const entries = Object.entries(categoryTotals) as Array<[CapitalLeakCategory, number]>;
    if (entries.length === 0) {
      return { category: null, share: 0 };
    }
    const total = entries.reduce((sum, [, value]) => sum + value, 0);
    const [category, leak] = entries.sort((left, right) => right[1] - left[1])[0]!;
    return {
      category,
      share: total > 0 ? leak / total : 0,
    };
  }

  private sumLeak(attributions: CapitalLeakAttributionResult[]): number {
    return attributions.reduce((sum, entry) => sum + entry.totalLeak, 0);
  }

  private timeBucket(isoTimestamp: string): string {
    const date = new Date(isoTimestamp);
    if (Number.isNaN(date.getTime())) {
      return 'unknown_time_window';
    }
    date.setUTCMinutes(0, 0, 0);
    return date.toISOString();
  }
}
