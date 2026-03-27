import fs from 'fs/promises';
import path from 'path';
import type { ResolvedTradeRecord } from '@polymarket-btc-5m-agentic-bot/domain';
import { LearningStateStore } from '@worker/runtime/learning-state-store';

export interface DailyDecisionQualityRejectedDecision {
  timestamp: string;
  regime: string | null;
  reasonCodes: string[];
}

export interface DailyDecisionQualityReasonCount {
  reasonCode: string;
  count: number;
}

export interface DailyDecisionQualitySlice {
  sliceKey: string;
  tradeCount: number;
  winRate: number | null;
  grossPnl: number;
  netPnlAfterFees: number;
  expectedEdgeSumBps: number;
  realizedEdgeSumBps: number;
  realizedVsExpectedGapBps: number | null;
  averageSlippageBps: number | null;
  averageAdverseSelectionBps: number | null;
  benchmarkReference: 'no_trade_baseline';
  benchmarkRelativePnl: number;
  topRejectedReasonCodes: DailyDecisionQualityReasonCount[];
  topLossReasonCodes: DailyDecisionQualityReasonCount[];
}

export interface DailyDecisionQualityReport {
  generatedAt: string;
  window: {
    from: string;
    to: string;
  };
  overall: DailyDecisionQualitySlice;
  byDay: DailyDecisionQualitySlice[];
  byRegime: DailyDecisionQualitySlice[];
  summary: {
    dayCount: number;
    regimeCount: number;
    positiveNetDayCount: number;
    negativeNetDayCount: number;
    capitalEfficiencyRatio: number | null;
  };
}

interface AggregateState {
  tradeCount: number;
  winCount: number;
  grossPnl: number;
  netPnlAfterFees: number;
  expectedEdgeSumBps: number;
  realizedEdgeSumBps: number;
  slippageValues: number[];
  adverseSelectionValues: number[];
  rejectedReasonCounts: Map<string, number>;
  lossReasonCounts: Map<string, number>;
}

export function buildDailyDecisionQualityReport(input: {
  from: Date;
  to: Date;
  resolvedTrades: ResolvedTradeRecord[];
  rejectedDecisions: DailyDecisionQualityRejectedDecision[];
  now?: Date;
}): DailyDecisionQualityReport {
  const now = input.now ?? new Date();
  const overall = createAggregateState();
  const byDay = new Map<string, AggregateState>();
  const byRegime = new Map<string, AggregateState>();

  for (const trade of input.resolvedTrades) {
    const dayKey = toDayKey(trade.finalizedTimestamp ?? trade.capturedAt);
    const regimeKey = trade.regime ?? 'unknown';
    const netPnl = readNetPnl(trade);
    const grossPnl = netPnl + finiteOrZero(trade.realizedFee);
    const expectedEdge = readExpectedNetEdgeBps(trade);
    const realizedEdge = readRealizedNetEdgeBps(trade);
    const slippageBps = finiteOrNull(trade.realizedSlippageBps);
    const adverseSelectionBps = estimateAdverseSelectionBps(trade);

    for (const aggregate of [
      overall,
      getOrCreateAggregate(byDay, dayKey),
      getOrCreateAggregate(byRegime, regimeKey),
    ]) {
      aggregate.tradeCount += 1;
      if (netPnl > 0 || (realizedEdge ?? 0) > 0) {
        aggregate.winCount += 1;
      }
      aggregate.grossPnl += grossPnl;
      aggregate.netPnlAfterFees += netPnl;
      aggregate.expectedEdgeSumBps += expectedEdge ?? 0;
      aggregate.realizedEdgeSumBps += realizedEdge ?? 0;
      if (slippageBps != null) {
        aggregate.slippageValues.push(slippageBps);
      }
      if (adverseSelectionBps != null) {
        aggregate.adverseSelectionValues.push(adverseSelectionBps);
      }
      if (netPnl < 0 || (realizedEdge ?? 0) < 0) {
        for (const reasonCode of collectLossReasonCodes(trade)) {
          incrementReason(aggregate.lossReasonCounts, reasonCode);
        }
      }
    }
  }

  for (const rejected of input.rejectedDecisions) {
    const dayKey = toDayKey(rejected.timestamp);
    const regimeKey = rejected.regime ?? 'unknown';
    for (const aggregate of [overall, getOrCreateAggregate(byDay, dayKey), getOrCreateAggregate(byRegime, regimeKey)]) {
      for (const reasonCode of rejected.reasonCodes) {
        incrementReason(aggregate.rejectedReasonCounts, reasonCode);
      }
    }
  }

  const overallSlice = toSlice('overall', overall);
  const byDaySlices = Array.from(byDay.entries())
    .map(([sliceKey, aggregate]) => toSlice(sliceKey, aggregate))
    .sort((left, right) => left.sliceKey.localeCompare(right.sliceKey));
  const byRegimeSlices = Array.from(byRegime.entries())
    .map(([sliceKey, aggregate]) => toSlice(sliceKey, aggregate))
    .sort((left, right) => left.sliceKey.localeCompare(right.sliceKey));

  const positiveNetDayCount = byDaySlices.filter((slice) => slice.netPnlAfterFees > 0).length;
  const negativeNetDayCount = byDaySlices.filter((slice) => slice.netPnlAfterFees < 0).length;

  return {
    generatedAt: now.toISOString(),
    window: {
      from: input.from.toISOString(),
      to: input.to.toISOString(),
    },
    overall: overallSlice,
    byDay: byDaySlices,
    byRegime: byRegimeSlices,
    summary: {
      dayCount: byDaySlices.length,
      regimeCount: byRegimeSlices.length,
      positiveNetDayCount,
      negativeNetDayCount,
      capitalEfficiencyRatio:
        Math.abs(overallSlice.grossPnl) <= 1e-9
          ? null
          : overallSlice.netPnlAfterFees / overallSlice.grossPnl,
    },
  };
}

