import fs from 'fs/promises';
import path from 'path';
import type {
  LearningEvent,
  LearningEventDetails,
  LearningEventSeverity,
  LearningEventType,
  LearningEvidenceReference,
  LearningMetricSnapshot,
  LearningParameterChange,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { createDefaultLearningEventDetails } from '@polymarket-btc-5m-agentic-bot/domain';
import { AppLogger } from '@worker/common/logger';
import { resolveRepositoryRoot } from './learning-state-store';

export interface LearningEventLogWindow {
  start: Date | string;
  end: Date | string;
}

export interface LearningEventLogQuery {
  cycleId?: string | null;
  strategyVariantId?: string | null;
  contextKey?: string | null;
  types?: LearningEventType[];
  severities?: LearningEventSeverity[];
}

export interface LearningEventLogSummary {
  totalCount: number;
  byType: Partial<Record<LearningEventType, number>>;
  bySeverity: Record<LearningEventSeverity, number>;
  byStrategyVariantId: Record<string, number>;
  byCycleId: Record<string, number>;
  latestCreatedAt: string | null;
}

export class LearningEventLog {
  private readonly logger = new AppLogger('LearningEventLog');
  private readonly rootDir: string;
  private readonly logPath: string;

  constructor(rootDir = path.join(resolveRepositoryRoot(), 'artifacts/learning')) {
    this.rootDir = rootDir;
    this.logPath = path.join(rootDir, 'learning-events.jsonl');
  }

  async append(events: LearningEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    await fs.mkdir(this.rootDir, { recursive: true });
    const payload = events
      .map((event) => JSON.stringify(normalizeLearningEvent(event)))
      .join('\n');
    const handle = await fs.open(this.logPath, 'a');
    try {
      await handle.writeFile(`${payload}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async readLatest(limit = 100, query: LearningEventLogQuery = {}): Promise<LearningEvent[]> {
    if (!Number.isFinite(limit) || limit <= 0) {
      return [];
    }

    const events = await this.readAll();
    return filterLearningEvents(events, query).slice(-Math.floor(limit));
  }

  async loadWindow(
    window: LearningEventLogWindow,
    query: LearningEventLogQuery = {},
  ): Promise<LearningEvent[]> {
    const start = readTimestamp(window.start);
    const end = readTimestamp(window.end);
    if (start == null || end == null) {
      return [];
    }

    const events = await this.readAll();
    return filterLearningEvents(
      events.filter((event) => {
        const createdAt = readTimestamp(event.createdAt);
        return createdAt != null && createdAt >= start && createdAt <= end;
      }),
      query,
    );
  }

  async summarizeWindow(
    window: LearningEventLogWindow,
    query: LearningEventLogQuery = {},
  ): Promise<LearningEventLogSummary> {
    const events = await this.loadWindow(window, query);
    const byType: Partial<Record<LearningEventType, number>> = {};
    const bySeverity: Record<LearningEventSeverity, number> = {
      info: 0,
      warning: 0,
      critical: 0,
    };
    const byStrategyVariantId: Record<string, number> = {};
    const byCycleId: Record<string, number> = {};

    for (const event of events) {
      byType[event.type] = (byType[event.type] ?? 0) + 1;
      bySeverity[event.severity] += 1;
      if (event.strategyVariantId) {
        byStrategyVariantId[event.strategyVariantId] =
          (byStrategyVariantId[event.strategyVariantId] ?? 0) + 1;
      }
      if (event.cycleId) {
        byCycleId[event.cycleId] = (byCycleId[event.cycleId] ?? 0) + 1;
      }
    }

    return {
      totalCount: events.length,
      byType,
      bySeverity,
      byStrategyVariantId,
      byCycleId,
      latestCreatedAt: events.at(-1)?.createdAt ?? null,
    };
  }

  getPath(): string {
    return this.logPath;
  }

  private async readAll(): Promise<LearningEvent[]> {
    try {
      const content = await fs.readFile(this.logPath, 'utf8');
      return content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .flatMap((line, index) => {
          try {
            return [normalizeLearningEvent(JSON.parse(line) as LearningEvent)];
          } catch (error) {
            this.logger.warn('Skipping corrupt learning-event line.', {
              lineNumber: index + 1,
              error: error instanceof Error ? error.message : String(error),
            });
            return [];
          }
        });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }
}

function filterLearningEvents(
  events: LearningEvent[],
  query: LearningEventLogQuery,
): LearningEvent[] {
  return events.filter((event) => {
    if (query.cycleId !== undefined && event.cycleId !== query.cycleId) {
      return false;
    }
    if (
      query.strategyVariantId !== undefined &&
      event.strategyVariantId !== query.strategyVariantId
    ) {
      return false;
    }
    if (query.contextKey !== undefined && event.contextKey !== query.contextKey) {
      return false;
    }
    if (query.types && !query.types.includes(event.type)) {
      return false;
    }
    if (query.severities && !query.severities.includes(event.severity)) {
      return false;
    }
    return true;
  });
}

function normalizeLearningEvent(raw: unknown): LearningEvent {
  if (!raw || typeof raw !== 'object') {
    throw new Error('learning event must be an object');
  }

  const record = raw as Record<string, unknown>;
  const type = readLearningEventType(record.type);
  const severity = readLearningEventSeverity(record.severity);
  const createdAt = readString(record.createdAt);
  if (!type || !severity || !createdAt) {
    throw new Error('learning event is missing canonical type, severity, or createdAt');
  }

  return {
    id: readString(record.id) ?? `${type}:${createdAt}`,
    type,
    severity,
    createdAt,
    cycleId: readNullableString(record.cycleId),
    strategyVariantId: readNullableString(record.strategyVariantId),
    contextKey: readNullableString(record.contextKey),
    summary: readString(record.summary) ?? `${type}:${severity}`,
    details: normalizeLearningEventDetails(record.details),
  };
}

function normalizeLearningEventDetails(raw: unknown): LearningEventDetails {
  const fallback = createDefaultLearningEventDetails();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fallback;
  }

  const record = raw as Record<string, unknown>;
  return {
    ...normalizeUnknownRecord(record),
    evidenceRefs: normalizeEvidenceReferences(record.evidenceRefs),
    metricSnapshot: normalizeMetricSnapshot(record.metricSnapshot),
    changeSet: normalizeParameterChanges(record.changeSet),
    warnings: normalizeStringArray(record.warnings),
    errors: normalizeStringArray(record.errors),
    payload:
      record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
        ? normalizeUnknownRecord(record.payload)
        : {},
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
      source: readEvidenceSource(entry.source),
      sourceId: readNullableString(entry.sourceId),
      artifactPath: readNullableString(entry.artifactPath),
      strategyVariantId: readNullableString(entry.strategyVariantId),
      regime: readNullableString(entry.regime),
      marketId: readNullableString(entry.marketId),
      window:
        entry.window && typeof entry.window === 'object' && !Array.isArray(entry.window)
          ? {
              ...normalizeUnknownRecord(entry.window),
              from: readNullableString((entry.window as Record<string, unknown>).from),
              to: readNullableString((entry.window as Record<string, unknown>).to),
              sampleCount: readNullableNumber(
                (entry.window as Record<string, unknown>).sampleCount,
              ),
            }
          : null,
      metricSnapshot: normalizeMetricSnapshot(entry.metricSnapshot),
      notes: normalizeStringArray(entry.notes),
    }));
}

function normalizeMetricSnapshot(raw: unknown): LearningMetricSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  const next: LearningMetricSnapshot = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (
      typeof value === 'string' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
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
        entry.scope && typeof entry.scope === 'object' && !Array.isArray(entry.scope)
          ? (entry.scope as Record<string, unknown>)
          : {};
      return {
        ...normalizeUnknownRecord(entry),
        parameter: readString(entry.parameter) ?? 'unknown_parameter',
        previousValue: normalizeParameterValue(entry.previousValue),
        nextValue: normalizeParameterValue(entry.nextValue),
        scope: {
          strategyVariantId: readNullableString(scope.strategyVariantId),
          regime: readNullableString(scope.regime),
          marketContext: readNullableString(scope.marketContext),
        },
        rationale: normalizeStringArray(entry.rationale),
        boundedBy: normalizeStringArray(entry.boundedBy),
        evidenceRefs: normalizeEvidenceReferences(entry.evidenceRefs),
        rollbackCriteria: Array.isArray(entry.rollbackCriteria)
          ? entry.rollbackCriteria
              .filter(
                (criterion): criterion is Record<string, unknown> =>
                  criterion != null && typeof criterion === 'object',
              )
              .map((criterion) => ({
                ...normalizeUnknownRecord(criterion),
                trigger: readString(criterion.trigger) ?? 'unknown_trigger',
                comparator: readRollbackComparator(criterion.comparator),
                threshold: normalizeParameterValue(criterion.threshold),
                rationale: readNullableString(criterion.rationale) ?? undefined,
              }))
          : [],
        changedAt: readNullableString(entry.changedAt),
      };
    });
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
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeUnknownValue(entry, depth + 1));
  }
  if (value && typeof value === 'object') {
    return normalizeUnknownRecord(value);
  }
  return null;
}

function normalizeStringArray(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === 'string')
    : [];
}

function normalizeParameterValue(value: unknown): string | number | boolean | null | undefined {
  if (
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return value;
  }
  return undefined;
}

function readLearningEventType(value: unknown): LearningEventType | null {
  return value === 'learning_cycle_started' ||
    value === 'learning_cycle_completed' ||
    value === 'learning_cycle_failed' ||
    value === 'learning_parameter_recommendations_generated' ||
    value === 'calibration_updated' ||
    value === 'edge_decay_detected' ||
    value === 'confidence_shrinkage_changed' ||
    value === 'strategy_variant_registered' ||
    value === 'shadow_evaluation_completed' ||
    value === 'strategy_promotion_decided' ||
    value === 'strategy_quarantined' ||
    value === 'strategy_rollout_changed' ||
    value === 'strategy_rollback_triggered' ||
    value === 'execution_learning_updated' ||
    value === 'execution_policy_versioned' ||
    value === 'adverse_selection_detected' ||
    value === 'portfolio_learning_updated' ||
    value === 'capital_allocation_decided' ||
    value === 'correlation_signal_detected'
    ? value
    : null;
}

function readLearningEventSeverity(value: unknown): LearningEventSeverity | null {
  return value === 'info' || value === 'warning' || value === 'critical' ? value : null;
}

function readEvidenceSource(value: unknown): LearningEvidenceReference['source'] | undefined {
  return value === 'resolved_trade_ledger' ||
    value === 'learning_event_log' ||
    value === 'audit_event' ||
    value === 'validation_artifact' ||
    value === 'runtime_checkpoint' ||
    value === 'manual_review' ||
    value === 'unknown'
    ? value
    : undefined;
}

function readRollbackComparator(value: unknown): 'lte' | 'gte' | 'eq' | 'contains' | 'exists' | undefined {
  return value === 'lte' ||
    value === 'gte' ||
    value === 'eq' ||
    value === 'contains' ||
    value === 'exists'
    ? value
    : undefined;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readTimestamp(value: Date | string): number | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime();
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}
