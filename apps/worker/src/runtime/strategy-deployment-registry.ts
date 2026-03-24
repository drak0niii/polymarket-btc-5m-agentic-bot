import fs from 'fs/promises';
import path from 'path';
import type {
  StrategyDeploymentRegistryState,
  StrategyVariantRecord,
} from '@polymarket-btc-5m-agentic-bot/domain';
import {
  createDefaultStrategyDeploymentRegistryState,
  createStrategyVariantRecord,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { AppLogger } from '@worker/common/logger';
import { resolveRepositoryRoot } from './learning-state-store';

export class StrategyDeploymentRegistry {
  private readonly logger = new AppLogger('StrategyDeploymentRegistry');
  private readonly rootDir: string;
  private readonly statePath: string;
  private readonly snapshotDir: string;
  private readonly corruptDir: string;

  constructor(
    rootDir = path.join(resolveRepositoryRoot(), 'artifacts/strategy-deployment'),
  ) {
    this.rootDir = rootDir;
    this.statePath = path.join(rootDir, 'strategy-deployment-registry.json');
    this.snapshotDir = path.join(rootDir, 'snapshots');
    this.corruptDir = path.join(rootDir, 'corrupt');
  }

  async load(): Promise<StrategyDeploymentRegistryState> {
    await this.ensureDirectories();

    try {
      const content = await fs.readFile(this.statePath, 'utf8');
      return normalizeRegistryState(JSON.parse(content));
    } catch (error) {
      const code = readErrorCode(error);
      if (code === 'ENOENT') {
        const state = createDefaultStrategyDeploymentRegistryState();
        await this.save(state);
        return state;
      }

      this.logger.warn('Primary strategy deployment registry could not be read. Recovering.', {
        error: error instanceof Error ? error.message : String(error),
      });
      await this.quarantineCorruptPrimary();
      const recovered = await this.readLatestSnapshot();
      if (recovered) {
        return recovered;
      }

      const fallback = createDefaultStrategyDeploymentRegistryState();
      await this.save(fallback);
      return fallback;
    }
  }

  async save(state: StrategyDeploymentRegistryState): Promise<void> {
    await this.ensureDirectories();
    const normalized = normalizeRegistryState({
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
      `strategy-deployment-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    );
    await fs.copyFile(this.statePath, snapshotPath);
  }

  private async readLatestSnapshot(): Promise<StrategyDeploymentRegistryState | null> {
    const entries = await fs.readdir(this.snapshotDir, { withFileTypes: true });
    const snapshots = entries
      .filter((entry) => entry.isFile() && entry.name.startsWith('strategy-deployment-'))
      .map((entry) => entry.name)
      .sort()
      .reverse();

    for (const snapshot of snapshots) {
      try {
        const content = await fs.readFile(path.join(this.snapshotDir, snapshot), 'utf8');
        return normalizeRegistryState(JSON.parse(content));
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
      `strategy-deployment-${new Date().toISOString().replace(/[:.]/g, '-')}.corrupt.json`,
    );
    await fs.rename(this.statePath, target);
  }

  private async pruneSnapshots(maxSnapshots = 14): Promise<void> {
    const entries = await fs.readdir(this.snapshotDir, { withFileTypes: true });
    const snapshots = entries
      .filter((entry) => entry.isFile() && entry.name.startsWith('strategy-deployment-'))
      .map((entry) => entry.name)
      .sort()
      .reverse();

    for (const snapshot of snapshots.slice(maxSnapshots)) {
      await safeUnlink(path.join(this.snapshotDir, snapshot));
    }
  }
}

function normalizeRegistryState(raw: unknown): StrategyDeploymentRegistryState {
  const base = createDefaultStrategyDeploymentRegistryState();
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
    incumbentVariantId: readString(record.incumbentVariantId),
    activeRollout:
      record.activeRollout && typeof record.activeRollout === 'object'
        ? (record.activeRollout as StrategyDeploymentRegistryState['activeRollout'])
        : null,
    variants: normalizeVariants(record.variants),
    quarantines:
      record.quarantines && typeof record.quarantines === 'object'
        ? (record.quarantines as StrategyDeploymentRegistryState['quarantines'])
        : {},
    retiredVariantIds: Array.isArray(record.retiredVariantIds)
      ? record.retiredVariantIds.filter((item): item is string => typeof item === 'string')
      : [],
    lastPromotionDecision:
      record.lastPromotionDecision && typeof record.lastPromotionDecision === 'object'
        ? (record.lastPromotionDecision as StrategyDeploymentRegistryState['lastPromotionDecision'])
        : null,
    lastRollback:
      record.lastRollback && typeof record.lastRollback === 'object'
        ? (record.lastRollback as StrategyDeploymentRegistryState['lastRollback'])
        : null,
  };
}

function normalizeVariants(raw: unknown): Record<string, StrategyVariantRecord> {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const next: Record<string, StrategyVariantRecord> = {};
  for (const [variantId, value] of Object.entries(raw as Record<string, unknown>)) {
    const fallback = createStrategyVariantRecord({
      strategyVersionId: variantId.replace(/^variant:/, ''),
    });
    if (!value || typeof value !== 'object') {
      next[variantId] = fallback;
      continue;
    }
    const record = value as Record<string, unknown>;
    next[variantId] = {
      ...fallback,
      variantId: readString(record.variantId) ?? variantId,
      strategyVersionId: readString(record.strategyVersionId) ?? fallback.strategyVersionId,
      status: (readString(record.status) as StrategyVariantRecord['status']) ?? fallback.status,
      evaluationMode:
        (readString(record.evaluationMode) as StrategyVariantRecord['evaluationMode']) ??
        fallback.evaluationMode,
      rolloutStage:
        (readString(record.rolloutStage) as StrategyVariantRecord['rolloutStage']) ??
        fallback.rolloutStage,
      health: (readString(record.health) as StrategyVariantRecord['health']) ?? fallback.health,
      lineage:
        record.lineage && typeof record.lineage === 'object'
          ? (record.lineage as StrategyVariantRecord['lineage'])
          : fallback.lineage,
      capitalAllocationPct:
        typeof record.capitalAllocationPct === 'number' &&
        Number.isFinite(record.capitalAllocationPct)
          ? record.capitalAllocationPct
          : fallback.capitalAllocationPct,
      lastShadowEvaluatedAt: readString(record.lastShadowEvaluatedAt),
      createdAt: readString(record.createdAt) ?? fallback.createdAt,
      updatedAt: readString(record.updatedAt) ?? fallback.updatedAt,
    };
  }
  return next;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readErrorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : null;
}

async function safeUnlink(target: string): Promise<void> {
  try {
    await fs.unlink(target);
  } catch (error) {
    if (readErrorCode(error) !== 'ENOENT') {
      throw error;
    }
  }
}
