import fs from 'fs/promises';
import path from 'path';
import type { RegimeLabel } from '../regime-classifier';
import type {
  NoTradeClassifierConditions,
  NoTradeReasonCode,
} from './no-trade-classifier';

export interface NoTradeReasonRecord {
  timestamp: string;
  marketId: string;
  tokenId: string | null;
  strategyVariantId: string | null;
  regimeLabel: RegimeLabel | string | null;
  regimeConfidence: number | null;
  regimeTransitionRisk: number | null;
  allowTrade: boolean;
  reasonCodes: NoTradeReasonCode[];
  conditions: NoTradeClassifierConditions;
  expectedNetEdgeBps: number | null;
  evidenceSummary: {
    source: 'build_signals' | 'evaluate_trade_opportunities' | 'unknown';
    signalId?: string | null;
    signalDecisionId?: string | null;
    regimeEvidenceQuality?: string | null;
    empiricalBlockRate?: number | null;
    sampleCount?: number | null;
    notes?: string[];
  };
}

export interface NoTradeReasonSummaryEntry {
  key: string;
  sampleCount: number;
  blockedCount: number;
  blockRate: number;
}

export interface NoTradeReasonSummary {
  totalCount: number;
  blockedCount: number;
  allowTradeCount: number;
  blockRate: number;
  dominantReasonCodes: NoTradeReasonCode[];
  byReasonCode: Array<NoTradeReasonSummaryEntry & { reasonCode: NoTradeReasonCode }>;
  byRegime: Array<NoTradeReasonSummaryEntry & { regimeLabel: string | null }>;
}

export interface NoTradeSummaryQuery {
  limit?: number;
  regimeLabel?: string | null;
  strategyVariantId?: string | null;
}

export class NoTradeReasonStore {
  private readonly rootDir: string;
  private readonly storePath: string;

  constructor(rootDir = path.join(resolveRepositoryRoot(), 'artifacts/learning/no-trade')) {
    this.rootDir = rootDir;
    this.storePath = path.join(rootDir, 'no-trade-reasons.jsonl');
  }

