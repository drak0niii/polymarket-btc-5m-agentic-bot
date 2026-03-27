import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';
import type {
  CalibrationState,
  ExecutionLearningState,
  LearningCycleStatus,
  LearningDecisionEvidence,
  LearningEvidenceReference,
  LearningMetricSnapshot,
  LearningState,
  LearningReviewOutputs,
  LearningRollbackCriterion,
  LearningParameterChange,
  PortfolioLearningState,
  StrategyVariantState,
} from '@polymarket-btc-5m-agentic-bot/domain';
import {
  createDefaultExecutionLearningContext,
  createDefaultExecutionLearningState,
  createDefaultLearningDecisionEvidence,
  createDefaultLearningState,
  createDefaultPortfolioLearningState,
  createDefaultStrategyVariantState,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { AppLogger } from '@worker/common/logger';

const LEARNING_STATE_SCHEMA_VERSION = 2;

export interface ResolvedTradeLedgerPointer {
  resolvedTradeLedgerPath: string;
  lastResolvedTradeAt: string | null;
  lastResolvedTradeId: string | null;
}

export class LearningStateStore {
  private readonly logger = new AppLogger('LearningStateStore');
  private readonly rootDir: string;
  private readonly statePath: string;
  private readonly snapshotDir: string;
  private readonly corruptDir: string;
  private readonly resolvedTradePointerPath: string;

  constructor(rootDir = path.join(resolveRepositoryRoot(), 'artifacts/learning')) {
    this.rootDir = rootDir;
    this.statePath = path.join(rootDir, 'learning-state.json');
    this.snapshotDir = path.join(rootDir, 'snapshots');
    this.corruptDir = path.join(rootDir, 'corrupt');
    this.resolvedTradePointerPath = path.join(rootDir, 'resolved-trade-ledger.pointer.json');
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
      schemaVersion: Math.max(
        typeof state.schemaVersion === 'number' && Number.isFinite(state.schemaVersion)
          ? state.schemaVersion
          : LEARNING_STATE_SCHEMA_VERSION,
        LEARNING_STATE_SCHEMA_VERSION,
      ),
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
    resolvedTradePointerPath: string;
  } {
    return {
      rootDir: this.rootDir,
      statePath: this.statePath,
      snapshotDir: this.snapshotDir,
      corruptDir: this.corruptDir,
      resolvedTradePointerPath: this.resolvedTradePointerPath,
    };
  }

  async loadResolvedTradePointer(): Promise<ResolvedTradeLedgerPointer | null> {
    await this.ensureDirectories();
    try {
      const content = await fs.readFile(this.resolvedTradePointerPath, 'utf8');
      return normalizeResolvedTradeLedgerPointer(JSON.parse(content));
    } catch (error) {
      if (readErrorCode(error) === 'ENOENT') {
        return null;
      }

      this.logger.warn('Resolved-trade ledger pointer could not be read.', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async saveResolvedTradePointer(pointer: ResolvedTradeLedgerPointer): Promise<void> {
    await this.ensureDirectories();
    const normalized = normalizeResolvedTradeLedgerPointer(pointer);
    const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
    const tmpPath = `${this.resolvedTradePointerPath}.tmp`;

    try {
      await fs.writeFile(tmpPath, serialized, 'utf8');
      await fs.rename(tmpPath, this.resolvedTradePointerPath);
    } catch (error) {
      await safeUnlink(tmpPath);
      throw error;
    }
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
        : LEARNING_STATE_SCHEMA_VERSION,
    updatedAt: readString(record.updatedAt) ?? base.updatedAt,
    lastCycleStartedAt: readString(record.lastCycleStartedAt),
    lastCycleCompletedAt: readString(record.lastCycleCompletedAt),
    lastCycleSummary: normalizeLearningCycleSummary(record.lastCycleSummary),
    strategyVariants,
    calibration,
    executionLearning: normalizeExecutionLearning(record.executionLearning),
    portfolioLearning: normalizePortfolioLearning(record.portfolioLearning),
  };
}

function normalizeLearningCycleSummary(raw: unknown): LearningState['lastCycleSummary'] {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const summary = raw as Record<string, unknown>;
  const startedAt = readString(summary.startedAt) ?? new Date(0).toISOString();
  const completedAt = readString(summary.completedAt);
  return {
    cycleId: readString(summary.cycleId) ?? 'unknown_cycle',
    startedAt,
    completedAt,
    status: readLearningCycleStatus(summary.status) ?? 'completed',
    analyzedWindow: normalizeAnalyzedWindow(summary.analyzedWindow, {
      from: startedAt,
      to: completedAt ?? startedAt,
    }),
    realizedOutcomeCount: readNumber(summary.realizedOutcomeCount),
    attributionSliceCount: readNumber(summary.attributionSliceCount),
    calibrationUpdates: readNumber(summary.calibrationUpdates),
    shrinkageActions: readNumber(summary.shrinkageActions),
    degradedContexts: normalizeStringArray(summary.degradedContexts),
    warnings: normalizeStringArray(summary.warnings),
    errors: normalizeStringArray(summary.errors),
    reviewOutputs: normalizeReviewOutputs(summary.reviewOutputs),
  };
}

function normalizeReviewOutputs(raw: unknown): LearningReviewOutputs | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const reviewOutputs = normalizeUnknownRecord(raw);
  if (
    reviewOutputs.retentionContext &&
    typeof reviewOutputs.retentionContext === 'object'
  ) {
    reviewOutputs.retentionContext = normalizeRetentionContextSummary(
      reviewOutputs.retentionContext as Record<string, unknown>,
    );
  }
  if (
    reviewOutputs.calibrationDriftAlerts &&
    typeof reviewOutputs.calibrationDriftAlerts === 'object'
  ) {
    reviewOutputs.calibrationDriftAlerts = normalizeCalibrationDriftAlertsSummary(
      reviewOutputs.calibrationDriftAlerts as Record<string, unknown>,
    );
  }
  if (
    reviewOutputs.regimeLocalSizing &&
    typeof reviewOutputs.regimeLocalSizing === 'object'
  ) {
    reviewOutputs.regimeLocalSizing = normalizeRegimeLocalSizingSummary(
      reviewOutputs.regimeLocalSizing as Record<string, unknown>,
    );
  }
  return reviewOutputs;
}

function normalizeResolvedTradeLedgerPointer(
  raw: unknown,
): ResolvedTradeLedgerPointer {
  if (!raw || typeof raw !== 'object') {
    return {
      resolvedTradeLedgerPath: '',
      lastResolvedTradeAt: null,
      lastResolvedTradeId: null,
    };
  }

  const record = raw as Record<string, unknown>;
  return {
    resolvedTradeLedgerPath: readString(record.resolvedTradeLedgerPath) ?? '',
    lastResolvedTradeAt: readString(record.lastResolvedTradeAt),
    lastResolvedTradeId: readString(record.lastResolvedTradeId),
  };
}

function normalizeRetentionContextSummary(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...normalizeUnknownRecord(raw),
    generatedAt: readString(raw.generatedAt),
    sampleCount: readFiniteNumber(raw.sampleCount) ?? 0,
    retentionByRegime: normalizeContextEntries(raw.retentionByRegime, 12),
    retentionByArchetype: normalizeContextEntries(raw.retentionByArchetype, 12),
    retentionByToxicityState: normalizeContextEntries(raw.retentionByToxicityState, 8),
    topDegradingContexts: normalizeContextEntries(raw.topDegradingContexts, 5),
    topImprovingContexts: normalizeContextEntries(raw.topImprovingContexts, 5),
  };
}

function normalizeCalibrationDriftAlertsSummary(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...normalizeUnknownRecord(raw),
    generatedAt: readString(raw.generatedAt),
    sampleCount: readFiniteNumber(raw.sampleCount) ?? 0,
    calibrationDriftState: readString(raw.calibrationDriftState) ?? 'stable',
    regimeCalibrationAlert: normalizeCalibrationDriftEntries(
      raw.regimeCalibrationAlert,
      12,
    ),
    archetypeCalibrationAlert: normalizeCalibrationDriftEntries(
      raw.archetypeCalibrationAlert,
      12,
    ),
    driftReasonCodes: Array.isArray(raw.driftReasonCodes)
      ? raw.driftReasonCodes
          .filter((value): value is string => typeof value === 'string')
          .slice(0, 12)
      : [],
  };
}

function normalizeRegimeLocalSizingSummary(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...normalizeUnknownRecord(raw),
    generatedAt: readString(raw.generatedAt),
    sampleCount: readFiniteNumber(raw.sampleCount) ?? 0,
    byRegime: normalizeSizingEntries(raw.byRegime, 12),
    byArchetype: normalizeSizingEntries(raw.byArchetype, 12),
    mostConstrainedContexts: normalizeSizingEntries(raw.mostConstrainedContexts, 8),
  };
}

