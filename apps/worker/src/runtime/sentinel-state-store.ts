import fs from 'fs/promises';
import path from 'path';
import {
  type SentinelBaselineKnowledge,
  type SentinelLearningUpdate,
  type SentinelReadinessStatus,
  type SentinelSimulatedTradeRecord,
  type TradingOperatingMode,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { AppLogger } from '@worker/common/logger';
import { resolveRepositoryRoot } from './learning-state-store';

const TARGET_SIMULATED_TRADES = 20;
const TARGET_LEARNED_TRADES = 20;
const READINESS_THRESHOLD = 0.75;
const MAX_EDGE_GAP_BPS = 8;
const MIN_FILL_QUALITY_PASS_RATE = 0.8;
const MIN_NO_TRADE_DISCIPLINE_PASS_RATE = 0.8;

export class SentinelStateStore {
  private readonly logger = new AppLogger('SentinelStateStore');
  private readonly rootDir: string;
  private readonly baselinePath: string;
  private readonly tradesPath: string;
  private readonly learningUpdatesPath: string;
  private readonly readinessPath: string;

  constructor(rootDir = path.join(resolveRepositoryRoot(), 'artifacts/learning/sentinel')) {
    this.rootDir = rootDir;
    this.baselinePath = path.join(rootDir, 'baseline-knowledge.latest.json');
    this.tradesPath = path.join(rootDir, 'simulated-trades.jsonl');
    this.learningUpdatesPath = path.join(rootDir, 'learning-updates.jsonl');
    this.readinessPath = path.join(rootDir, 'readiness.latest.json');
  }

  getPaths() {
    return {
      rootDir: this.rootDir,
      baselinePath: this.baselinePath,
      tradesPath: this.tradesPath,
      learningUpdatesPath: this.learningUpdatesPath,
      readinessPath: this.readinessPath,
    };
  }

  async ensureBaselineKnowledge(
    operatingMode: TradingOperatingMode = 'sentinel_simulation',
  ): Promise<SentinelBaselineKnowledge> {
    await this.ensureDirectories();

    try {
      const content = await fs.readFile(this.baselinePath, 'utf8');
      return JSON.parse(content) as SentinelBaselineKnowledge;
    } catch (error) {
      if (!isMissingFile(error)) {
        this.logger.warn('Sentinel baseline knowledge could not be read; recreating.', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const baseline: SentinelBaselineKnowledge = {
      baselineId: 'sentinel-baseline-v1',
      createdAt: new Date().toISOString(),
      operatingMode,
      strategyVariantId: null,
      strategyVersion: null,
      regimeModelVersion: 'regime-classifier-v1',
      initialNetEdgeAssumptions: {
        expectedNetEdgeBps: 0,
      },
      initialCostAssumptions: {
        expectedFeeBps: 0,
        expectedSlippageBps: 0,
      },
      initialTrustScore: 0,
      targetSimulatedTrades: TARGET_SIMULATED_TRADES,
      targetLearnedTrades: TARGET_LEARNED_TRADES,
      readinessThreshold: READINESS_THRESHOLD,
      safeToGoLiveThresholds: {
        targetSimulatedTrades: TARGET_SIMULATED_TRADES,
        targetLearnedTrades: TARGET_LEARNED_TRADES,
        readinessThreshold: READINESS_THRESHOLD,
        maxExpectedVsRealizedEdgeGapBps: MAX_EDGE_GAP_BPS,
        minFillQualityPassRate: MIN_FILL_QUALITY_PASS_RATE,
        minNoTradeDisciplinePassRate: MIN_NO_TRADE_DISCIPLINE_PASS_RATE,
        maxUnresolvedAnomalyCount: 0,
      },
      boundedLearningSurfaces: [
        'trust/readiness_state',
        'execution_expectation_summaries',
        'regime_confidence_support_metrics',
        'no_trade_discipline_summaries',
        'strategy_confidence_readiness_metrics',
      ],
      sourceOfTruth: {
        simulatedTradesPath: this.tradesPath,
        learningUpdatesPath: this.learningUpdatesPath,
        readinessPath: this.readinessPath,
      },
      notes: [
        'Sentinel mode never calls live order submission.',
        'Readiness is advisory only and must not auto-enable live trading.',
        'Learning is bounded and auditable.',
      ],
    };
    await this.writeJsonFile(this.baselinePath, baseline);
    return baseline;
  }

  async updateBaselineKnowledge(
    patch: Partial<SentinelBaselineKnowledge>,
  ): Promise<SentinelBaselineKnowledge> {
    const current = await this.ensureBaselineKnowledge(
      patch.operatingMode ?? 'sentinel_simulation',
    );
    const next: SentinelBaselineKnowledge = {
      ...current,
      ...patch,
      initialNetEdgeAssumptions: {
        expectedNetEdgeBps:
          patch.initialNetEdgeAssumptions?.expectedNetEdgeBps ??
          current.initialNetEdgeAssumptions?.expectedNetEdgeBps ??
          0,
      },
      initialCostAssumptions: {
        expectedFeeBps:
          patch.initialCostAssumptions?.expectedFeeBps ??
          current.initialCostAssumptions?.expectedFeeBps ??
          0,
        expectedSlippageBps:
          patch.initialCostAssumptions?.expectedSlippageBps ??
          current.initialCostAssumptions?.expectedSlippageBps ??
          0,
      },
      safeToGoLiveThresholds: {
        targetSimulatedTrades:
          patch.safeToGoLiveThresholds?.targetSimulatedTrades ??
          current.safeToGoLiveThresholds?.targetSimulatedTrades ??
          TARGET_SIMULATED_TRADES,
        targetLearnedTrades:
          patch.safeToGoLiveThresholds?.targetLearnedTrades ??
          current.safeToGoLiveThresholds?.targetLearnedTrades ??
          TARGET_LEARNED_TRADES,
        readinessThreshold:
          patch.safeToGoLiveThresholds?.readinessThreshold ??
          current.safeToGoLiveThresholds?.readinessThreshold ??
          READINESS_THRESHOLD,
        maxExpectedVsRealizedEdgeGapBps:
          patch.safeToGoLiveThresholds?.maxExpectedVsRealizedEdgeGapBps ??
          current.safeToGoLiveThresholds?.maxExpectedVsRealizedEdgeGapBps ??
          MAX_EDGE_GAP_BPS,
        minFillQualityPassRate:
          patch.safeToGoLiveThresholds?.minFillQualityPassRate ??
          current.safeToGoLiveThresholds?.minFillQualityPassRate ??
          MIN_FILL_QUALITY_PASS_RATE,
        minNoTradeDisciplinePassRate:
          patch.safeToGoLiveThresholds?.minNoTradeDisciplinePassRate ??
          current.safeToGoLiveThresholds?.minNoTradeDisciplinePassRate ??
          MIN_NO_TRADE_DISCIPLINE_PASS_RATE,
        maxUnresolvedAnomalyCount:
          patch.safeToGoLiveThresholds?.maxUnresolvedAnomalyCount ??
          current.safeToGoLiveThresholds?.maxUnresolvedAnomalyCount ??
          0,
      },
    };
    await this.writeJsonFile(this.baselinePath, next);
    return next;
  }

  async appendSimulatedTrade(record: SentinelSimulatedTradeRecord): Promise<void> {
    await this.ensureDirectories();
    await fs.appendFile(this.tradesPath, `${JSON.stringify(record)}\n`, 'utf8');
  }

  async appendLearningUpdate(update: SentinelLearningUpdate): Promise<void> {
    await this.ensureDirectories();
    await fs.appendFile(this.learningUpdatesPath, `${JSON.stringify(update)}\n`, 'utf8');
  }

  async writeReadiness(status: SentinelReadinessStatus): Promise<void> {
    await this.ensureDirectories();
    await this.writeJsonFile(this.readinessPath, status);
  }

  async readLatestReadiness(): Promise<SentinelReadinessStatus | null> {
    await this.ensureDirectories();
    try {
      const content = await fs.readFile(this.readinessPath, 'utf8');
      return JSON.parse(content) as SentinelReadinessStatus;
    } catch (error) {
      if (isMissingFile(error)) {
        return null;
      }

      this.logger.warn('Sentinel readiness artifact could not be read.', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async loadRecentSimulatedTrades(limit: number): Promise<SentinelSimulatedTradeRecord[]> {
    const records = await this.loadJsonLines<SentinelSimulatedTradeRecord>(this.tradesPath);
    return records.slice(Math.max(0, records.length - Math.max(0, limit)));
  }

  async loadAllSimulatedTrades(): Promise<SentinelSimulatedTradeRecord[]> {
    return this.loadJsonLines<SentinelSimulatedTradeRecord>(this.tradesPath);
  }

  async loadAllLearningUpdates(): Promise<SentinelLearningUpdate[]> {
    return this.loadJsonLines<SentinelLearningUpdate>(this.learningUpdatesPath);
  }

  async countCompletedTrades(): Promise<number> {
    return (await this.loadAllSimulatedTrades()).length;
  }

  async countLearnedTrades(): Promise<number> {
    const updates = await this.loadAllLearningUpdates();
    return new Set(updates.map((update) => update.simulationTradeId)).size;
  }

  private async ensureDirectories(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  private async loadJsonLines<T>(filePath: string): Promise<T[]> {
    await this.ensureDirectories();
    try {
      const content = await fs.readFile(filePath, 'utf8');
      return content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as T);
    } catch (error) {
      if (isMissingFile(error)) {
        return [];
      }

      this.logger.warn('Sentinel JSONL artifact could not be read.', {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private async writeJsonFile(filePath: string, value: unknown): Promise<void> {
    const tmpPath = `${filePath}.tmp`;
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    try {
      await fs.writeFile(tmpPath, serialized, 'utf8');
      await fs.rename(tmpPath, filePath);
    } finally {
      await fs.rm(tmpPath, { force: true });
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}
