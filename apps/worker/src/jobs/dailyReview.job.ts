import type { PrismaClient } from '@prisma/client';
import { AppLogger } from '@worker/common/logger';
import {
  type ExecutionStyle,
  type LearningCycleSummary,
  type LearningTradeSide,
} from '@polymarket-btc-5m-agentic-bot/domain';
import {
  LiveCalibrationStore,
  LiveCalibrationUpdater,
} from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { LearningCycleRunner, type LearningCycleSample } from '@worker/orchestration/learning-cycle-runner';
import { LearningEventLog } from '@worker/runtime/learning-event-log';
import { LearningStateStore } from '@worker/runtime/learning-state-store';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export class DailyReviewJob {
  private readonly logger = new AppLogger('DailyReviewJob');
  private readonly learningStateStore: LearningStateStore;
  private readonly learningEventLog: LearningEventLog;
  private readonly runner: LearningCycleRunner;

  constructor(
    private readonly prisma: PrismaClient,
    learningStateStore?: LearningStateStore,
    learningEventLog?: LearningEventLog,
  ) {
    this.learningStateStore = learningStateStore ?? new LearningStateStore();
    this.learningEventLog = learningEventLog ?? new LearningEventLog();
    const calibrationStore = new LiveCalibrationStore({
      loadState: () => this.learningStateStore.load(),
      saveState: (state) => this.learningStateStore.save(state),
    });
    this.runner = new LearningCycleRunner(new LiveCalibrationUpdater(calibrationStore));
  }

  async runDueCycle(now = new Date()): Promise<LearningCycleSummary | null> {
    const state = await this.learningStateStore.load();
    if (!isLearningCycleDue(state.lastCycleCompletedAt, now)) {
      return null;
    }

    return this.run({ now, priorState: state });
  }

  async run(options?: {
    now?: Date;
    force?: boolean;
    priorState?: Awaited<ReturnType<LearningStateStore['load']>>;
  }): Promise<LearningCycleSummary> {
    const now = options?.now ?? new Date();
    const priorState = options?.priorState ?? (await this.learningStateStore.load());
    if (!options?.force && !isLearningCycleDue(priorState.lastCycleCompletedAt, now)) {
      return (
        priorState.lastCycleSummary ?? {
          cycleId: 'learning-cycle-skipped',
          startedAt: now.toISOString(),
          completedAt: now.toISOString(),
          status: 'completed',
          analyzedWindow: {
            from: now.toISOString(),
            to: now.toISOString(),
          },
          realizedOutcomeCount: 0,
          attributionSliceCount: 0,
          calibrationUpdates: 0,
          shrinkageActions: 0,
          degradedContexts: [],
          warnings: ['learning_cycle_not_due'],
          errors: [],
        }
      );
    }

    const cycleId = `learning-cycle-${now.toISOString().replace(/[:.]/g, '-')}`;
    const window = determineLearningWindow(priorState.lastCycleCompletedAt, now);
    const startedState = {
      ...priorState,
      lastCycleStartedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    await this.learningStateStore.save(startedState);
    await this.learningEventLog.append([
      {
        id: `${cycleId}:started`,
        type: 'learning_cycle_started',
        severity: 'info',
        createdAt: now.toISOString(),
        cycleId,
        strategyVariantId: null,
        contextKey: null,
        summary: 'Learning cycle started.',
        details: {
          analyzedWindow: {
            from: window.from.toISOString(),
            to: window.to.toISOString(),
          },
        },
      },
    ]);

    try {
      const samples = await this.loadRealizedOutcomeSamples(window.from, window.to);
      const completedAt = new Date();
      const result = await this.runner.run({
        cycleId,
        startedAt: now,
        completedAt,
        analyzedWindow: window,
        priorState: startedState,
        samples,
      });

      await this.learningStateStore.save(result.nextState);
      await this.learningEventLog.append(result.events);

      this.logger.log('Daily learning cycle completed.', {
        cycleId,
        status: result.summary.status,
        realizedOutcomeCount: result.summary.realizedOutcomeCount,
        calibrationUpdates: result.summary.calibrationUpdates,
      });

      return result.summary;
    } catch (error) {
      const completedAt = new Date();
      const summary: LearningCycleSummary = {
        cycleId,
        startedAt: now.toISOString(),
        completedAt: completedAt.toISOString(),
        status: 'failed',
        analyzedWindow: {
          from: window.from.toISOString(),
          to: window.to.toISOString(),
        },
        realizedOutcomeCount: 0,
        attributionSliceCount: 0,
        calibrationUpdates: 0,
        shrinkageActions: 0,
        degradedContexts: [],
        warnings: [],
        errors: [error instanceof Error ? error.message : String(error)],
      };

      await this.learningStateStore.save({
        ...startedState,
        lastCycleCompletedAt: completedAt.toISOString(),
        lastCycleSummary: summary,
        updatedAt: completedAt.toISOString(),
      });

      await this.learningEventLog.append([
        {
          id: `${cycleId}:failed`,
          type: 'learning_cycle_failed',
          severity: 'critical',
          createdAt: completedAt.toISOString(),
          cycleId,
          strategyVariantId: null,
          contextKey: null,
          summary: 'Learning cycle failed.',
          details: {
            errors: summary.errors,
          },
        },
      ]);

      this.logger.error('Daily learning cycle failed.', undefined, {
        cycleId,
        error: summary.errors[0],
      });

      return summary;
    }
  }

  private async loadRealizedOutcomeSamples(
    from: Date,
    to: Date,
  ): Promise<LearningCycleSample[]> {
    const prismaAny = this.prisma as any;
    const diagnostics = (await prismaAny.executionDiagnostic.findMany({
      where: {
        capturedAt: {
          gte: from,
          lte: to,
        },
      },
      orderBy: {
        capturedAt: 'asc',
      },
    })) as Array<Record<string, unknown>>;

    const orderIds = diagnostics
      .map((diagnostic) => readString(diagnostic.orderId))
      .filter((value): value is string => Boolean(value));
    const orders = orderIds.length
      ? ((await prismaAny.order.findMany({
          where: {
            id: {
              in: orderIds,
            },
          },
          include: {
            signal: true,
            market: true,
          },
        })) as Array<Record<string, unknown>>)
      : [];
    const orderById = new Map(
      orders.map((order) => [readString(order.id) ?? '', order]),
    );

    const samples: LearningCycleSample[] = [];
    for (const diagnostic of diagnostics) {
      const orderId = readString(diagnostic.orderId);
      const order = orderId ? orderById.get(orderId) ?? null : null;
      const signal =
        order?.signal && typeof order.signal === 'object'
          ? (order.signal as Record<string, unknown>)
          : null;
      const market =
        order?.market && typeof order.market === 'object'
          ? (order.market as Record<string, unknown>)
          : null;
      const marketId =
        readString(order?.marketId) ??
        readString(signal?.marketId) ??
        readString(diagnostic.marketId) ??
        null;
      const tokenId = readString(order?.tokenId);
      const observedAt =
        readDateString(diagnostic.capturedAt) ??
        readDateString(signal?.observedAt) ??
        new Date().toISOString();
      const orderbook = marketId && tokenId
        ? ((await prismaAny.orderbook.findFirst({
            where: {
              marketId,
              tokenId,
              observedAt: {
                lte: new Date(observedAt),
              },
            },
            orderBy: {
              observedAt: 'desc',
            },
          })) as Record<string, unknown> | null)
        : null;
      const signalObservedAt = readDate(signal?.observedAt);
      const expiryAt = readDate(market?.expiresAt);
      const acknowledgedAt = readDate(order?.acknowledgedAt) ?? readDate(order?.createdAt);
      const timeToExpirySeconds =
        signalObservedAt && expiryAt
          ? Math.max(0, Math.floor((expiryAt.getTime() - signalObservedAt.getTime()) / 1000))
          : null;
      const entryDelayMs =
        signalObservedAt && acknowledgedAt
          ? Math.max(0, acknowledgedAt.getTime() - signalObservedAt.getTime())
          : null;
      const spread = readNumber(orderbook?.spread, null);
      const side = mapSide(readString(order?.side));
      const sample: LearningCycleSample = {
        strategyVariantId:
          readString(diagnostic.strategyVersionId) ??
          readString(order?.strategyVersionId) ??
          readString(signal?.strategyVersionId) ??
          'unknown_strategy_variant',
        regime:
          readString(diagnostic.regime) ??
          readString(signal?.regime) ??
          'unknown_regime',
        side,
        expectedEv:
          readNumber(diagnostic.expectedEv, null) ??
          readNumber(signal?.expectedEv, null) ??
          0,
        realizedEv: readNumber(diagnostic.realizedEv, null) ?? 0,
        fillRate: readNumber(diagnostic.fillRate, null),
        realizedSlippage: readNumber(diagnostic.realizedSlippage, null),
        liquidityDepth: extractTopDepth(orderbook, side),
        spread,
        timeToExpirySeconds,
        entryDelayMs,
        executionStyle: inferExecutionStyle(diagnostic, order),
        observedAt,
        predictedProbability: readNumber(signal?.posteriorProbability, null) ?? 0.5,
        realizedOutcome:
          (readNumber(diagnostic.realizedEv, null) ?? 0) > 0 ? 1 : 0,
      };
      samples.push(sample);
    }

    return samples;
  }
}

export function isLearningCycleDue(
  lastCycleCompletedAt: string | null,
  now: Date,
): boolean {
  if (!lastCycleCompletedAt) {
    return true;
  }

  const completedAt = new Date(lastCycleCompletedAt);
  if (Number.isNaN(completedAt.getTime())) {
    return true;
  }

  return now.getTime() - completedAt.getTime() >= ONE_DAY_MS;
}

function determineLearningWindow(
  lastCycleCompletedAt: string | null,
  now: Date,
): { from: Date; to: Date } {
  const fallback = new Date(now.getTime() - ONE_DAY_MS);
  if (!lastCycleCompletedAt) {
    return { from: fallback, to: now };
  }

  const parsed = new Date(lastCycleCompletedAt);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() >= now.getTime()) {
    return { from: fallback, to: now };
  }

  return { from: parsed, to: now };
}