function normalizeContextEntries(raw: unknown, limit: number): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((entry): entry is Record<string, unknown> => entry != null && typeof entry === 'object')
    .slice(0, limit)
    .map((entry) => ({
      ...normalizeUnknownRecord(entry),
      contextType: readString(entry.contextType),
      contextValue: readString(entry.contextValue),
      sampleCount: readFiniteNumber(entry.sampleCount) ?? 0,
      expectedNetEdge: readFiniteNumber(entry.expectedNetEdge),
      realizedNetEdge: readFiniteNumber(entry.realizedNetEdge),
      retentionRatio: readFiniteNumber(entry.retentionRatio),
      realizedVsExpectedGap: readFiniteNumber(entry.realizedVsExpectedGap),
      rankScore: readFiniteNumber(entry.rankScore),
    }));
}

function normalizeSizingEntries(raw: unknown, limit: number): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((entry): entry is Record<string, unknown> => entry != null && typeof entry === 'object')
    .slice(0, limit)
    .map((entry) => ({
      ...normalizeUnknownRecord(entry),
      contextType: readString(entry.contextType),
      contextValue: readString(entry.contextValue),
      sampleCount: readFiniteNumber(entry.sampleCount) ?? 0,
      retentionRatio: readFiniteNumber(entry.retentionRatio),
      realizedVsExpectedGap: readFiniteNumber(entry.realizedVsExpectedGap),
      recommendedSizeMultiplier:
        readFiniteNumber(entry.recommendedSizeMultiplier) ?? 1,
      reasonCodes: Array.isArray(entry.reasonCodes)
        ? entry.reasonCodes.filter((item): item is string => typeof item === 'string').slice(0, 8)
        : [],
    }));
}

