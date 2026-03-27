import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';
import type {
  ExecutionStyle,
  LiquidityBucket,
  NetEdgeVenueUncertaintyLabel,
  SpreadBucket,
} from '@polymarket-btc-5m-agentic-bot/domain';

export type FillRealismConfidence = 'low' | 'medium' | 'high';
export type FillRealismOrderUrgency = 'low' | 'medium' | 'high';

export interface FillRealismBucketKey {
  spreadBucket: SpreadBucket;
  liquidityBucket: LiquidityBucket;
  orderUrgency: FillRealismOrderUrgency;
  regime: string | null;
  executionStyle: ExecutionStyle;
  venueUncertaintyLabel: NetEdgeVenueUncertaintyLabel | null;
}

export interface FillRealismObservation {
  observationId: string;
  orderId: string;
  tradeId: string | null;
  bucket: FillRealismBucketKey;
  fillProbabilityWithin1s: number;
  fillProbabilityWithin3s: number;
  fillProbabilityWithin5s: number;
  fillProbabilityWithin10s: number;
  fillFraction: number;
  queueDelayMs: number | null;
  cancelSuccessLatencyMs: number | null;
  slippageBps: number | null;
  capturedAt: string;
}

export interface FillRealismQueueDelayProfile {
  averageMs: number | null;
  p50Ms: number | null;
  p90Ms: number | null;
}

export interface FillRealismSummary {
  bucket: FillRealismBucketKey;
  sampleCount: number;
  fillProbabilityWithin1s: number | null;
  fillProbabilityWithin3s: number | null;
  fillProbabilityWithin5s: number | null;
  fillProbabilityWithin10s: number | null;
  averageFillFraction: number | null;
  averageQueueDelayMs: number | null;
  cancelSuccessLatencyMs: number | null;
  averageSlippageBps: number | null;
  queueDelayProfile: FillRealismQueueDelayProfile;
  confidence: FillRealismConfidence;
  windowStart: string | null;
  windowEnd: string | null;
  capturedAt: string;
}

export interface FillRealismWindowInput {
  bucket: FillRealismBucketKey;
  start?: Date | string | null;
  end?: Date | string | null;
  limit?: number | null;
}

export class FillRealismStore {
  private readonly rootDir: string;
  private readonly logPath: string;

  constructor(rootDir = path.join(resolveRepositoryRoot(), 'artifacts/learning/fill-realism')) {
    this.rootDir = rootDir;
    this.logPath = path.join(rootDir, 'fill-realism.jsonl');
  }

  async append(observation: FillRealismObservation): Promise<boolean> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const normalized = normalizeObservation(observation);
    const existing = this.findByObservationId(normalized.observationId);
    if (existing) {
      return false;
    }

