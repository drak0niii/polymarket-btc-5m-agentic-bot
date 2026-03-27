import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { AppLogger } from '@worker/common/logger';
import { DecisionLogService } from '@worker/runtime/decision-log.service';
import { LearningStateStore } from '@worker/runtime/learning-state-store';
import {
  buildStrategyVariantId,
  type HealthLabel,
} from '@polymarket-btc-5m-agentic-bot/domain';
import {
  CapitalLeakAttribution,
  CapitalLeakReportBuilder,
  TradeQualityHistoryStore,
  TradeQualityScorer,
  type CapitalLeakAttributionInput,
  type CapitalLeakAttributionResult,
  type CapitalLeakReport,
} from '@polymarket-btc-5m-agentic-bot/risk-engine';

export interface CapitalLeakReviewResult {
  report: CapitalLeakReport;
  warnings: string[];
  tradeQualityCount: number;
  splitLeakSummary: Record<string, number>;
  reportPath: string;
}

export class CapitalLeakReviewJob {
  private readonly logger = new AppLogger('CapitalLeakReviewJob');
  private readonly learningStateStore: LearningStateStore;
  private readonly decisionLogService: DecisionLogService;
  private readonly capitalLeakAttribution = new CapitalLeakAttribution();
  private readonly capitalLeakReportBuilder = new CapitalLeakReportBuilder();
  private readonly tradeQualityScorer = new TradeQualityScorer();
  private readonly tradeQualityHistoryStore: TradeQualityHistoryStore;
  private readonly rootDir: string;
  private readonly reportDir: string;
  private readonly latestReportPath: string;

  constructor(
    private readonly prisma: PrismaClient,
    learningStateStore?: LearningStateStore,
    tradeQualityHistoryStore?: TradeQualityHistoryStore,
    rootDir?: string,
  ) {
    this.learningStateStore = learningStateStore ?? new LearningStateStore();
    this.rootDir =
      rootDir ??
      path.join(this.learningStateStore.getPaths().rootDir, 'capital-leak');
    this.reportDir = path.join(this.rootDir, 'reports');
    this.latestReportPath = path.join(this.rootDir, 'latest-report.json');
    this.tradeQualityHistoryStore =
      tradeQualityHistoryStore ??
      new TradeQualityHistoryStore(
        path.join(this.learningStateStore.getPaths().rootDir, 'trade-quality'),
      );
    this.decisionLogService = new DecisionLogService(prisma);
  }

  async run(input: {
    from: Date;
    to: Date;
    now?: Date;
    learningState?: Awaited<ReturnType<LearningStateStore['load']>>;
  }): Promise<CapitalLeakReviewResult> {
    const now = input.now ?? new Date();
    const learningState = input.learningState ?? (await this.learningStateStore.load());
    const observations = await this.loadObservations(input.from, input.to, learningState);
    const attributions = observations.map((observation) =>
      this.capitalLeakAttribution.attribute(observation.capitalLeakInput),
    );
    const tradeQualityScores = observations.map((observation) =>
      this.tradeQualityScorer.score(observation.tradeQualityInput),
    );

    await this.tradeQualityHistoryStore.append(tradeQualityScores);

    const report = this.capitalLeakReportBuilder.build({
      generatedAt: now.toISOString(),
      from: input.from.toISOString(),
      to: input.to.toISOString(),
      attributions,
    });
    const splitLeakSummary = summarizeLeakFamilies(report);
    await this.persistReport(report);

    const warnings =
      report.dominantCategory && report.dominantShare >= 0.35 && report.totalLeak > 0
        ? [
            `capital_leak_dominant:${report.dominantCategory}`,
            `capital_leak_share:${report.dominantShare.toFixed(3)}`,
          ]
        : [];

    await this.decisionLogService.record({
      category: 'post_trade',
      eventType: 'capital.leak_review',
      summary: `Capital leak review computed for ${input.from.toISOString()} to ${input.to.toISOString()}.`,
      payload: {
        report,
        splitLeakSummary,
        warnings,
        tradeQualityCount: tradeQualityScores.length,
      },
      createdAt: now.toISOString(),
    });

    if (warnings.length > 0) {
      this.logger.warn('Capital leak review detected a dominant leak category.', {
        dominantCategory: report.dominantCategory,
        dominantShare: report.dominantShare,
        totalLeak: report.totalLeak,
      });
    }

    return {
      report,
      warnings,
      tradeQualityCount: tradeQualityScores.length,
      splitLeakSummary,
      reportPath: this.latestReportPath,
    };
  }