function normalizeCalibrationDriftEntries(
  raw: unknown,
  limit: number,
): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((entry): entry is Record<string, unknown> => entry != null && typeof entry === 'object')
    .slice(0, limit)
    .map((entry) => ({
      ...normalizeUnknownRecord(entry),
      contextType: readString(entry.contextType),
      contextValue: readString(entry.contextValue),
      sampleCount: readFiniteNumber(entry.sampleCount) ?? 0,
      averagePredictedProbability: readFiniteNumber(entry.averagePredictedProbability),
      realizedOutcomeRate: readFiniteNumber(entry.realizedOutcomeRate),
      averageCalibrationGap: readFiniteNumber(entry.averageCalibrationGap),
      absoluteCalibrationGap: readFiniteNumber(entry.absoluteCalibrationGap),
      calibrationDriftState: readString(entry.calibrationDriftState) ?? 'stable',
      driftReasonCodes: Array.isArray(entry.driftReasonCodes)
        ? entry.driftReasonCodes
            .filter((value): value is string => typeof value === 'string')
            .slice(0, 8)
        : [],
    }));
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
        lastPromotionDecision: normalizePromotionDecision(record.lastPromotionDecision),
        lastQuarantineDecision: normalizeQuarantineDecision(record.lastQuarantineDecision),
        lastCapitalAllocationDecision: normalizeCapitalAllocationDecision(
          record.lastCapitalAllocationDecision,
        ),
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
      evidence: normalizeLearningDecisionEvidence(record.evidence),
      decidedAt: readString(record.decidedAt),
    };
  }
  return next;
}