    const handle = await fs.open(this.logPath, 'a');
    try {
      await handle.writeFile(`${JSON.stringify(normalized)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  }

  findByObservationId(observationId: string): FillRealismObservation | null {
    if (observationId.trim().length === 0) {
      return null;
    }
    return this.readAll().find((entry) => entry.observationId === observationId) ?? null;
  }

  loadRecent(limit: number): FillRealismObservation[] {
    if (!Number.isFinite(limit) || limit <= 0) {
      return [];
    }
    return this.readAll()
      .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))
      .slice(0, Math.floor(limit));
  }

  loadWindow(input: FillRealismWindowInput): FillRealismObservation[] {
    const start = parseTimestamp(input.start ?? null);
    const end = parseTimestamp(input.end ?? null);
    const limit = Number.isFinite(input.limit ?? Number.NaN)
      ? Math.max(0, Math.floor(input.limit ?? 0))
      : null;

    let records = this.readAll().filter((entry) => bucketKey(entry.bucket) === bucketKey(input.bucket));
    if (start != null || end != null) {
      records = records.filter((entry) => {
        const observedAt = parseTimestamp(entry.capturedAt);
        if (observedAt == null) {
          return false;
        }
        if (start != null && observedAt < start) {
          return false;
        }
        if (end != null && observedAt > end) {
          return false;
        }
        return true;
      });
    }

    records.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
    return limit != null && limit > 0 ? records.slice(0, limit) : records;
  }

  summarize(input: FillRealismWindowInput): FillRealismSummary {
    const records = this.loadWindow(input);
    const ascending = [...records].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));

    return {
      bucket: normalizeBucket(input.bucket),
      sampleCount: records.length,
      fillProbabilityWithin1s: average(records.map((entry) => entry.fillProbabilityWithin1s)),
      fillProbabilityWithin3s: average(records.map((entry) => entry.fillProbabilityWithin3s)),
      fillProbabilityWithin5s: average(records.map((entry) => entry.fillProbabilityWithin5s)),
      fillProbabilityWithin10s: average(records.map((entry) => entry.fillProbabilityWithin10s)),
      averageFillFraction: average(records.map((entry) => entry.fillFraction)),
      averageQueueDelayMs: average(records.map((entry) => entry.queueDelayMs)),
      cancelSuccessLatencyMs: average(records.map((entry) => entry.cancelSuccessLatencyMs)),
      averageSlippageBps: average(records.map((entry) => entry.slippageBps)),
      queueDelayProfile: {
        averageMs: average(records.map((entry) => entry.queueDelayMs)),
        p50Ms: percentile(records.map((entry) => entry.queueDelayMs), 0.5),
        p90Ms: percentile(records.map((entry) => entry.queueDelayMs), 0.9),
      },
      confidence: summarizeConfidence(records.length),
      windowStart: ascending[0]?.capturedAt ?? null,
      windowEnd: ascending.at(-1)?.capturedAt ?? null,
      capturedAt: new Date().toISOString(),
    };
  }

  getPath(): string {
    return this.logPath;
  }

  private readAll(): FillRealismObservation[] {
    try {
      const content = fsSync.readFileSync(this.logPath, 'utf8');
      return content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => normalizeObservation(JSON.parse(line) as FillRealismObservation));
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }
  }
}

export function buildFillRealismBucket(input: {
  spreadBucket: SpreadBucket | null | undefined;
  liquidityBucket: LiquidityBucket | null | undefined;
  orderUrgency: FillRealismOrderUrgency | null | undefined;
  regime?: string | null;
  executionStyle?: ExecutionStyle | null;
  venueUncertaintyLabel?: NetEdgeVenueUncertaintyLabel | null;
}): FillRealismBucketKey {
  return normalizeBucket({
    spreadBucket: input.spreadBucket ?? 'unknown',
    liquidityBucket: input.liquidityBucket ?? 'unknown',
    orderUrgency: input.orderUrgency ?? 'medium',
    regime: input.regime ?? null,
    executionStyle: input.executionStyle ?? 'unknown',
    venueUncertaintyLabel: input.venueUncertaintyLabel ?? null,
  });
}

export function bucketKey(bucket: FillRealismBucketKey): string {
  const normalized = normalizeBucket(bucket);
  return [
    normalized.spreadBucket,
    normalized.liquidityBucket,
    normalized.orderUrgency,
    normalized.regime ?? 'all',
    normalized.executionStyle,
    normalized.venueUncertaintyLabel ?? 'unknown',
  ].join('|');
}

function normalizeObservation(observation: FillRealismObservation): FillRealismObservation {
  return {
    observationId: observation.observationId,
    orderId: observation.orderId,
    tradeId: observation.tradeId ?? null,
    bucket: normalizeBucket(observation.bucket),
    fillProbabilityWithin1s: clampUnit(observation.fillProbabilityWithin1s),
    fillProbabilityWithin3s: clampUnit(observation.fillProbabilityWithin3s),
    fillProbabilityWithin5s: clampUnit(observation.fillProbabilityWithin5s),
    fillProbabilityWithin10s: clampUnit(observation.fillProbabilityWithin10s),
    fillFraction: clampUnit(observation.fillFraction),
    queueDelayMs: finiteOrNull(observation.queueDelayMs),
    cancelSuccessLatencyMs: finiteOrNull(observation.cancelSuccessLatencyMs),
    slippageBps: finiteOrNull(observation.slippageBps),
    capturedAt: normalizeTimestamp(observation.capturedAt),
  };
}

function normalizeBucket(bucket: FillRealismBucketKey): FillRealismBucketKey {
  return {
    spreadBucket: bucket.spreadBucket ?? 'unknown',
    liquidityBucket: bucket.liquidityBucket ?? 'unknown',
    orderUrgency: bucket.orderUrgency ?? 'medium',
    regime: readNullableString(bucket.regime),
    executionStyle: bucket.executionStyle ?? 'unknown',
    venueUncertaintyLabel: bucket.venueUncertaintyLabel ?? null,
  };
}

function summarizeConfidence(sampleCount: number): FillRealismConfidence {
  if (sampleCount >= 12) {
    return 'high';
  }
  if (sampleCount >= 4) {
    return 'medium';
  }
  return 'low';
}

function average(values: Array<number | null | undefined>): number | null {
  const filtered = values.filter((value): value is number => Number.isFinite(value ?? Number.NaN));
  if (filtered.length === 0) {
    return null;
  }
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function percentile(values: Array<number | null | undefined>, target: number): number | null {
  const filtered = values
    .filter((value): value is number => Number.isFinite(value ?? Number.NaN))
    .sort((left, right) => left - right);
  if (filtered.length === 0) {
    return null;
  }
  const index = Math.min(filtered.length - 1, Math.max(0, Math.round((filtered.length - 1) * target)));
  return filtered[index] ?? null;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clampUnit(value: number | null | undefined): number {
  if (!Number.isFinite(value ?? Number.NaN)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value ?? 0));
}

function normalizeTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function parseTimestamp(value: Date | string | null | undefined): number | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime();
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function readNullableString(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resolveRepositoryRoot(start = process.cwd()): string {
  let current = path.resolve(start);
  while (true) {
    const markers = [
      path.join(current, 'pnpm-workspace.yaml'),
      path.join(current, 'AGENTS.md'),
    ];
    try {
      if (markers.some((marker) => fsSync.existsSync(marker))) {
        return current;
      }
    } catch {
      return start;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return start;
    }
    current = parent;
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT',
  );
}
