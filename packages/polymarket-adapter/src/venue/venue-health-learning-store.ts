import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';
import type {
  VenueRuntimeMode,
  VenueUncertaintyLabel,
} from '@polymarket-btc-5m-agentic-bot/domain';

export interface VenueLatencyDistribution {
  sampleCount: number;
  averageMs: number | null;
  p50Ms: number | null;
  p90Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
}

export interface VenueFailureMetrics {
  totalRequests: number;
  failedRequests: number;
  failureRate: number;
  failuresByCategory: Record<string, number>;
}

export interface VenueLagMetrics {
  sampleCount: number;
  averageMs: number | null;
  p90Ms: number | null;
  maxMs: number | null;
}

export interface VenueHealthMetrics {
  venueId: string;
  updatedAt: string;
  latencyDistribution: VenueLatencyDistribution;
  requestFailures: VenueFailureMetrics;
  staleDataIntervals: VenueLagMetrics;
  openOrderVisibilityLag: VenueLagMetrics;
  tradeVisibilityLag: VenueLagMetrics;
  cancelAcknowledgmentLag: VenueLagMetrics;
  activeMode: VenueRuntimeMode | null;
  uncertaintyLabel: VenueUncertaintyLabel | null;
}

export interface VenueHealthLearningState {
  schemaVersion: number;
  updatedAt: string;
  venueId: string;
  requestLatencyMsSamples: number[];
  requestFailureCountByCategory: Record<string, number>;
  totalRequests: number;
  staleDataIntervalMsSamples: number[];
  openOrderVisibilityLagMsSamples: number[];
  tradeVisibilityLagMsSamples: number[];
  cancelAcknowledgmentLagMsSamples: number[];
  activeMode: VenueRuntimeMode | null;
  uncertaintyLabel: VenueUncertaintyLabel | null;
}

export class VenueHealthLearningStore {
  private readonly rootDir: string;
  private readonly statePath: string;
  private readonly snapshotDir: string;
  private readonly corruptDir: string;

  constructor(rootDir = path.join(resolveRepositoryRoot(), 'artifacts/venue-health')) {
    this.rootDir = rootDir;
    this.statePath = path.join(rootDir, 'venue-health-learning.json');
    this.snapshotDir = path.join(rootDir, 'snapshots');
    this.corruptDir = path.join(rootDir, 'corrupt');
  }

  async load(): Promise<VenueHealthLearningState> {
    await this.ensureDirectories();

    try {
      const content = await fs.readFile(this.statePath, 'utf8');
      return normalizeVenueHealthState(JSON.parse(content));
    } catch (error) {
      const code = readErrorCode(error);
      if (code === 'ENOENT') {
        const state = createDefaultVenueHealthLearningState();
        await this.save(state);
        return state;
      }

      await this.quarantineCorruptPrimary();
      const recovered = await this.readLatestSnapshot();
      if (recovered) {
        return recovered;
      }

      const fallback = createDefaultVenueHealthLearningState();
      await this.save(fallback);
      return fallback;
    }
  }

  async save(state: VenueHealthLearningState): Promise<void> {
    await this.ensureDirectories();
    const normalized = normalizeVenueHealthState({
      ...state,
      updatedAt: new Date().toISOString(),
    });
    const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
    const tmpPath = `${this.statePath}.tmp`;

    try {
      await this.createSnapshotIfPresent();
      await fs.writeFile(tmpPath, serialized, 'utf8');
      await fs.rename(tmpPath, this.statePath);
      await this.pruneSnapshots();
    } catch (error) {
      await safeUnlink(tmpPath);
      throw error;
    }
  }

  async getCurrentMetrics(): Promise<VenueHealthMetrics> {
    const state = await this.load();
    return buildVenueHealthMetrics(state);
  }

  async recordRequest(input: {
    latencyMs: number | null;
    failureCategory?: string | null;
  }): Promise<VenueHealthMetrics> {
    const state = await this.load();
    const next = {
      ...state,
      totalRequests: state.totalRequests + 1,
      requestLatencyMsSamples:
        input.latencyMs != null
          ? appendSample(state.requestLatencyMsSamples, input.latencyMs)
          : state.requestLatencyMsSamples,
      requestFailureCountByCategory: { ...state.requestFailureCountByCategory },
    };
    if (input.failureCategory) {
      next.requestFailureCountByCategory[input.failureCategory] =
        (next.requestFailureCountByCategory[input.failureCategory] ?? 0) + 1;
    }
    await this.save(next);
    return buildVenueHealthMetrics(next);
  }

  async recordStaleDataInterval(intervalMs: number): Promise<VenueHealthMetrics> {
    return this.recordLagSample('staleDataIntervalMsSamples', intervalMs);
  }