  async append(record: NoTradeReasonRecord): Promise<NoTradeReasonRecord> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const normalized = normalizeRecord(record);
    const handle = await fs.open(this.storePath, 'a');
    try {
      await handle.writeFile(`${JSON.stringify(normalized)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return normalized;
  }

  async loadRecent(limit = 100): Promise<NoTradeReasonRecord[]> {
    const records = await this.readAll();
    return records.slice(-Math.max(0, Math.floor(limit))).reverse();
  }

  async summarizeRecent(query: NoTradeSummaryQuery = {}): Promise<NoTradeReasonSummary> {
    const records = await this.readAll();
    const filtered = records
      .filter((record) =>
        query.regimeLabel == null ? true : record.regimeLabel === query.regimeLabel,
      )
      .filter((record) =>
        query.strategyVariantId == null
          ? true
          : record.strategyVariantId === query.strategyVariantId,
      );
    const selected =
      query.limit != null && Number.isFinite(query.limit)
        ? filtered.slice(-Math.max(0, Math.floor(query.limit)))
        : filtered;

    const byReasonCode = new Map<NoTradeReasonCode, { sampleCount: number; blockedCount: number }>();
    const byRegime = new Map<string, { sampleCount: number; blockedCount: number }>();

    for (const record of selected) {
      const regimeKey = record.regimeLabel ?? 'unknown';
      const regimeEntry = byRegime.get(regimeKey) ?? { sampleCount: 0, blockedCount: 0 };
      regimeEntry.sampleCount += 1;
      if (!record.allowTrade) {
        regimeEntry.blockedCount += 1;
      }
      byRegime.set(regimeKey, regimeEntry);

      for (const reasonCode of record.reasonCodes) {
        const reasonEntry = byReasonCode.get(reasonCode) ?? {
          sampleCount: 0,
          blockedCount: 0,
        };
        reasonEntry.sampleCount += 1;
        if (!record.allowTrade) {
          reasonEntry.blockedCount += 1;
        }
        byReasonCode.set(reasonCode, reasonEntry);
      }
    }

    const blockedCount = selected.filter((record) => !record.allowTrade).length;
    const allowTradeCount = selected.length - blockedCount;
    const reasonEntries = [...byReasonCode.entries()]
      .map(([reasonCode, entry]) => ({
        reasonCode,
        key: reasonCode,
        sampleCount: entry.sampleCount,
        blockedCount: entry.blockedCount,
        blockRate: entry.sampleCount > 0 ? entry.blockedCount / entry.sampleCount : 0,
      }))
      .sort((left, right) => {
        if (right.blockedCount !== left.blockedCount) {
          return right.blockedCount - left.blockedCount;
        }
        return right.sampleCount - left.sampleCount;
      });
    const regimeEntries = [...byRegime.entries()]
      .map(([regimeLabel, entry]) => ({
        regimeLabel: regimeLabel === 'unknown' ? null : regimeLabel,
        key: regimeLabel,
        sampleCount: entry.sampleCount,
        blockedCount: entry.blockedCount,
        blockRate: entry.sampleCount > 0 ? entry.blockedCount / entry.sampleCount : 0,
      }))
      .sort((left, right) => {
        if (right.blockRate !== left.blockRate) {
          return right.blockRate - left.blockRate;
        }
        return right.sampleCount - left.sampleCount;
      });

    return {
      totalCount: selected.length,
      blockedCount,
      allowTradeCount,
      blockRate: selected.length > 0 ? blockedCount / selected.length : 0,
      dominantReasonCodes: reasonEntries.slice(0, 3).map((entry) => entry.reasonCode),
      byReasonCode: reasonEntries,
      byRegime: regimeEntries,
    };
  }

  getPath(): string {
    return this.storePath;
  }

  private async readAll(): Promise<NoTradeReasonRecord[]> {
    try {
      const content = await fs.readFile(this.storePath, 'utf8');
      return content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => normalizeRecord(JSON.parse(line) as NoTradeReasonRecord));
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }
  }
}

function normalizeRecord(record: NoTradeReasonRecord): NoTradeReasonRecord {
  return {
    ...record,
    tokenId: record.tokenId ?? null,
    strategyVariantId: record.strategyVariantId ?? null,
    regimeLabel: record.regimeLabel ?? null,
    regimeConfidence: finiteOrNull(record.regimeConfidence),
    regimeTransitionRisk: finiteOrNull(record.regimeTransitionRisk),
    allowTrade: Boolean(record.allowTrade),
    reasonCodes: [...new Set(record.reasonCodes ?? [])],
    conditions: {
      ...record.conditions,
      spread: finiteOrNull(record.conditions.spread),
      spreadLimit: finiteOrNull(record.conditions.spreadLimit),
      orderbookFresh: Boolean(record.conditions.orderbookFresh),
      orderbookAgeMs: finiteOrNull(record.conditions.orderbookAgeMs),
      topLevelDepth: finiteOrNull(record.conditions.topLevelDepth),
      minimumTopLevelDepth: finiteOrNull(record.conditions.minimumTopLevelDepth),
      toxicityScore: finiteOrNull(record.conditions.toxicityScore),
      toxicityState: record.conditions.toxicityState ?? null,
      venueUncertaintyLabel: record.conditions.venueUncertaintyLabel ?? null,
      regimeLabel: record.conditions.regimeLabel ?? null,
      regimeConfidence: finiteOrNull(record.conditions.regimeConfidence),
      regimeTransitionRisk: finiteOrNull(record.conditions.regimeTransitionRisk),
      expectedNetEdgeBps: finiteOrNull(record.conditions.expectedNetEdgeBps),
      minimumNetEdgeBps: finiteOrNull(record.conditions.minimumNetEdgeBps),
      empiricalBlockRate: finiteOrNull(record.conditions.empiricalBlockRate),
      empiricalSampleCount: finiteOrNull(record.conditions.empiricalSampleCount),
      timeToExpirySeconds: finiteOrNull(record.conditions.timeToExpirySeconds),
      noTradeWindowSeconds: finiteOrNull(record.conditions.noTradeWindowSeconds),
    },
    expectedNetEdgeBps: finiteOrNull(record.expectedNetEdgeBps),
    evidenceSummary: {
      source: record.evidenceSummary?.source ?? 'unknown',
      signalId: record.evidenceSummary?.signalId ?? null,
      signalDecisionId: record.evidenceSummary?.signalDecisionId ?? null,
      regimeEvidenceQuality: record.evidenceSummary?.regimeEvidenceQuality ?? null,
      empiricalBlockRate: finiteOrNull(record.evidenceSummary?.empiricalBlockRate),
      sampleCount: finiteOrNull(record.evidenceSummary?.sampleCount),
      notes: [...new Set(record.evidenceSummary?.notes ?? [])],
    },
  };
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function resolveRepositoryRoot(): string {
  return path.resolve(__dirname, '../../../..');
}

function isNotFound(error: unknown): boolean {
  return (
    Boolean(error) &&
    typeof error === 'object' &&
    'code' in (error as Record<string, unknown>) &&
    (error as { code?: string }).code === 'ENOENT'
  );
}