  async readLatestReport(): Promise<CapitalLeakReport | null> {
    return readLatestCapitalLeakReport(this.rootDir);
  }

  getPaths(): {
    rootDir: string;
    reportDir: string;
    latestReportPath: string;
  } {
    return {
      rootDir: this.rootDir,
      reportDir: this.reportDir,
      latestReportPath: this.latestReportPath,
    };
  }

  private async loadObservations(
    from: Date,
    to: Date,
    learningState: Awaited<ReturnType<LearningStateStore['load']>>,
  ): Promise<CapitalLeakObservation[]> {
    const prismaAny = this.prisma as any;
    if (!prismaAny.executionDiagnostic?.findMany) {
      return [];
    }

    const diagnostics = ((await prismaAny.executionDiagnostic.findMany({
      where: {
        capturedAt: {
          gte: from,
          lte: to,
        },
      },
      orderBy: {
        capturedAt: 'asc',
      },
    })) as Array<Record<string, unknown>>).filter((diagnostic) => readString(diagnostic.orderId) != null);
    const latestDiagnostics = selectLatestByOrder(diagnostics);
    const orderIds = latestDiagnostics
      .map((diagnostic) => readString(diagnostic.orderId))
      .filter((value): value is string => value != null);

    const orders = prismaAny.order?.findMany
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
    const auditEvents = prismaAny.auditEvent?.findMany
      ? ((await prismaAny.auditEvent.findMany({
          where: {
            orderId: {
              in: orderIds,
            },
            createdAt: {
              lte: to,
            },
          },
          orderBy: {
            createdAt: 'asc',
          },
        })) as Array<Record<string, unknown>>)
      : [];
    const decisionEvents = prismaAny.auditEvent?.findMany
      ? ((await prismaAny.auditEvent.findMany({
          where: {
            signalId: {
              in: orders
                .map((order) =>
                  order.signal && typeof order.signal === 'object'
                    ? readString((order.signal as Record<string, unknown>).id)
                    : null,
                )
                .filter((value): value is string => value != null),
            },
            eventType: 'signal.execution_decision',
            createdAt: {
              lte: to,
            },
          },
          orderBy: {
            createdAt: 'desc',
          },
        })) as Array<Record<string, unknown>>)
      : [];
    const approvedDecisions = prismaAny.signalDecision?.findMany
      ? ((await prismaAny.signalDecision.findMany({
          where: {
            signalId: {
              in: orders
                .map((order) =>
                  order.signal && typeof order.signal === 'object'
                    ? readString((order.signal as Record<string, unknown>).id)
                    : null,
                )
                .filter((value): value is string => value != null),
            },
            verdict: 'approved',
          },
          orderBy: {
            decisionAt: 'desc',
          },
        })) as Array<Record<string, unknown>>)
      : [];

    const orderById = new Map(orders.map((order) => [readString(order.id) ?? '', order]));
    const decisionEventBySignalId = selectLatestByKey(
      decisionEvents,
      (event) => readString(event.signalId),
      (event) => readDate(event.createdAt)?.getTime() ?? 0,
    );
    const approvedDecisionBySignalId = selectLatestByKey(
      approvedDecisions,
      (decision) => readString(decision.signalId),
      (decision) => readDate(decision.decisionAt)?.getTime() ?? 0,
    );

    return latestDiagnostics
      .map((diagnostic) => {
        const orderId = readString(diagnostic.orderId);
        if (!orderId) {
          return null;
        }

        const order = orderById.get(orderId) ?? null;
        const signal =
          order?.signal && typeof order.signal === 'object'
            ? (order.signal as Record<string, unknown>)
            : null;
        const market =
          order?.market && typeof order.market === 'object'
            ? (order.market as Record<string, unknown>)
            : null;
        const signalId = readString(signal?.id);
        const strategyVersionId =
          readString(diagnostic.strategyVersionId) ??
          readString(order?.strategyVersionId) ??
          readString(signal?.strategyVersionId);
        const strategyVariantId = strategyVersionId
          ? buildStrategyVariantId(strategyVersionId)
          : null;
        const decisionEvent = signalId ? decisionEventBySignalId.get(signalId) ?? null : null;
        const approvedDecision = signalId ? approvedDecisionBySignalId.get(signalId) ?? null : null;
        const executionStyle = inferExecutionStyle(diagnostic, order);
        const marketContext =
          readString(market?.slug) ??
          readString(market?.title) ??
          readString(order?.marketId) ??
          'unknown_market_context';
        const policyBreaches = [
          ...readPolicyBreaches(decisionEvent),
          ...(readNoTradeReasons(decisionEvent).length > 0 ? ['no_trade_zone'] : []),
        ];
        const calibrationHealth = strategyVariantId
          ? resolveCalibrationHealth(learningState, strategyVariantId, readString(signal?.regime))
          : null;
        const regimeHealth = strategyVariantId
          ? resolveRegimeHealth(learningState, strategyVariantId, readString(signal?.regime))
          : null;
        const evaluatedAt = readDateString(diagnostic.capturedAt) ?? to.toISOString();
        const fillDelayMs = inferDelayMs(order, diagnostic);
        const netEdgeAtDecision = readNetEdge(decisionEvent);
        const netEdgeThreshold = readNetEdgeThreshold(decisionEvent);
        const venueUncertaintyLabel = readVenueUncertainty(decisionEvent);
        const allocatedNotional =
          readNumber(approvedDecision?.positionSize, null) ??
          ((readNumber(order?.price, null) ?? 0) * (readNumber(order?.size, null) ?? 0));
        const recommendedNotional = allocatedNotional;
        const tradeId = orderId;

        const observation: CapitalLeakObservation = {
          capitalLeakInput: {
            tradeId,
            orderId,
            signalId,
            marketId: readString(order?.marketId) ?? readString(signal?.marketId),
            strategyVariantId,
            regime: readString(diagnostic.regime) ?? readString(signal?.regime),
            marketContext,
            executionStyle,
            observedAt: evaluatedAt,
            expectedEv: readNumber(diagnostic.expectedEv, null) ?? readNumber(signal?.expectedEv, null),
            realizedEv: readNumber(diagnostic.realizedEv, null),
            expectedSlippage: readNumber(diagnostic.expectedSlippage, null),
            realizedSlippage: readNumber(diagnostic.realizedSlippage, null),
            edgeAtSignal: readNumber(diagnostic.edgeAtSignal, null) ?? readNumber(signal?.edge, null),
            edgeAtFill: readNumber(diagnostic.edgeAtFill, null),
            fillRate: readNumber(diagnostic.fillRate, null),
            allocatedNotional,
            recommendedNotional,
            calibrationHealth,
            regimeHealth,
            venueUncertaintyLabel,
            netEdgeAtDecision,
            netEdgeThreshold,
            policyBreaches,
          },
          tradeQualityInput: {
            tradeId,
            orderId,
            signalId,
            marketId: readString(order?.marketId) ?? readString(signal?.marketId),
            strategyVariantId,
            regime: readString(diagnostic.regime) ?? readString(signal?.regime),
            marketContext,
            executionStyle,
            evaluatedAt,
            expectedEv: readNumber(diagnostic.expectedEv, null) ?? readNumber(signal?.expectedEv, null),
            realizedEv: readNumber(diagnostic.realizedEv, null),
            forecastEdge: readNumber(diagnostic.edgeAtSignal, null) ?? readNumber(signal?.edge, null),
            calibrationHealth,
            fillRate: readNumber(diagnostic.fillRate, null),
            expectedSlippage: readNumber(diagnostic.expectedSlippage, null),
            realizedSlippage: readNumber(diagnostic.realizedSlippage, null),
            fillDelayMs,
            policyBreaches,
          },
        };
        return observation;
      })
      .filter((observation): observation is CapitalLeakObservation => observation != null);
  }