export async function persistDailyDecisionQualityReport(
  report: DailyDecisionQualityReport,
  rootDir?: string,
): Promise<string> {
  const learningStateStore = new LearningStateStore();
  const resolvedRoot = rootDir ?? learningStateStore.getPaths().rootDir;
  const historyDir = path.join(resolvedRoot, 'daily-decision-quality');
  const latestPath = path.join(resolvedRoot, 'daily-decision-quality.latest.json');
  await fs.mkdir(historyDir, { recursive: true });
  const snapshotPath = path.join(
    historyDir,
    `${report.generatedAt.replace(/[:.]/g, '-')}.json`,
  );
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  await Promise.all([
    fs.writeFile(snapshotPath, serialized, 'utf8'),
    fs.writeFile(latestPath, serialized, 'utf8'),
  ]);
  return latestPath;
}

export async function readLatestDailyDecisionQualityReport(
  rootDir?: string,
): Promise<DailyDecisionQualityReport | null> {
  const learningStateStore = new LearningStateStore();
  const resolvedRoot = rootDir ?? learningStateStore.getPaths().rootDir;
  const latestPath = path.join(resolvedRoot, 'daily-decision-quality.latest.json');
  try {
    const content = await fs.readFile(latestPath, 'utf8');
    return JSON.parse(content) as DailyDecisionQualityReport;
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

function toSlice(sliceKey: string, aggregate: AggregateState): DailyDecisionQualitySlice {
  const winRate =
    aggregate.tradeCount === 0 ? null : aggregate.winCount / aggregate.tradeCount;
  return {
    sliceKey,
    tradeCount: aggregate.tradeCount,
    winRate,
    grossPnl: aggregate.grossPnl,
    netPnlAfterFees: aggregate.netPnlAfterFees,
    expectedEdgeSumBps: aggregate.expectedEdgeSumBps,
    realizedEdgeSumBps: aggregate.realizedEdgeSumBps,
    realizedVsExpectedGapBps:
      aggregate.tradeCount === 0
        ? null
        : aggregate.realizedEdgeSumBps - aggregate.expectedEdgeSumBps,
    averageSlippageBps: average(aggregate.slippageValues),
    averageAdverseSelectionBps: average(aggregate.adverseSelectionValues),
    benchmarkReference: 'no_trade_baseline',
    benchmarkRelativePnl: aggregate.netPnlAfterFees,
    topRejectedReasonCodes: topReasonCounts(aggregate.rejectedReasonCounts),
    topLossReasonCodes: topReasonCounts(aggregate.lossReasonCounts),
  };
}

function createAggregateState(): AggregateState {
  return {
    tradeCount: 0,
    winCount: 0,
    grossPnl: 0,
    netPnlAfterFees: 0,
    expectedEdgeSumBps: 0,
    realizedEdgeSumBps: 0,
    slippageValues: [],
    adverseSelectionValues: [],
    rejectedReasonCounts: new Map<string, number>(),
    lossReasonCounts: new Map<string, number>(),
  };
}

function getOrCreateAggregate(
  collection: Map<string, AggregateState>,
  key: string,
): AggregateState {
  const existing = collection.get(key);
  if (existing) {
    return existing;
  }
  const created = createAggregateState();
  collection.set(key, created);
  return created;
}

function readExpectedNetEdgeBps(record: ResolvedTradeRecord): number | null {
  return finiteOrNull(record.netOutcome.expectedNetEdgeBps) ?? finiteOrNull(record.expectedNetEdgeBps);
}

function readRealizedNetEdgeBps(record: ResolvedTradeRecord): number | null {
  return finiteOrNull(record.netOutcome.realizedNetEdgeBps) ?? finiteOrNull(record.realizedNetEdgeBps);
}

function readNetPnl(record: ResolvedTradeRecord): number {
  const realizedPnl = finiteOrNull(record.netOutcome.realizedPnl);
  if (realizedPnl != null) {
    return realizedPnl;
  }
  const realizedNetEdgeBps = readRealizedNetEdgeBps(record);
  if (realizedNetEdgeBps == null) {
    return 0;
  }
  return (realizedNetEdgeBps / 10_000) * finiteOrZero(record.notional);
}

function estimateAdverseSelectionBps(record: ResolvedTradeRecord): number | null {
  const expected = readExpectedNetEdgeBps(record);
  const realized = readRealizedNetEdgeBps(record);
  if (expected == null || realized == null) {
    return null;
  }
  const rawGap = Math.max(0, expected - realized);
  const excessSlippage = Math.max(
    0,
    finiteOrZero(record.realizedSlippageBps) - finiteOrZero(record.estimatedSlippageBps),
  );
  const toxicityFlagged =
    (record.toxicityScoreAtDecision ?? 0) >= 0.75 ||
    record.executionAttributionCategory === 'adverse_selection_spike' ||
    record.lossAttributionCategory === 'toxicity_damage';
  return toxicityFlagged ? rawGap : Math.max(0, rawGap - excessSlippage);
}

function collectLossReasonCodes(record: ResolvedTradeRecord): string[] {
  const reasons = record.attribution.reasonCodes.filter((value) => value.length > 0);
  if (reasons.length > 0) {
    return reasons;
  }
  return [
    record.lossAttributionCategory,
    record.executionAttributionCategory,
    record.attribution.primaryLeakageDriver,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function topReasonCounts(reasonCounts: Map<string, number>): DailyDecisionQualityReasonCount[] {
  return Array.from(reasonCounts.entries())
    .map(([reasonCode, count]) => ({ reasonCode, count }))
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }
      return left.reasonCode.localeCompare(right.reasonCode);
    })
    .slice(0, 5);
}

function incrementReason(reasonCounts: Map<string, number>, reasonCode: string): void {
  if (!reasonCode) {
    return;
  }
  reasonCounts.set(reasonCode, (reasonCounts.get(reasonCode) ?? 0) + 1);
}

function toDayKey(value: string): string {
  return value.slice(0, 10);
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function finiteOrZero(value: number | null | undefined): number {
  return finiteOrNull(value) ?? 0;
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT',
  );
}