function normalizePromotionDecision(
  raw: unknown,
): StrategyVariantState['lastPromotionDecision'] {
  const fallback = createDefaultStrategyVariantState('fallback').lastPromotionDecision;
  if (!raw || typeof raw !== 'object') {
    return fallback;
  }

  const record = raw as Record<string, unknown>;
  return {
    decision:
      record.decision === 'not_evaluated' ||
      record.decision === 'reject' ||
      record.decision === 'shadow_only' ||
      record.decision === 'canary' ||
      record.decision === 'promote' ||
      record.decision === 'rollback'
        ? record.decision
        : fallback.decision,
    reasons: normalizeStringArray(record.reasons),
    evidence: normalizeLearningDecisionEvidence(record.evidence),
    rollbackCriteria: normalizeRollbackCriteria(record.rollbackCriteria),
    decidedAt: readString(record.decidedAt),
  };
}

function normalizeQuarantineDecision(
  raw: unknown,
): StrategyVariantState['lastQuarantineDecision'] {
  const fallback = createDefaultStrategyVariantState('fallback').lastQuarantineDecision;
  if (!raw || typeof raw !== 'object') {
    return fallback;
  }

  const record = raw as Record<string, unknown>;
  const scopeRecord =
    record.scope && typeof record.scope === 'object'
      ? (record.scope as Record<string, unknown>)
      : {};

  return {
    status:
      record.status === 'none' ||
      record.status === 'watch' ||
      record.status === 'probation' ||
      record.status === 'quarantine_recommended' ||
      record.status === 'quarantined'
        ? record.status
        : fallback.status,
    severity:
      record.severity === 'none' ||
      record.severity === 'low' ||
      record.severity === 'medium' ||
      record.severity === 'high'
        ? record.severity
        : fallback.severity,
    reasons: normalizeStringArray(record.reasons),
    evidence: normalizeLearningDecisionEvidence(record.evidence),
    scope: {
      strategyVariantId: readString(scopeRecord.strategyVariantId),
      regime: readString(scopeRecord.regime),
      marketContext: readString(scopeRecord.marketContext),
    },
    decidedAt: readString(record.decidedAt),
    until: readString(record.until),
    rollbackCriteria: normalizeRollbackCriteria(record.rollbackCriteria),
  };
}

function normalizeCapitalAllocationDecision(
  raw: unknown,
): StrategyVariantState['lastCapitalAllocationDecision'] {
  const fallback = createDefaultStrategyVariantState('fallback').lastCapitalAllocationDecision;
  if (!raw || typeof raw !== 'object') {
    return fallback;
  }

  const record = raw as Record<string, unknown>;
  return {
    status:
      record.status === 'unchanged' ||
      record.status === 'reduce' ||
      record.status === 'hold' ||
      record.status === 'increase'
        ? record.status
        : fallback.status,
    targetMultiplier: readNumber(record.targetMultiplier, fallback.targetMultiplier),
    reasons: normalizeStringArray(record.reasons),
    evidence: normalizeLearningDecisionEvidence(record.evidence),
    decidedAt: readString(record.decidedAt),
    rollbackCriteria: normalizeRollbackCriteria(record.rollbackCriteria),
  };
}

function normalizeLearningDecisionEvidence(raw: unknown): LearningDecisionEvidence {
  const fallback = createDefaultLearningDecisionEvidence();
  if (!raw || typeof raw !== 'object') {
    return fallback;
  }

  const record = raw as Record<string, unknown>;
  const normalized = normalizeUnknownRecord(record);
  return {
    ...normalized,
    summary: readString(record.summary),
    evidenceRefs: normalizeEvidenceReferences(record.evidenceRefs),
    metricSnapshot: normalizeMetricSnapshot(record.metricSnapshot),
    changeSet: normalizeParameterChanges(record.changeSet),
    warnings: normalizeStringArray(record.warnings),
    payload: normalizeUnknownRecord(record.payload),
  };
}