  private async persistReport(report: CapitalLeakReport): Promise<void> {
    await fs.mkdir(this.reportDir, { recursive: true });
    const reportPath = path.join(
      this.reportDir,
      `capital-leak-report-${report.generatedAt.replace(/[:.]/g, '-')}.json`,
    );
    const payload = `${JSON.stringify(report, null, 2)}\n`;
    const latestTmp = `${this.latestReportPath}.tmp`;
    await fs.writeFile(reportPath, payload, 'utf8');
    await fs.writeFile(latestTmp, payload, 'utf8');
    await fs.rename(latestTmp, this.latestReportPath);
  }
}

export async function readLatestCapitalLeakReport(rootDir?: string): Promise<CapitalLeakReport | null> {
  const resolvedRoot =
    rootDir ??
    path.join(new LearningStateStore().getPaths().rootDir, 'capital-leak');
  const latestReportPath = path.join(resolvedRoot, 'latest-report.json');
  try {
    const content = await fs.readFile(latestReportPath, 'utf8');
    return JSON.parse(content) as CapitalLeakReport;
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

function selectLatestByOrder(
  diagnostics: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const latest = new Map<string, Record<string, unknown>>();
  for (const diagnostic of diagnostics) {
    const orderId = readString(diagnostic.orderId);
    if (!orderId) {
      continue;
    }
    const current = latest.get(orderId);
    const currentAt = current ? readDate(current.capturedAt)?.getTime() ?? 0 : 0;
    const candidateAt = readDate(diagnostic.capturedAt)?.getTime() ?? 0;
    if (!current || candidateAt >= currentAt) {
      latest.set(orderId, diagnostic);
    }
  }
  return [...latest.values()];
}

function selectLatestByKey(
  records: Array<Record<string, unknown>>,
  keyFor: (record: Record<string, unknown>) => string | null,
  sortValueFor: (record: Record<string, unknown>) => number,
): Map<string, Record<string, unknown>> {
  const latest = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    const key = keyFor(record);
    if (!key) {
      continue;
    }

    const current = latest.get(key);
    if (!current || sortValueFor(record) >= sortValueFor(current)) {
      latest.set(key, record);
    }
  }
  return latest;
}

function inferExecutionStyle(
  diagnostic: Record<string, unknown>,
  order: Record<string, unknown> | null,
): string {
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

function inferDelayMs(
  order: Record<string, unknown> | null,
  diagnostic: Record<string, unknown>,
): number | null {
  const orderCreatedAt = readDate(order?.createdAt);
  const capturedAt = readDate(diagnostic.capturedAt);
  if (!orderCreatedAt || !capturedAt) {
    return null;
  }
  return Math.max(0, capturedAt.getTime() - orderCreatedAt.getTime());
}

function readPolicyBreaches(event: Record<string, unknown> | null): string[] {
  const metadata = readMetadata(event);
  const rolloutControls =
    metadata.rolloutControls && typeof metadata.rolloutControls === 'object'
      ? (metadata.rolloutControls as Record<string, unknown>)
      : null;
  const breaches = Array.isArray(rolloutControls?.reasonCodes)
    ? (rolloutControls?.reasonCodes as unknown[]).filter(
        (value): value is string => typeof value === 'string',
      )
    : [];
  const reasons = Array.isArray(metadata.reasons)
    ? (metadata.reasons as unknown[]).filter((value): value is string => typeof value === 'string')
    : [];
  return [...reasons, ...breaches];
}

function readNoTradeReasons(event: Record<string, unknown> | null): string[] {
  const metadata = readMetadata(event);
  const noTradeZone =
    metadata.noTradeZone && typeof metadata.noTradeZone === 'object'
      ? (metadata.noTradeZone as Record<string, unknown>)
      : null;
  return Array.isArray(noTradeZone?.reasons)
    ? (noTradeZone?.reasons as unknown[]).filter((value): value is string => typeof value === 'string')
    : [];
}

function readNetEdge(event: Record<string, unknown> | null): number | null {
  const metadata = readMetadata(event);
  const netEdgeDecision =
    metadata.netEdgeDecision && typeof metadata.netEdgeDecision === 'object'
      ? (metadata.netEdgeDecision as Record<string, unknown>)
      : null;
  const breakdown =
    netEdgeDecision?.breakdown && typeof netEdgeDecision.breakdown === 'object'
      ? (netEdgeDecision.breakdown as Record<string, unknown>)
      : null;
  return readNumber(breakdown?.finalNetEdge, null);
}

function readNetEdgeThreshold(event: Record<string, unknown> | null): number | null {
  const metadata = readMetadata(event);
  const threshold =
    metadata.netEdgeThreshold && typeof metadata.netEdgeThreshold === 'object'
      ? (metadata.netEdgeThreshold as Record<string, unknown>)
      : null;
  return readNumber(threshold?.minimumNetEdge, null);
}

function readVenueUncertainty(
  event: Record<string, unknown> | null,
): 'healthy' | 'degraded' | 'unsafe' | null {
  const metadata = readMetadata(event);
  const venueAssessment =
    metadata.venueAssessment && typeof metadata.venueAssessment === 'object'
      ? (metadata.venueAssessment as Record<string, unknown>)
      : null;
  const label = readString(venueAssessment?.label);
  return label === 'healthy' || label === 'degraded' || label === 'unsafe'
    ? label
    : null;
}

function resolveCalibrationHealth(
  learningState: Awaited<ReturnType<LearningStateStore['load']>>,
  strategyVariantId: string,
  regime: string | null,
): HealthLabel | null {
  const exact = Object.values(learningState.calibration).find(
    (calibration) =>
      calibration.strategyVariantId === strategyVariantId && calibration.regime === regime,
  );
  if (exact) {
    return exact.health;
  }
  const fallback = Object.values(learningState.calibration).find(
    (calibration) =>
      calibration.strategyVariantId === strategyVariantId && calibration.regime == null,
  );
  return fallback?.health ?? null;
}

function resolveRegimeHealth(
  learningState: Awaited<ReturnType<LearningStateStore['load']>>,
  strategyVariantId: string,
  regime: string | null,
): HealthLabel | null {
  const variant = learningState.strategyVariants[strategyVariantId] ?? null;
  if (!variant) {
    return null;
  }
  const matching = Object.values(variant.regimeSnapshots).filter(
    (snapshot) => snapshot.regime === regime,
  );
  if (matching.length === 0) {
    return variant.health;
  }
  const priority: Record<HealthLabel, number> = {
    healthy: 0,
    watch: 1,
    degraded: 2,
    quarantine_candidate: 3,
  };
  return matching.reduce<HealthLabel>(
    (worst, snapshot) =>
      priority[snapshot.health] > priority[worst] ? snapshot.health : worst,
    variant.health,
  );
}

function readMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || !('metadata' in value)) {
    return {};
  }
  const metadata = (value as { metadata?: unknown }).metadata;
  return metadata && typeof metadata === 'object'
    ? (metadata as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(value: unknown, fallback: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
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

export function createDefaultTradeQualityHistoryStore(
  learningStateStore?: LearningStateStore,
): TradeQualityHistoryStore {
  if (learningStateStore) {
    return new TradeQualityHistoryStore(
      path.join(learningStateStore.getPaths().rootDir, 'trade-quality'),
    );
  }

  if (process.env.DATABASE_URL === 'postgresql://test') {
    return new TradeQualityHistoryStore(
      path.join(os.tmpdir(), `trade-quality-${randomUUID()}`),
    );
  }

  return new TradeQualityHistoryStore();
}

interface CapitalLeakObservation {
  capitalLeakInput: CapitalLeakAttributionInput;
  tradeQualityInput: Parameters<TradeQualityScorer['score']>[0];
}

function summarizeLeakFamilies(report: CapitalLeakReport): Record<string, number> {
  const summary = {
    alpha_wrong: 0,
    execution_wrong: 0,
    size_too_large: 0,
    regime_wrong: 0,
    adverse_selection: 0,
    fee_slippage_underestimation: 0,
  };

  for (const [category, totalLeak] of Object.entries(report.categoryTotals)) {
    if (typeof totalLeak !== 'number' || !Number.isFinite(totalLeak)) {
      continue;
    }
    switch (category) {
      case 'false_positive_forecast':
      case 'calibration_error':
      case 'overtrading':
        summary.alpha_wrong += totalLeak;
        break;
      case 'missed_fills':
      case 'venue_degradation_cost':
        summary.execution_wrong += totalLeak;
        break;
      case 'poor_sizing':
        summary.size_too_large += totalLeak;
        break;
      case 'degraded_regime_trading':
        summary.regime_wrong += totalLeak;
        break;
      case 'adverse_selection':
        summary.adverse_selection += totalLeak;
        break;
      case 'slippage':
        summary.fee_slippage_underestimation += totalLeak;
        break;
    }
  }

  return summary;
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT',
  );
}
