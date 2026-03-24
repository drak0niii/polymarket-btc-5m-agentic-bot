import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';
import type {
  CalibrationState,
  ExecutionLearningState,
  LearningState,
  PortfolioLearningState,
  StrategyVariantState,
} from '@polymarket-btc-5m-agentic-bot/domain';
import {
  createDefaultExecutionLearningContext,
  createDefaultExecutionLearningState,
  createDefaultLearningState,
  createDefaultPortfolioLearningState,
  createDefaultStrategyVariantState,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { AppLogger } from '@worker/common/logger';

export class LearningStateStore {
  private readonly logger = new AppLogger('LearningStateStore');
  private readonly rootDir: string;
  private readonly statePath: string;
  private readonly snapshotDir: string;
  private readonly corruptDir: string;

  constructor(rootDir = path.join(resolveRepositoryRoot(), 'artifacts/learning')) {
    this.rootDir = rootDir;
    this.statePath = path.join(rootDir, 'learning-state.json');
    this.snapshotDir = path.join(rootDir, 'snapshots');
    this.corruptDir = path.join(rootDir, 'corrupt');
  }

  async load(): Promise<LearningState> {
    await this.ensureDirectories();

    try {
      const content = await fs.readFile(this.statePath, 'utf8');
      return normalizeLearningState(JSON.parse(content));
    } catch (error) {
      const code = readErrorCode(error);
      if (code === 'ENOENT') {
        const state = createDefaultLearningState();
        await this.save(state);
        return state;
      }

      this.logger.warn('Primary learning state could not be read. Attempting recovery.', {
        error: error instanceof Error ? error.message : String(error),
      });
      await this.quarantineCorruptPrimary();
      const recovered = await this.readLatestSnapshot();
      if (recovered) {
        return recovered;
      }

      const fallback = createDefaultLearningState();
      await this.save(fallback);
      return fallback;
    }
  }

  async save(state: LearningState): Promise<void> {
    await this.ensureDirectories();
    const normalized = normalizeLearningState({
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
      `learning-state-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    );
    await fs.copyFile(this.statePath, snapshotPath);
  }

  private async readLatestSnapshot(): Promise<LearningState | null> {
    const entries = await fs.readdir(this.snapshotDir, { withFileTypes: true });
    const snapshots = entries
      .filter((entry) => entry.isFile() && entry.name.startsWith('learning-state-'))
      .map((entry) => entry.name)
      .sort()
      .reverse();

    for (const snapshot of snapshots) {
      try {
        const content = await fs.readFile(path.join(this.snapshotDir, snapshot), 'utf8');
        return normalizeLearningState(JSON.parse(content));
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
      `learning-state-${new Date().toISOString().replace(/[:.]/g, '-')}.corrupt.json`,
    );
    await fs.rename(this.statePath, target);
  }

  private async pruneSnapshots(maxSnapshots = 14): Promise<void> {
    const entries = await fs.readdir(this.snapshotDir, { withFileTypes: true });
    const snapshots = entries
      .filter((entry) => entry.isFile() && entry.name.startsWith('learning-state-'))
      .map((entry) => entry.name)
      .sort()
      .reverse();

    for (const snapshot of snapshots.slice(maxSnapshots)) {
      await safeUnlink(path.join(this.snapshotDir, snapshot));
    }
  }
}

export function resolveRepositoryRoot(start = process.cwd()): string {
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

function normalizeLearningState(raw: unknown): LearningState {
  const base = createDefaultLearningState();
  if (!raw || typeof raw !== 'object') {
    return base;
  }

  const record = raw as Record<string, unknown>;
  const strategyVariants = normalizeStrategyVariants(record.strategyVariants);
  const calibration = normalizeCalibration(record.calibration);

  for (const [contextKey, state] of Object.entries(calibration)) {
    const variantId = state.strategyVariantId;
    const variant = strategyVariants[variantId] ?? createDefaultStrategyVariantState(variantId);
    if (!variant.calibrationContexts.includes(contextKey)) {
      variant.calibrationContexts.push(contextKey);
    }
    strategyVariants[variantId] = variant;
  }

  return {
    ...base,
    schemaVersion:
      typeof record.schemaVersion === 'number' && Number.isFinite(record.schemaVersion)
        ? record.schemaVersion
        : base.schemaVersion,
    updatedAt: readString(record.updatedAt) ?? base.updatedAt,
    lastCycleStartedAt: readString(record.lastCycleStartedAt),
    lastCycleCompletedAt: readString(record.lastCycleCompletedAt),
    lastCycleSummary:
      record.lastCycleSummary && typeof record.lastCycleSummary === 'object'
        ? (record.lastCycleSummary as LearningState['lastCycleSummary'])
        : null,
    strategyVariants,
    calibration,
    executionLearning: normalizeExecutionLearning(record.executionLearning),
    portfolioLearning: normalizePortfolioLearning(record.portfolioLearning),
  };
}

function normalizeStrategyVariants(raw: unknown): Record<string, StrategyVariantState> {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const next: Record<string, StrategyVariantState> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const variant = createDefaultStrategyVariantState(key);
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      next[key] = {
        ...variant,
        strategyVariantId: readString(record.strategyVariantId) ?? key,
        health: readHealth(record.health) ?? variant.health,
        lastLearningAt: readString(record.lastLearningAt),
        regimeSnapshots:
          record.regimeSnapshots && typeof record.regimeSnapshots === 'object'
            ? (record.regimeSnapshots as StrategyVariantState['regimeSnapshots'])
            : {},
        calibrationContexts: Array.isArray(record.calibrationContexts)
          ? record.calibrationContexts.filter((item): item is string => typeof item === 'string')
          : [],
        executionLearning:
          normalizeExecutionLearning(record.executionLearning),
        lastPromotionDecision:
          record.lastPromotionDecision && typeof record.lastPromotionDecision === 'object'
            ? (record.lastPromotionDecision as StrategyVariantState['lastPromotionDecision'])
            : variant.lastPromotionDecision,
        lastQuarantineDecision:
          record.lastQuarantineDecision && typeof record.lastQuarantineDecision === 'object'
            ? (record.lastQuarantineDecision as StrategyVariantState['lastQuarantineDecision'])
            : variant.lastQuarantineDecision,
        lastCapitalAllocationDecision:
          record.lastCapitalAllocationDecision &&
          typeof record.lastCapitalAllocationDecision === 'object'
            ? (record.lastCapitalAllocationDecision as StrategyVariantState['lastCapitalAllocationDecision'])
            : variant.lastCapitalAllocationDecision,
      };
      continue;
    }
    next[key] = variant;
  }

  return next;
}

function normalizeExecutionLearning(raw: unknown): ExecutionLearningState {
  const base = createDefaultExecutionLearningState();
  if (!raw || typeof raw !== 'object') {
    return base;
  }

  const record = raw as Record<string, unknown>;
  const contexts: ExecutionLearningState['contexts'] = {};
  const rawContexts =
    record.contexts && typeof record.contexts === 'object'
      ? (record.contexts as Record<string, unknown>)
      : {};

  for (const [contextKey, value] of Object.entries(rawContexts)) {
    if (!value || typeof value !== 'object') {
      continue;
    }

    const contextRecord = value as Record<string, unknown>;
    const strategyVariantId =
      readString(contextRecord.strategyVariantId) ?? 'unknown_strategy_variant';
    const fallback = createDefaultExecutionLearningContext({
      contextKey,
      strategyVariantId,
      regime: readString(contextRecord.regime),
    });
    contexts[contextKey] = {
      ...fallback,
      contextKey: readString(contextRecord.contextKey) ?? contextKey,
      strategyVariantId,
      regime: readString(contextRecord.regime),
      sampleCount: readNumber(contextRecord.sampleCount),
      makerSampleCount: readNumber(contextRecord.makerSampleCount),
      takerSampleCount: readNumber(contextRecord.takerSampleCount),
      makerFillRate: readNumber(contextRecord.makerFillRate),
      takerFillRate: readNumber(contextRecord.takerFillRate),
      averageFillDelayMs: readNullableNumber(contextRecord.averageFillDelayMs),
      averageSlippage: readNumber(contextRecord.averageSlippage),
      adverseSelectionScore: readNumber(contextRecord.adverseSelectionScore),
      cancelSuccessRate: readNumber(contextRecord.cancelSuccessRate, 1),
      partialFillRate: readNumber(contextRecord.partialFillRate),
      makerPunished: readBoolean(contextRecord.makerPunished) ?? false,
      health: readHealth(contextRecord.health) ?? fallback.health,
      notes: Array.isArray(contextRecord.notes)
        ? contextRecord.notes.filter((item): item is string => typeof item === 'string')
        : [],
      activePolicyVersionId: readString(contextRecord.activePolicyVersionId),
      lastUpdatedAt: readString(contextRecord.lastUpdatedAt),
    };
  }

  const policyVersions =
    record.policyVersions && typeof record.policyVersions === 'object'
      ? (record.policyVersions as ExecutionLearningState['policyVersions'])
      : {};

  const activePolicyVersionIds: Record<string, string> = {};
  const rawActivePolicyVersionIds =
    record.activePolicyVersionIds && typeof record.activePolicyVersionIds === 'object'
      ? (record.activePolicyVersionIds as Record<string, unknown>)
      : {};
  for (const [contextKey, value] of Object.entries(rawActivePolicyVersionIds)) {
    const versionId = readString(value);
    if (versionId) {
      activePolicyVersionIds[contextKey] = versionId;
    }
  }

  return {
    ...base,
    version: readNumber(record.version, base.version),
    updatedAt: readString(record.updatedAt),
    contexts,
    policyVersions,
    activePolicyVersionIds,
    lastPolicyChangeAt: readString(record.lastPolicyChangeAt),
  };
}

function normalizeCalibration(raw: unknown): Record<string, CalibrationState> {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const next: Record<string, CalibrationState> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    const record = value as Record<string, unknown>;
    next[key] = {
      contextKey: readString(record.contextKey) ?? key,
      strategyVariantId:
        readString(record.strategyVariantId) ?? 'unknown_strategy_variant',
      regime: readString(record.regime),
      sampleCount: readNumber(record.sampleCount),
      brierScore: readNumber(record.brierScore),
      logLoss: readNumber(record.logLoss),
      shrinkageFactor: readNumber(record.shrinkageFactor, 1),
      overconfidenceScore: readNumber(record.overconfidenceScore),
      health: readHealth(record.health) ?? 'healthy',
      version: readNumber(record.version, 1),
      driftSignals: Array.isArray(record.driftSignals)
        ? record.driftSignals.filter((item): item is string => typeof item === 'string')
        : [],
      lastUpdatedAt: readString(record.lastUpdatedAt),
    };
  }

  return next;
}

function normalizePortfolioLearning(raw: unknown): PortfolioLearningState {
  const base = createDefaultPortfolioLearningState();
  if (!raw || typeof raw !== 'object') {
    return base;
  }

  const record = raw as Record<string, unknown>;
  return {
    ...base,
    version: readNumber(record.version, base.version),
    updatedAt: readString(record.updatedAt),
    allocationByVariant: normalizePortfolioAllocationSlices(record.allocationByVariant),
    allocationByRegime: normalizePortfolioAllocationSlices(record.allocationByRegime),
    allocationByOpportunityClass: normalizePortfolioAllocationSlices(
      record.allocationByOpportunityClass,
    ),
    drawdownBySleeve: normalizeDrawdownStates(record.drawdownBySleeve),
    concentrationSignals: normalizeConcentrationSignals(record.concentrationSignals),
    correlationSignals: normalizeCorrelationSignals(record.correlationSignals),
    allocationDecisions: normalizeAllocationDecisions(record.allocationDecisions),
    lastCorrelationUpdatedAt: readString(record.lastCorrelationUpdatedAt),
    lastAllocationUpdatedAt: readString(record.lastAllocationUpdatedAt),
  };
}

function normalizePortfolioAllocationSlices(
  raw: unknown,
): PortfolioLearningState['allocationByVariant'] {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const next: PortfolioLearningState['allocationByVariant'] = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    const record = value as Record<string, unknown>;
    next[key] = {
      sliceKey: readString(record.sliceKey) ?? key,
      sleeveType: readSleeveType(record.sleeveType) ?? 'variant',
      sleeveValue: readString(record.sleeveValue) ?? key,
      sampleCount: readNumber(record.sampleCount),
      allocatedCapital: readNumber(record.allocatedCapital),
      expectedEvSum: readNumber(record.expectedEvSum),
      realizedEvSum: readNumber(record.realizedEvSum),
      realizedVsExpected: readNullableNumber(record.realizedVsExpected),
      allocationShare: readNumber(record.allocationShare),
      targetMultiplier: readNumber(record.targetMultiplier, 1),
      lastUpdatedAt: readString(record.lastUpdatedAt),
    };
  }
  return next;
}

function normalizeDrawdownStates(
  raw: unknown,
): PortfolioLearningState['drawdownBySleeve'] {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const next: PortfolioLearningState['drawdownBySleeve'] = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    const record = value as Record<string, unknown>;
    next[key] = {
      sleeveKey: readString(record.sleeveKey) ?? key,
      sleeveType: readSleeveType(record.sleeveType) ?? 'variant',
      sleeveValue: readString(record.sleeveValue) ?? key,
      realizedEvCumulative: readNumber(record.realizedEvCumulative),
      peakRealizedEv: readNumber(record.peakRealizedEv),
      troughRealizedEv: readNumber(record.troughRealizedEv),
      currentDrawdown: readNumber(record.currentDrawdown),
      maxDrawdown: readNumber(record.maxDrawdown),
      lastUpdatedAt: readString(record.lastUpdatedAt),
    };
  }
  return next;
}

function normalizeConcentrationSignals(
  raw: unknown,
): PortfolioLearningState['concentrationSignals'] {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const next: PortfolioLearningState['concentrationSignals'] = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    const record = value as Record<string, unknown>;
    next[key] = {
      signalKey: readString(record.signalKey) ?? key,
      sleeveType: readSleeveType(record.sleeveType) ?? 'variant',
      sleeveValue: readString(record.sleeveValue) ?? key,
      allocationShare: readNumber(record.allocationShare),
      concentrationScore: readNumber(record.concentrationScore),
      penaltyMultiplier: readNumber(record.penaltyMultiplier, 1),
      severity: readSeverity(record.severity) ?? 'none',
      reasons: Array.isArray(record.reasons)
        ? record.reasons.filter((item): item is string => typeof item === 'string')
        : [],
      lastUpdatedAt: readString(record.lastUpdatedAt),
    };
  }
  return next;
}

function normalizeCorrelationSignals(
  raw: unknown,
): PortfolioLearningState['correlationSignals'] {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const next: PortfolioLearningState['correlationSignals'] = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    const record = value as Record<string, unknown>;
    next[key] = {
      signalKey: readString(record.signalKey) ?? key,
      leftVariantId: readString(record.leftVariantId) ?? 'unknown_left_variant',
      rightVariantId: readString(record.rightVariantId) ?? 'unknown_right_variant',
      sharedSampleCount: readNumber(record.sharedSampleCount),
      overlapScore: readNumber(record.overlapScore),
      realizedAlignment: readNumber(record.realizedAlignment),
      penaltyMultiplier: readNumber(record.penaltyMultiplier, 1),
      hiddenOverlap: readBoolean(record.hiddenOverlap) ?? false,
      reasons: Array.isArray(record.reasons)
        ? record.reasons.filter((item): item is string => typeof item === 'string')
        : [],
      lastUpdatedAt: readString(record.lastUpdatedAt),
    };
  }
  return next;
}

function normalizeAllocationDecisions(
  raw: unknown,
): PortfolioLearningState['allocationDecisions'] {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const next: PortfolioLearningState['allocationDecisions'] = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    const record = value as Record<string, unknown>;
    next[key] = {
      decisionKey: readString(record.decisionKey) ?? key,
      strategyVariantId: readString(record.strategyVariantId) ?? 'unknown_strategy_variant',
      targetMultiplier: readNumber(record.targetMultiplier, 1),
      status: readAllocationDecisionStatus(record.status) ?? 'hold',
      reasons: Array.isArray(record.reasons)
        ? record.reasons.filter((item): item is string => typeof item === 'string')
        : [],
      evidence:
        record.evidence && typeof record.evidence === 'object'
          ? (record.evidence as Record<string, unknown>)
          : {},
      decidedAt: readString(record.decidedAt),
    };
  }
  return next;
}

function readErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readSleeveType(value: unknown): PortfolioLearningState['allocationByVariant'][string]['sleeveType'] | null {
  return value === 'variant' || value === 'regime' || value === 'opportunity_class'
    ? value
    : null;
}

function readSeverity(value: unknown): PortfolioLearningState['concentrationSignals'][string]['severity'] | null {
  return value === 'none' || value === 'low' || value === 'medium' || value === 'high'
    ? value
    : null;
}

function readAllocationDecisionStatus(
  value: unknown,
): PortfolioLearningState['allocationDecisions'][string]['status'] | null {
  return value === 'increase' ||
    value === 'hold' ||
    value === 'reduce' ||
    value === 'block_scale'
    ? value
    : null;
}

function readHealth(value: unknown): StrategyVariantState['health'] | null {
  return value === 'healthy' ||
    value === 'watch' ||
    value === 'degraded' ||
    value === 'quarantine_candidate'
    ? value
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