function normalizeEvidenceReferences(raw: unknown): LearningEvidenceReference[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((entry): entry is Record<string, unknown> => entry != null && typeof entry === 'object')
    .map((entry) => ({
      ...normalizeUnknownRecord(entry),
      source:
        entry.source === 'resolved_trade_ledger' ||
        entry.source === 'learning_event_log' ||
        entry.source === 'audit_event' ||
        entry.source === 'validation_artifact' ||
        entry.source === 'runtime_checkpoint' ||
        entry.source === 'manual_review' ||
        entry.source === 'unknown'
          ? entry.source
          : undefined,
      sourceId: readString(entry.sourceId),
      artifactPath: readString(entry.artifactPath),
      strategyVariantId: readString(entry.strategyVariantId),
      regime: readString(entry.regime),
      marketId: readString(entry.marketId),
      window:
        entry.window && typeof entry.window === 'object'
          ? normalizeEvidenceWindow(entry.window as Record<string, unknown>)
          : null,
      metricSnapshot: normalizeMetricSnapshot(entry.metricSnapshot),
      notes: normalizeStringArray(entry.notes),
    }));
}

function normalizeEvidenceWindow(
  raw: Record<string, unknown>,
): NonNullable<LearningEvidenceReference['window']> {
  return {
    ...normalizeUnknownRecord(raw),
    from: readString(raw.from),
    to: readString(raw.to),
    sampleCount: readFiniteNumber(raw.sampleCount),
  };
}

function normalizeMetricSnapshot(raw: unknown): LearningMetricSnapshot {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const next: LearningMetricSnapshot = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      next[key] = value;
    }
  }
  return next;
}

function normalizeParameterChanges(raw: unknown): LearningParameterChange[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((entry): entry is Record<string, unknown> => entry != null && typeof entry === 'object')
    .map((entry) => {
      const scope =
        entry.scope && typeof entry.scope === 'object'
          ? (entry.scope as Record<string, unknown>)
          : {};
      return {
        ...normalizeUnknownRecord(entry),
        parameter: readString(entry.parameter) ?? 'unknown_parameter',
        previousValue: normalizeParameterValue(entry.previousValue),
        nextValue: normalizeParameterValue(entry.nextValue),
        scope: {
          strategyVariantId: readString(scope.strategyVariantId),
          regime: readString(scope.regime),
          marketContext: readString(scope.marketContext),
        },
        rationale: normalizeStringArray(entry.rationale),
        boundedBy: normalizeStringArray(entry.boundedBy),
        evidenceRefs: normalizeEvidenceReferences(entry.evidenceRefs),
        rollbackCriteria: normalizeRollbackCriteria(entry.rollbackCriteria),
        changedAt: readString(entry.changedAt),
      };
    });
}

function normalizeRollbackCriteria(raw: unknown): LearningRollbackCriterion[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((entry): entry is Record<string, unknown> => entry != null && typeof entry === 'object')
    .map((entry) => ({
      ...normalizeUnknownRecord(entry),
      trigger: readString(entry.trigger) ?? 'unknown_trigger',
      comparator:
        entry.comparator === 'lte' ||
        entry.comparator === 'gte' ||
        entry.comparator === 'eq' ||
        entry.comparator === 'contains' ||
        entry.comparator === 'exists'
          ? entry.comparator
          : undefined,
      threshold: normalizeParameterValue(entry.threshold),
      rationale: readString(entry.rationale) ?? undefined,
    }));
}

function normalizeParameterValue(
  value: unknown,
): string | number | boolean | null | undefined {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return value;
  }
  return undefined;
}

function normalizeAnalyzedWindow(
  raw: unknown,
  fallback: { from: string; to: string },
): { from: string; to: string } {
  if (!raw || typeof raw !== 'object') {
    return fallback;
  }
  const record = raw as Record<string, unknown>;
  return {
    from: readString(record.from) ?? fallback.from,
    to: readString(record.to) ?? fallback.to,
  };
}

function normalizeStringArray(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === 'string')
    : [];
}

function normalizeUnknownRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    next[key] = normalizeUnknownValue(value);
  }
  return next;
}

function normalizeUnknownValue(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return null;
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeUnknownValue(entry, depth + 1));
  }
  if (value && typeof value === 'object') {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      next[key] = normalizeUnknownValue(entry, depth + 1);
    }
    return next;
  }
  return null;
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

function readFiniteNumber(value: unknown): number | null {
  return readNullableNumber(value);
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

function readLearningCycleStatus(value: unknown): LearningCycleStatus | null {
  return value === 'completed' ||
    value === 'completed_with_warnings' ||
    value === 'failed'
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
