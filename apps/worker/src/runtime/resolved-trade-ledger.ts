import fs from 'fs/promises';
import path from 'path';
import type { ResolvedTradeRecord } from '@polymarket-btc-5m-agentic-bot/domain';
import { AppLogger } from '@worker/common/logger';
import { resolveRepositoryRoot } from './learning-state-store';

export interface ResolvedTradeWindow {
  start: Date | string;
  end: Date | string;
}

export interface AppendResolvedTradeResult {
  record: ResolvedTradeRecord;
  appended: boolean;
}

export class ResolvedTradeLedger {
  private readonly logger = new AppLogger('ResolvedTradeLedger');
  private readonly rootDir: string;
  private readonly ledgerPath: string;
  private readonly partitionDir: string;

  constructor(rootDir = path.join(resolveRepositoryRoot(), 'artifacts/learning')) {
    this.rootDir = rootDir;
    this.ledgerPath = path.join(rootDir, 'resolved-trades.jsonl');
    this.partitionDir = path.join(rootDir, 'resolved-trades');
  }

  async append(record: ResolvedTradeRecord): Promise<AppendResolvedTradeResult> {
    await this.ensureDirectories();
    const existing = await this.findByOrderId(record.orderId);
    if (existing) {
      return {
        record: existing,
        appended: false,
      };
    }

    const normalized = normalizeResolvedTradeRecord(record);
    await this.appendLine(this.ledgerPath, normalized);
    await this.appendLine(
      path.join(this.partitionDir, `${normalized.finalizedTimestamp.slice(0, 10)}.jsonl`),
      normalized,
    );
    return {
      record: normalized,
      appended: true,
    };
  }

  async findByOrderId(orderId: string): Promise<ResolvedTradeRecord | null> {
    if (orderId.trim().length === 0) {
      return null;
    }

    const records = await this.readAll();
    return records.find((record) => record.orderId === orderId) ?? null;
  }

  async loadWindow(window: ResolvedTradeWindow): Promise<ResolvedTradeRecord[]> {
    const start = readTimestamp(window.start);
    const end = readTimestamp(window.end);
    if (start == null || end == null) {
      return [];
    }

    const records = await this.readAll();
    return records.filter((record) => {
      const timestamp = readTimestamp(record.finalizedTimestamp) ?? readTimestamp(record.capturedAt);
      if (timestamp == null) {
        return false;
      }
      return timestamp >= start && timestamp <= end;
    });
  }

  async loadRecent(limit: number): Promise<ResolvedTradeRecord[]> {
    if (!Number.isFinite(limit) || limit <= 0) {
      return [];
    }

    const records = await this.readAll();
    return records
      .sort((left, right) => right.finalizedTimestamp.localeCompare(left.finalizedTimestamp))
      .slice(0, Math.floor(limit));
  }

  getPath(): string {
    return this.ledgerPath;
  }

  private async ensureDirectories(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.rootDir, { recursive: true }),
      fs.mkdir(this.partitionDir, { recursive: true }),
    ]);
  }

  private async appendLine(filePath: string, record: ResolvedTradeRecord): Promise<void> {
    const handle = await fs.open(filePath, 'a');
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async readAll(): Promise<ResolvedTradeRecord[]> {
    try {
      const content = await fs.readFile(this.ledgerPath, 'utf8');
      return content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .flatMap((line, index) => {
          try {
            return [normalizeResolvedTradeRecord(JSON.parse(line) as ResolvedTradeRecord)];
          } catch (error) {
            this.logger.warn('Skipping corrupt resolved-trade ledger line.', {
              lineNumber: index + 1,
              error: error instanceof Error ? error.message : String(error),
            });
            return [];
          }
        });
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }
  }
}

function normalizeResolvedTradeRecord(record: ResolvedTradeRecord): ResolvedTradeRecord {
  return {
    ...record,
    tradeId: record.tradeId,
    orderId: record.orderId,
    venueOrderId: record.venueOrderId ?? null,
    strategyVariantId: record.strategyVariantId ?? null,
    strategyVersion: record.strategyVersion ?? null,
    regime: record.regime ?? null,
    archetype: record.archetype ?? null,
    decisionTimestamp: record.decisionTimestamp ?? null,
    submissionTimestamp: record.submissionTimestamp ?? null,
    firstFillTimestamp: record.firstFillTimestamp ?? null,
    averageFillPrice: finiteOrNull(record.averageFillPrice),
    estimatedFeeAtDecision: finiteOrNull(record.estimatedFeeAtDecision),
    realizedFee: finiteOrZero(record.realizedFee),
    estimatedSlippageBps: finiteOrNull(record.estimatedSlippageBps),
    realizedSlippageBps: finiteOrNull(record.realizedSlippageBps),
    queueDelayMs: finiteOrNull(record.queueDelayMs),
    fillFraction: clampFraction(record.fillFraction),
    expectedNetEdgeBps: finiteOrNull(record.expectedNetEdgeBps),
    realizedNetEdgeBps: finiteOrNull(record.realizedNetEdgeBps),
    maxFavorableExcursionBps: finiteOrNull(record.maxFavorableExcursionBps),
    maxAdverseExcursionBps: finiteOrNull(record.maxAdverseExcursionBps),
    toxicityScoreAtDecision: finiteOrNull(record.toxicityScoreAtDecision),
    lifecycleState: record.lifecycleState,
    attribution: {
      benchmarkContext: record.attribution.benchmarkContext ?? null,
      lossAttributionCategory: record.attribution.lossAttributionCategory ?? null,
      executionAttributionCategory:
        record.attribution.executionAttributionCategory ?? null,
      primaryLeakageDriver: record.attribution.primaryLeakageDriver ?? null,
      secondaryLeakageDrivers: [...new Set(record.attribution.secondaryLeakageDrivers ?? [])],
      reasonCodes: [...new Set(record.attribution.reasonCodes ?? [])],
    },
    executionQuality: {
      ...record.executionQuality,
      averageFillPrice: finiteOrNull(record.executionQuality.averageFillPrice),
      notional: finiteOrZero(record.executionQuality.notional),
      estimatedFeeAtDecision: finiteOrNull(record.executionQuality.estimatedFeeAtDecision),
      realizedFee: finiteOrZero(record.executionQuality.realizedFee),
      estimatedSlippageBps: finiteOrNull(record.executionQuality.estimatedSlippageBps),
      realizedSlippageBps: finiteOrNull(record.executionQuality.realizedSlippageBps),
      queueDelayMs: finiteOrNull(record.executionQuality.queueDelayMs),
      fillFraction: clampFraction(record.executionQuality.fillFraction),
    },
    netOutcome: {
      ...record.netOutcome,
      expectedNetEdgeBps: finiteOrNull(record.netOutcome.expectedNetEdgeBps),
      realizedNetEdgeBps: finiteOrNull(record.netOutcome.realizedNetEdgeBps),
      maxFavorableExcursionBps: finiteOrNull(record.netOutcome.maxFavorableExcursionBps),
      maxAdverseExcursionBps: finiteOrNull(record.netOutcome.maxAdverseExcursionBps),
      realizedPnl: finiteOrNull(record.netOutcome.realizedPnl),
    },
    benchmarkContext: record.benchmarkContext ?? null,
    lossAttributionCategory: record.lossAttributionCategory ?? null,
    executionAttributionCategory: record.executionAttributionCategory ?? null,
  };
}

function readTimestamp(value: Date | string | null | undefined): number | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime();
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function finiteOrZero(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function clampFraction(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT',
  );
}