  async recordOpenOrderVisibilityLag(lagMs: number): Promise<VenueHealthMetrics> {
    return this.recordLagSample('openOrderVisibilityLagMsSamples', lagMs);
  }

  async recordTradeVisibilityLag(lagMs: number): Promise<VenueHealthMetrics> {
    return this.recordLagSample('tradeVisibilityLagMsSamples', lagMs);
  }

  async recordCancelAcknowledgmentLag(lagMs: number): Promise<VenueHealthMetrics> {
    return this.recordLagSample('cancelAcknowledgmentLagMsSamples', lagMs);
  }

  async setOperationalAssessment(input: {
    activeMode: VenueRuntimeMode;
    uncertaintyLabel: VenueUncertaintyLabel;
  }): Promise<VenueHealthMetrics> {
    const state = await this.load();
    const next = {
      ...state,
      activeMode: input.activeMode,
      uncertaintyLabel: input.uncertaintyLabel,
    };
    await this.save(next);
    return buildVenueHealthMetrics(next);
  }

  getPaths(): {
    rootDir: string;
    statePath: string;
    snapshotDir: string;
    corruptDir: string;
  } {
    return {
      rootDir: this.rootDir,
      statePath: this.statePath,
      snapshotDir: this.snapshotDir,
      corruptDir: this.corruptDir,
    };
  }

  private async recordLagSample(
    key:
      | 'staleDataIntervalMsSamples'
      | 'openOrderVisibilityLagMsSamples'
      | 'tradeVisibilityLagMsSamples'
      | 'cancelAcknowledgmentLagMsSamples',
    lagMs: number,
  ): Promise<VenueHealthMetrics> {
    const state = await this.load();
    const next = {
      ...state,
      [key]: appendSample(state[key], lagMs),
    };
    await this.save(next);
    return buildVenueHealthMetrics(next);
  }

