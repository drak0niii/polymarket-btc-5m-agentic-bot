import { createHash } from 'crypto';
import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';
import type {
  AllocationPolicyVersionLineage,
  CalibrationState,
  CalibrationVersionLineage,
  DecisionReplaySnapshot,
  DecisionVersionLineage,
  ExecutionPolicyVersion,
  ExecutionPolicyVersionLineage,
  FeatureSetVersionLineage,
  RiskPolicyVersionLineage,
  StrategyVersionLineage,
  VersionLineageDecisionRecord,
  VersionLineageRegistryState,
} from '@polymarket-btc-5m-agentic-bot/domain';
import {
  createDefaultVersionLineageRegistryState,
  createEmptyDecisionVersionLineage,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { AppLogger } from '@worker/common/logger';
import { resolveRepositoryRoot } from './learning-state-store';

export interface RecordVersionLineageInput {
  decisionId: string;
  decisionType: VersionLineageDecisionRecord['decisionType'];
  recordedAt?: string;
  summary: string;
  signalId?: string | null;
  signalDecisionId?: string | null;
  orderId?: string | null;
  marketId?: string | null;
  strategyVariantId?: string | null;
  cycleId?: string | null;
  lineage: DecisionVersionLineage;
  replay: DecisionReplaySnapshot;
  tags?: string[];
}

export class VersionLineageRegistry {
  private readonly logger = new AppLogger('VersionLineageRegistry');
  private readonly rootDir: string;
  private readonly statePath: string;
  private readonly snapshotDir: string;
  private readonly corruptDir: string;

  constructor(
    rootDir = path.join(resolveRepositoryRoot(), 'artifacts/version-lineage'),
  ) {
    this.rootDir = rootDir;
    this.statePath = path.join(rootDir, 'version-lineage-registry.json');
    this.snapshotDir = path.join(rootDir, 'snapshots');
    this.corruptDir = path.join(rootDir, 'corrupt');
  }

  async load(): Promise<VersionLineageRegistryState> {
    await this.ensureDirectories();

    try {
      const content = await fs.readFile(this.statePath, 'utf8');
      return normalizeRegistryState(JSON.parse(content));
    } catch (error) {
      const code = readErrorCode(error);
      if (code === 'ENOENT') {
        const state = createDefaultVersionLineageRegistryState();
        await this.save(state);
        return state;
      }

      this.logger.warn('Primary version lineage registry could not be read. Recovering.', {
        error: error instanceof Error ? error.message : String(error),
      });
      await this.quarantineCorruptPrimary();
      const recovered = await this.readLatestSnapshot();
      if (recovered) {
        return recovered;
      }

      const fallback = createDefaultVersionLineageRegistryState();
      await this.save(fallback);
      return fallback;
    }
  }

  async save(state: VersionLineageRegistryState): Promise<void> {
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

  async recordDecision(input: RecordVersionLineageInput): Promise<VersionLineageDecisionRecord> {
    const state = await this.load();
    const recordedAt = input.recordedAt ?? new Date().toISOString();
    const record: VersionLineageDecisionRecord = {
      decisionId: input.decisionId,
      decisionType: input.decisionType,
      recordedAt,
      summary: input.summary,
      signalId: input.signalId ?? null,
      signalDecisionId: input.signalDecisionId ?? null,
      orderId: input.orderId ?? null,
      marketId: input.marketId ?? null,
      strategyVariantId: input.strategyVariantId ?? null,
      cycleId: input.cycleId ?? null,
      lineage: normalizeDecisionVersionLineage(input.lineage),
      replay: normalizeReplaySnapshot(input.replay),
      tags: [...new Set((input.tags ?? []).filter((tag) => tag.trim().length > 0))].sort(),
    };

    const nextState: VersionLineageRegistryState = {
      ...state,
      updatedAt: recordedAt,
      decisions: {
        ...state.decisions,
        [record.decisionId]: record,
      },
      bySignalId: cloneIndex(state.bySignalId),
      bySignalDecisionId: cloneIndex(state.bySignalDecisionId),
      byOrderId: cloneIndex(state.byOrderId),
      byMarketId: cloneIndex(state.byMarketId),
      byStrategyVariantId: cloneIndex(state.byStrategyVariantId),
      byCycleId: cloneIndex(state.byCycleId),
    };

    attachIndex(nextState.bySignalId, record.signalId, record.decisionId);
    attachIndex(nextState.bySignalDecisionId, record.signalDecisionId, record.decisionId);
    attachIndex(nextState.byOrderId, record.orderId, record.decisionId);
    attachIndex(nextState.byMarketId, record.marketId, record.decisionId);
    attachIndex(nextState.byStrategyVariantId, record.strategyVariantId, record.decisionId);
    attachIndex(nextState.byCycleId, record.cycleId, record.decisionId);

    await this.save(nextState);
    return record;
  }

  async getDecision(decisionId: string): Promise<VersionLineageDecisionRecord | null> {
    const state = await this.load();
    return state.decisions[decisionId] ?? null;
  }

  async getLatestForSignal(signalId: string): Promise<VersionLineageDecisionRecord | null> {
    return this.getLatestFromIndex('bySignalId', signalId);
  }

  async getLatestForSignalDecision(
    signalDecisionId: string,
  ): Promise<VersionLineageDecisionRecord | null> {
    return this.getLatestFromIndex('bySignalDecisionId', signalDecisionId);
  }

  async getLatestForOrder(orderId: string): Promise<VersionLineageDecisionRecord | null> {
    return this.getLatestFromIndex('byOrderId', orderId);
  }

  async getLatestForStrategyVariant(
    strategyVariantId: string,
    limit = 20,
  ): Promise<VersionLineageDecisionRecord[]> {
    const state = await this.load();
    return resolveIndexRecords(state, state.byStrategyVariantId[strategyVariantId], limit);
  }

  async getLatestDecisions(limit = 50): Promise<VersionLineageDecisionRecord[]> {
    const state = await this.load();
    return Object.values(state.decisions)
      .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))
      .slice(0, limit);
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

  private async getLatestFromIndex(
    key:
      | 'bySignalId'
      | 'bySignalDecisionId'
      | 'byOrderId'
      | 'byMarketId'
      | 'byStrategyVariantId'
      | 'byCycleId',
    value: string,
  ): Promise<VersionLineageDecisionRecord | null> {
    const state = await this.load();
    return resolveIndexRecords(state, state[key][value], 1)[0] ?? null;
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
      `version-lineage-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    );
    await fs.copyFile(this.statePath, snapshotPath);
  }

  private async readLatestSnapshot(): Promise<VersionLineageRegistryState | null> {
    const entries = await fs.readdir(this.snapshotDir, { withFileTypes: true });
    const snapshots = entries
      .filter((entry) => entry.isFile() && entry.name.startsWith('version-lineage-'))
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
      `version-lineage-${new Date().toISOString().replace(/[:.]/g, '-')}.corrupt.json`,
    );
    await fs.rename(this.statePath, target);
  }

  private async pruneSnapshots(maxSnapshots = 14): Promise<void> {
    const entries = await fs.readdir(this.snapshotDir, { withFileTypes: true });
    const snapshots = entries
      .filter((entry) => entry.isFile() && entry.name.startsWith('version-lineage-'))
      .map((entry) => entry.name)
      .sort()
      .reverse();

    for (const snapshot of snapshots.slice(maxSnapshots)) {
      await safeUnlink(path.join(this.snapshotDir, snapshot));
    }
  }
}

export function buildStrategyVersionLineage(input: {
  strategyVersionId: string | null;
  strategyVariantId?: string | null;
}): StrategyVersionLineage | null {
  if (!input.strategyVersionId) {
    return null;
  }
  return {
    kind: 'strategy_version',
    versionId: input.strategyVersionId,
    strategyVersionId: input.strategyVersionId,
    strategyVariantId: input.strategyVariantId ?? null,
  };
}

export function buildFeatureSetVersionLineage(input: {
  featureSetId: string;
  parameters: Record<string, unknown>;
  parentStrategyVersionId?: string | null;
}): FeatureSetVersionLineage {
  const parameterHash = hashStructuredValue(input.parameters);
  return {
    kind: 'feature_set_version',
    versionId: `feature-set:${sanitizeKey(input.featureSetId)}:${parameterHash}`,
    featureSetId: input.featureSetId,
    parameterHash,
    parentStrategyVersionId: input.parentStrategyVersionId ?? null,
  };
}

export function buildCalibrationVersionLineage(
  calibration: CalibrationState | null,
): CalibrationVersionLineage | null {
  if (!calibration) {
    return null;
  }
  return {
    kind: 'calibration_version',
    versionId: `calibration:${sanitizeKey(calibration.contextKey)}:v${calibration.version}`,
    contextKey: calibration.contextKey,
    strategyVariantId: calibration.strategyVariantId,
    regime: calibration.regime,
    calibrationRevision: calibration.version,
  };
}

export function buildExecutionPolicyVersionLineage(
  version: ExecutionPolicyVersion | null,
): ExecutionPolicyVersionLineage | null {
  if (!version) {
    return null;
  }
  return {
    kind: 'execution_policy_version',
    versionId: version.versionId,
    contextKey: version.contextKey,
    strategyVariantId: version.strategyVariantId,
    regime: version.regime,
  };
}

export function buildRiskPolicyVersionLineage(input: {
  policyId: string;
  parameters: Record<string, unknown>;
}): RiskPolicyVersionLineage {
  const parameterHash = hashStructuredValue(input.parameters);
  return {
    kind: 'risk_policy_version',
    versionId: `risk-policy:${sanitizeKey(input.policyId)}:${parameterHash}`,
    policyId: input.policyId,
    parameterHash,
  };
}

export function buildAllocationPolicyVersionLineage(input: {
  policyId: string;
  strategyVariantId?: string | null;
  allocationDecisionKey?: string | null;
  parameters: Record<string, unknown>;
}): AllocationPolicyVersionLineage {
  const parameterHash = hashStructuredValue(input.parameters);
  return {
    kind: 'allocation_policy_version',
    versionId: `allocation-policy:${sanitizeKey(input.policyId)}:${parameterHash}`,
    policyId: input.policyId,
    strategyVariantId: input.strategyVariantId ?? null,
    allocationDecisionKey: input.allocationDecisionKey ?? null,
    parameterHash,
  };
}

export function hashStructuredValue(value: unknown): string {
  return createHash('sha1')
    .update(stableStringify(value))
    .digest('hex')
    .slice(0, 12);
}

function normalizeRegistryState(raw: unknown): VersionLineageRegistryState {
  const base = createDefaultVersionLineageRegistryState();
  if (!raw || typeof raw !== 'object') {
    return base;
  }

  const record = raw as Record<string, unknown>;
  const decisions = normalizeDecisions(record.decisions);
  return {
    ...base,
    schemaVersion:
      typeof record.schemaVersion === 'number' && Number.isFinite(record.schemaVersion)
        ? record.schemaVersion
        : base.schemaVersion,
    updatedAt: readString(record.updatedAt) ?? base.updatedAt,
    decisions,
    bySignalId: normalizeIndex(record.bySignalId, decisions),
    bySignalDecisionId: normalizeIndex(record.bySignalDecisionId, decisions),
    byOrderId: normalizeIndex(record.byOrderId, decisions),
    byMarketId: normalizeIndex(record.byMarketId, decisions),
    byStrategyVariantId: normalizeIndex(record.byStrategyVariantId, decisions),
    byCycleId: normalizeIndex(record.byCycleId, decisions),
  };
}

function normalizeDecisions(
  raw: unknown,
): VersionLineageRegistryState['decisions'] {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const next: VersionLineageRegistryState['decisions'] = {};
  for (const [decisionId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    const record = value as Record<string, unknown>;
    next[decisionId] = {
      decisionId,
      decisionType:
        (readString(record.decisionType) as VersionLineageDecisionRecord['decisionType']) ??
        'signal_execution',
      recordedAt: readString(record.recordedAt) ?? new Date(0).toISOString(),
      summary: readString(record.summary) ?? decisionId,
      signalId: readString(record.signalId),
      signalDecisionId: readString(record.signalDecisionId),
      orderId: readString(record.orderId),
      marketId: readString(record.marketId),
      strategyVariantId: readString(record.strategyVariantId),
      cycleId: readString(record.cycleId),
      lineage: normalizeDecisionVersionLineage(record.lineage),
      replay: normalizeReplaySnapshot(record.replay),
      tags: Array.isArray(record.tags)
        ? record.tags.filter((item): item is string => typeof item === 'string').sort()
        : [],
    };
  }
  return next;
}

function normalizeDecisionVersionLineage(raw: unknown): DecisionVersionLineage {
  const base = createEmptyDecisionVersionLineage();
  if (!raw || typeof raw !== 'object') {
    return base;
  }

  const record = raw as Record<string, unknown>;
  return {
    strategyVersion:
      record.strategyVersion && typeof record.strategyVersion === 'object'
        ? (record.strategyVersion as StrategyVersionLineage)
        : base.strategyVersion,
    featureSetVersion:
      record.featureSetVersion && typeof record.featureSetVersion === 'object'
        ? (record.featureSetVersion as FeatureSetVersionLineage)
        : base.featureSetVersion,
    calibrationVersion:
      record.calibrationVersion && typeof record.calibrationVersion === 'object'
        ? (record.calibrationVersion as CalibrationVersionLineage)
        : base.calibrationVersion,
    executionPolicyVersion:
      record.executionPolicyVersion && typeof record.executionPolicyVersion === 'object'
        ? (record.executionPolicyVersion as ExecutionPolicyVersionLineage)
        : base.executionPolicyVersion,
    riskPolicyVersion:
      record.riskPolicyVersion && typeof record.riskPolicyVersion === 'object'
        ? (record.riskPolicyVersion as RiskPolicyVersionLineage)
        : base.riskPolicyVersion,
    allocationPolicyVersion:
      record.allocationPolicyVersion && typeof record.allocationPolicyVersion === 'object'
        ? (record.allocationPolicyVersion as AllocationPolicyVersionLineage)
        : base.allocationPolicyVersion,
  };
}

function normalizeReplaySnapshot(raw: unknown): DecisionReplaySnapshot {
  if (!raw || typeof raw !== 'object') {
    return {
      marketState: null,
      runtimeState: null,
      learningState: null,
      lineageState: null,
      activeParameterBundle: null,
      venueMode: null,
      venueUncertainty: null,
    };
  }

  const record = raw as Record<string, unknown>;
  return {
    marketState: readRecord(record.marketState),
    runtimeState: readRecord(record.runtimeState),
    learningState: readRecord(record.learningState),
    lineageState: readRecord(record.lineageState),
    activeParameterBundle: readRecord(record.activeParameterBundle),
    venueMode:
      (readString(record.venueMode) as DecisionReplaySnapshot['venueMode']) ?? null,
    venueUncertainty:
      (readString(record.venueUncertainty) as DecisionReplaySnapshot['venueUncertainty']) ??
      null,
  };
}

function normalizeIndex(
  raw: unknown,
  decisions: VersionLineageRegistryState['decisions'],
): Record<string, string[]> {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const next: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) {
      continue;
    }
    const decisionIds = value.filter(
      (item): item is string => typeof item === 'string' && !!decisions[item],
    );
    if (decisionIds.length > 0) {
      next[key] = [...new Set(decisionIds)];
    }
  }
  return next;
}

function resolveIndexRecords(
  state: VersionLineageRegistryState,
  decisionIds: string[] | undefined,
  limit: number,
): VersionLineageDecisionRecord[] {
  return [...new Set(decisionIds ?? [])]
    .map((decisionId) => state.decisions[decisionId])
    .filter((record): record is VersionLineageDecisionRecord => Boolean(record))
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))
    .slice(0, limit);
}

function cloneIndex(index: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(index).map(([key, value]) => [key, [...value]]),
  );
}

function attachIndex(
  index: Record<string, string[]>,
  key: string | null,
  decisionId: string,
): void {
  if (!key) {
    return;
  }
  const existing = new Set(index[key] ?? []);
  existing.add(decisionId);
  index[key] = [...existing];
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]),
  );
}

function sanitizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
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

export function resolveVersionLineageRepositoryRoot(start = process.cwd()): string {
  let current = path.resolve(start);

  while (true) {
    const markers = [
      path.join(current, 'pnpm-workspace.yaml'),
      path.join(current, 'AGENTS.md'),
    ];
    if (markers.some((marker) => fsSync.existsSync(marker))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return start;
    }
    current = parent;
  }
}
