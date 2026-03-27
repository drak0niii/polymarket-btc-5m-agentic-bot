import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';
import type { NetEdgeVenueUncertaintyLabel } from '@polymarket-btc-5m-agentic-bot/domain';
import {
  type FillRealismBucketKey,
  bucketKey,
  buildFillRealismBucket,
} from './fill-realism-store';

export type PostFillToxicityConfidence = 'low' | 'medium' | 'high';

export interface PostFillToxicityObservation {
  observationId: string;
  orderId: string;
  tradeId: string;
  bucket: FillRealismBucketKey;
  drift1sBps: number | null;
  drift3sBps: number | null;
  drift10sBps: number | null;
  drift30sBps: number | null;
  capturedAt: string;
}

export interface PostFillToxicitySummary {
  bucket: FillRealismBucketKey;
  sampleCount: number;
  averageDrift1sBps: number | null;
  averageDrift3sBps: number | null;
  averageDrift10sBps: number | null;
  averageDrift30sBps: number | null;
  expectedAdverseSelectionPenaltyBps: number | null;
  confidence: PostFillToxicityConfidence;
  windowStart: string | null;
  windowEnd: string | null;
  capturedAt: string;
}

export interface PostFillToxicityWindowInput {
  bucket: FillRealismBucketKey;
  start?: Date | string | null;
  end?: Date | string | null;
  limit?: number | null;
}

export class PostFillToxicityStore {
  private readonly rootDir: string;
  private readonly logPath: string;

  constructor(
    rootDir = path.join(resolveRepositoryRoot(), 'artifacts/learning/post-fill-toxicity'),
  ) {
    this.rootDir = rootDir;
    this.logPath = path.join(rootDir, 'post-fill-toxicity.jsonl');
  }

  async append(observation: PostFillToxicityObservation): Promise<boolean> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const normalized = normalizeObservation(observation);
    if (this.findByObservationId(normalized.observationId)) {
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

  findByObservationId(observationId: string): PostFillToxicityObservation | null {
    if (observationId.trim().length === 0) {
      return null;
    }
    return this.readAll().find((entry) => entry.observationId === observationId) ?? null;
  }

  loadRecent(limit: number): PostFillToxicityObservation[] {
    if (!Number.isFinite(limit) || limit <= 0) {
      return [];
    }
    return this.readAll()
      .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))
      .slice(0, Math.floor(limit));
  }

  loadWindow(input: PostFillToxicityWindowInput): PostFillToxicityObservation[] {
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

  summarize(input: PostFillToxicityWindowInput): PostFillToxicitySummary {
    const records = this.loadWindow(input);
    const ascending = [...records].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
    const averageDrift1sBps = average(records.map((entry) => entry.drift1sBps));
    const averageDrift3sBps = average(records.map((entry) => entry.drift3sBps));
    const averageDrift10sBps = average(records.map((entry) => entry.drift10sBps));
    const averageDrift30sBps = average(records.map((entry) => entry.drift30sBps));

    return {
      bucket: buildFillRealismBucket({
        ...input.bucket,
        venueUncertaintyLabel:
          (input.bucket.venueUncertaintyLabel as NetEdgeVenueUncertaintyLabel | null) ?? null,
      }),
      sampleCount: records.length,
      averageDrift1sBps,
      averageDrift3sBps,
      averageDrift10sBps,
      averageDrift30sBps,
      expectedAdverseSelectionPenaltyBps: maxNullable(
        averageDrift1sBps,
        averageDrift3sBps,
        averageDrift10sBps,
        averageDrift30sBps,
      ),
      confidence: summarizeConfidence(records.length),
      windowStart: ascending[0]?.capturedAt ?? null,
      windowEnd: ascending.at(-1)?.capturedAt ?? null,
      capturedAt: new Date().toISOString(),
    };
  }

  getPath(): string {
    return this.logPath;
  }

  private readAll(): PostFillToxicityObservation[] {
    try {
      const content = fsSync.readFileSync(this.logPath, 'utf8');
      return content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => normalizeObservation(JSON.parse(line) as PostFillToxicityObservation));
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }
  }
}

function normalizeObservation(
  observation: PostFillToxicityObservation,
): PostFillToxicityObservation {
  return {
    observationId: observation.observationId,
    orderId: observation.orderId,
    tradeId: observation.tradeId,
    bucket: buildFillRealismBucket(observation.bucket),
    drift1sBps: finiteOrNull(observation.drift1sBps),
    drift3sBps: finiteOrNull(observation.drift3sBps),
    drift10sBps: finiteOrNull(observation.drift10sBps),
    drift30sBps: finiteOrNull(observation.drift30sBps),
    capturedAt: normalizeTimestamp(observation.capturedAt),
  };
}

function summarizeConfidence(sampleCount: number): PostFillToxicityConfidence {
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

function maxNullable(...values: Array<number | null | undefined>): number | null {
  const filtered = values.filter((value): value is number => Number.isFinite(value ?? Number.NaN));
  if (filtered.length === 0) {
    return null;
  }
  return Math.max(...filtered);
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null;
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