function inferExecutionStyle(
  diagnostic: Record<string, unknown>,
  order: Record<string, unknown> | null,
): ExecutionStyle {
  const fillRate = readNumber(diagnostic.fillRate, null);
  const realizedSlippage = readNumber(diagnostic.realizedSlippage, null);
  const staleOrder = readBoolean(diagnostic.staleOrder) ?? false;

  if (staleOrder || (fillRate != null && fillRate < 0.8 && (realizedSlippage ?? 0) <= 0.003)) {
    return 'maker';
  }
  if ((realizedSlippage ?? 0) > 0.004 || readString(order?.status) === 'filled') {
    return 'taker';
  }
  if (fillRate != null || realizedSlippage != null) {
    return 'hybrid';
  }
  return 'unknown';
}

function extractTopDepth(
  orderbook: Record<string, unknown> | null,
  side: LearningTradeSide,
): number | null {
  if (!orderbook) {
    return null;
  }

  const field = side === 'sell' ? orderbook.bidLevels : orderbook.askLevels;
  if (!Array.isArray(field) || field.length === 0) {
    return null;
  }

  const top = field[0];
  if (!top || typeof top !== 'object') {
    return null;
  }

  const record = top as Record<string, unknown>;
  return readNumber(record.size, null);
}

function mapSide(value: string | null): LearningTradeSide {
  if (value === 'BUY') {
    return 'buy';
  }
  if (value === 'SELL') {
    return 'sell';
  }
  return 'unknown';
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(value: unknown, fallback: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function readDateString(value: unknown): string | null {
  const parsed = readDate(value);
  return parsed ? parsed.toISOString() : null;
}