  private async ensureDirectories(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.rootDir, { recursive: true }),
      fs.mkdir(this.snapshotDir, { recursive: true }),
      fs.mkdir(this.corruptDir, { recursive: true }),
    ]);
  }

  private async createSnapshotIfPresent(): Promise<void> {
    try {
      await fs.access(this.statePath);
    } catch (error) {
      if (readErrorCode(error) === 'ENOENT') {
        return;
      }
      throw error;
    }

    const snapshotPath = path.join(
      this.snapshotDir,
      `venue-health-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    );
    await fs.copyFile(this.statePath, snapshotPath);
  }

  private async readLatestSnapshot(): Promise<VenueHealthLearningState | null> {
    const entries = await fs.readdir(this.snapshotDir, { withFileTypes: true });
    const snapshots = entries
      .filter((entry) => entry.isFile() && entry.name.startsWith('venue-health-'))
      .map((entry) => entry.name)
      .sort()
      .reverse();

    for (const snapshot of snapshots) {
      try {
        const content = await fs.readFile(path.join(this.snapshotDir, snapshot), 'utf8');
        return normalizeVenueHealthState(JSON.parse(content));
      } catch {
        continue;
      }
    }

    return null;
  }

  private async quarantineCorruptPrimary(): Promise<void> {
    try {
      await fs.access(this.statePath);
    } catch (error) {
      if (readErrorCode(error) === 'ENOENT') {
        return;
      }
      throw error;
    }

    const target = path.join(
      this.corruptDir,
      `venue-health-${new Date().toISOString().replace(/[:.]/g, '-')}.corrupt.json`,
    );
    await fs.rename(this.statePath, target);
  }

  private async pruneSnapshots(maxSnapshots = 14): Promise<void> {
    const entries = await fs.readdir(this.snapshotDir, { withFileTypes: true });
    const snapshots = entries
      .filter((entry) => entry.isFile() && entry.name.startsWith('venue-health-'))
      .map((entry) => entry.name)
      .sort()
      .reverse();

    for (const snapshot of snapshots.slice(maxSnapshots)) {
      await safeUnlink(path.join(this.snapshotDir, snapshot));
    }
  }
}

export function createDefaultVenueHealthLearningState(
  now = new Date(),
): VenueHealthLearningState {
  return {
    schemaVersion: 1,
    updatedAt: now.toISOString(),
    venueId: 'polymarket',
    requestLatencyMsSamples: [],
    requestFailureCountByCategory: {},
    totalRequests: 0,
    staleDataIntervalMsSamples: [],
    openOrderVisibilityLagMsSamples: [],
    tradeVisibilityLagMsSamples: [],
    cancelAcknowledgmentLagMsSamples: [],
    activeMode: null,
    uncertaintyLabel: null,
  };
}

function normalizeVenueHealthState(raw: unknown): VenueHealthLearningState {
  const base = createDefaultVenueHealthLearningState();
  if (!raw || typeof raw !== 'object') {
    return base;
  }

  const record = raw as Record<string, unknown>;
  return {
    ...base,
    schemaVersion:
      typeof record.schemaVersion === 'number' && Number.isFinite(record.schemaVersion)
        ? record.schemaVersion
        : base.schemaVersion,
    updatedAt: readString(record.updatedAt) ?? base.updatedAt,
    venueId: readString(record.venueId) ?? base.venueId,
    requestLatencyMsSamples: normalizeSamples(record.requestLatencyMsSamples),
    requestFailureCountByCategory: normalizeFailureCounts(
      record.requestFailureCountByCategory,
    ),
    totalRequests:
      typeof record.totalRequests === 'number' && Number.isFinite(record.totalRequests)
        ? Math.max(0, record.totalRequests)
        : base.totalRequests,
    staleDataIntervalMsSamples: normalizeSamples(record.staleDataIntervalMsSamples),
    openOrderVisibilityLagMsSamples: normalizeSamples(record.openOrderVisibilityLagMsSamples),
    tradeVisibilityLagMsSamples: normalizeSamples(record.tradeVisibilityLagMsSamples),
    cancelAcknowledgmentLagMsSamples: normalizeSamples(
      record.cancelAcknowledgmentLagMsSamples,
    ),
    activeMode:
      (readString(record.activeMode) as VenueHealthLearningState['activeMode']) ??
      base.activeMode,
    uncertaintyLabel:
      (readString(record.uncertaintyLabel) as VenueHealthLearningState['uncertaintyLabel']) ??
      base.uncertaintyLabel,
  };
}

function buildVenueHealthMetrics(state: VenueHealthLearningState): VenueHealthMetrics {
  const failedRequests = Object.values(state.requestFailureCountByCategory).reduce(
    (sum, count) => sum + count,
    0,
  );
  return {
    venueId: state.venueId,
    updatedAt: state.updatedAt,
    latencyDistribution: buildDistribution(state.requestLatencyMsSamples),
    requestFailures: {
      totalRequests: state.totalRequests,
      failedRequests,
      failureRate: state.totalRequests > 0 ? failedRequests / state.totalRequests : 0,
      failuresByCategory: { ...state.requestFailureCountByCategory },
    },
    staleDataIntervals: buildLagMetrics(state.staleDataIntervalMsSamples),
    openOrderVisibilityLag: buildLagMetrics(state.openOrderVisibilityLagMsSamples),
    tradeVisibilityLag: buildLagMetrics(state.tradeVisibilityLagMsSamples),
    cancelAcknowledgmentLag: buildLagMetrics(state.cancelAcknowledgmentLagMsSamples),
    activeMode: state.activeMode,
    uncertaintyLabel: state.uncertaintyLabel,
  };
}

function buildDistribution(samples: number[]): VenueLatencyDistribution {
  return {
    sampleCount: samples.length,
    averageMs: samples.length > 0 ? average(samples) : null,
    p50Ms: percentile(samples, 0.5),
    p90Ms: percentile(samples, 0.9),
    p99Ms: percentile(samples, 0.99),
    maxMs: samples.length > 0 ? Math.max(...samples) : null,
  };
}

function buildLagMetrics(samples: number[]): VenueLagMetrics {
  return {
    sampleCount: samples.length,
    averageMs: samples.length > 0 ? average(samples) : null,
    p90Ms: percentile(samples, 0.9),
    maxMs: samples.length > 0 ? Math.max(...samples) : null,
  };
}

function appendSample(samples: number[], value: number, maxSamples = 256): number[] {
  const bounded = Number.isFinite(value) && value >= 0 ? value : null;
  if (bounded == null) {
    return samples;
  }
  return [...samples, bounded].slice(-maxSamples);
}

function normalizeSamples(raw: unknown): number[] {
  return Array.isArray(raw)
    ? raw.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
    : [];
}

function normalizeFailureCounts(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .filter(
        ([key, value]) => key.length > 0 && typeof value === 'number' && Number.isFinite(value),
      )
      .map(([key, value]) => [key, Math.max(0, value as number)]),
  );
}

function percentile(samples: number[], rank: number): number | null {
  if (samples.length === 0) {
    return null;
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(rank * sorted.length) - 1),
  );
  return sorted[index] ?? null;
}

function average(samples: number[]): number {
  return samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readErrorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : null;
}

async function safeUnlink(targetPath: string): Promise<void> {
  try {
    await fs.unlink(targetPath);
  } catch (error) {
    if (readErrorCode(error) !== 'ENOENT') {
      throw error;
    }
  }
}

function resolveRepositoryRoot(start = process.cwd()): string {
  let current = path.resolve(start);

  while (true) {
    const marker = path.join(current, 'pnpm-workspace.yaml');
    if (fsSync.existsSync(marker)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return start;
    }
    current = parent;
  }
}
