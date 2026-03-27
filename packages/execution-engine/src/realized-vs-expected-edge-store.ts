import type { ResolvedTradeRecord } from '@polymarket-btc-5m-agentic-bot/domain';

export interface ResolvedTradeEvidenceSource {
  loadWindow(input: {
    start: Date | string;
    end: Date | string;
  }): Promise<ResolvedTradeRecord[]>;
  loadRecent(limit: number): Promise<ResolvedTradeRecord[]>;
}

export interface RealizedVsExpectedEdgeRecord {
  tradeId: string;
  orderId: string;
  strategyVariantId: string | null;
  regime: string | null;
  archetype: string | null;
  marketId: string;
  expectedNetEdgeBps: number | null;
  realizedNetEdgeBps: number | null;
  realizedVsExpectedDeltaBps: number | null;
  retentionRatio: number | null;
  finalizedTimestamp: string;
  lossAttributionCategory: string | null;
  executionAttributionCategory: string | null;
}

export interface RealizedVsExpectedEdgeSummary {
  sampleCount: number;
  averageExpectedNetEdgeBps: number | null;
  averageRealizedNetEdgeBps: number | null;
  averageRetentionRatio: number | null;
  averageDeltaBps: number | null;
}

export class RealizedVsExpectedEdgeStore {
  constructor(private readonly source: ResolvedTradeEvidenceSource) {}

  async loadRecent(limit: number): Promise<RealizedVsExpectedEdgeRecord[]> {
    const records = await this.source.loadRecent(limit);
    return records.map((record) => this.toRecord(record));
  }

  async loadWindow(input: {
    start: Date | string;
    end: Date | string;
  }): Promise<RealizedVsExpectedEdgeRecord[]> {
    const records = await this.source.loadWindow(input);
    return records.map((record) => this.toRecord(record));
  }

  async summarizeWindow(input: {
    start: Date | string;
    end: Date | string;
  }): Promise<RealizedVsExpectedEdgeSummary> {
    const records = await this.loadWindow(input);
    return {
      sampleCount: records.length,
      averageExpectedNetEdgeBps: average(records.map((item) => item.expectedNetEdgeBps)),
      averageRealizedNetEdgeBps: average(records.map((item) => item.realizedNetEdgeBps)),
      averageRetentionRatio: average(records.map((item) => item.retentionRatio)),
      averageDeltaBps: average(records.map((item) => item.realizedVsExpectedDeltaBps)),
    };
  }

  private toRecord(record: ResolvedTradeRecord): RealizedVsExpectedEdgeRecord {
    const expectedNetEdgeBps =
      finiteOrNull(record.netOutcome.expectedNetEdgeBps) ??
      finiteOrNull(record.expectedNetEdgeBps);
    const realizedNetEdgeBps =
      finiteOrNull(record.netOutcome.realizedNetEdgeBps) ??
      finiteOrNull(record.realizedNetEdgeBps);
    const realizedVsExpectedDeltaBps =
      expectedNetEdgeBps != null && realizedNetEdgeBps != null
        ? realizedNetEdgeBps - expectedNetEdgeBps
        : null;
    const retentionRatio =
      expectedNetEdgeBps != null &&
      realizedNetEdgeBps != null &&
      Math.abs(expectedNetEdgeBps) > 1e-9
        ? realizedNetEdgeBps / expectedNetEdgeBps
        : null;

    return {
      tradeId: record.tradeId,
      orderId: record.orderId,
      strategyVariantId: record.strategyVariantId,
      regime: record.regime,
      archetype: record.archetype,
      marketId: record.marketId,
      expectedNetEdgeBps,
      realizedNetEdgeBps,
      realizedVsExpectedDeltaBps,
      retentionRatio,
      finalizedTimestamp: record.finalizedTimestamp,
      lossAttributionCategory:
        record.attribution.lossAttributionCategory ?? record.lossAttributionCategory,
      executionAttributionCategory:
        record.attribution.executionAttributionCategory ??
        record.executionAttributionCategory,
    };
  }
}

function average(values: Array<number | null | undefined>): number | null {
  const filtered = values.filter((value): value is number => Number.isFinite(value ?? Number.NaN));
  if (filtered.length === 0) {
    return null;
  }
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
