import type { PrismaClient } from '@prisma/client';
import type {
  VersionLineageDecisionRecord,
  VenueRuntimeMode,
  VenueUncertaintyLabel,
} from '@polymarket-btc-5m-agentic-bot/domain';
import { VenueHealthLearningStore } from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';
import {
  VenueModePolicy,
  VenueUncertaintyDetector,
} from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';
import { LearningStateStore } from './learning-state-store';
import { StrategyDeploymentRegistry } from './strategy-deployment-registry';
import { VersionLineageRegistry } from './version-lineage-registry';

export interface DecisionReplayContextResult {
  decisionId: string;
  decisionType: VersionLineageDecisionRecord['decisionType'];
  recordedAt: string;
  summary: string;
  signalId: string | null;
  signalDecisionId: string | null;
  orderId: string | null;
  marketId: string | null;
  cycleId: string | null;
  marketState: Record<string, unknown> | null;
  runtimeState: Record<string, unknown> | null;
  learningState: Record<string, unknown> | null;
  lineageState: Record<string, unknown> | null;
  activeParameterBundle: Record<string, unknown> | null;
  venueMode: VenueRuntimeMode | null;
  venueUncertainty: VenueUncertaintyLabel | null;
  sourceArtifacts: {
    signal: unknown;
    signalDecision: unknown;
    order: unknown;
    fills: unknown[];
    auditEvents: unknown[];
    market: unknown;
    marketSnapshot: unknown;
    orderbook: unknown;
    runtimeStatus: unknown;
  };
  reconstructable: boolean;
}

export class DecisionReplayContext {
  private readonly uncertaintyDetector = new VenueUncertaintyDetector();
  private readonly venueModePolicy = new VenueModePolicy();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly versionLineageRegistry = new VersionLineageRegistry(),
    private readonly learningStateStore = new LearningStateStore(),
    private readonly strategyDeploymentRegistry = new StrategyDeploymentRegistry(),
    private readonly venueHealthLearningStore = new VenueHealthLearningStore(),
  ) {}

  async reconstructByDecisionId(
    decisionId: string,
  ): Promise<DecisionReplayContextResult | null> {
    const record = await this.versionLineageRegistry.getDecision(decisionId);
    if (!record) {
      return null;
    }
    return this.reconstruct(record);
  }

  async reconstructLatestForSignal(
    signalId: string,
  ): Promise<DecisionReplayContextResult | null> {
    const record = await this.versionLineageRegistry.getLatestForSignal(signalId);
    if (!record) {
      return null;
    }
    return this.reconstruct(record);
  }

  private async reconstruct(
    record: VersionLineageDecisionRecord,
  ): Promise<DecisionReplayContextResult> {
    const prismaAny = this.prisma as any;
    const [
      learningState,
      deploymentRegistry,
      currentVenueMetrics,
      signal,
      signalDecision,
      order,
      fills,
      auditEvents,
      market,
      marketSnapshot,
      orderbook,
      runtimeStatus,
    ] = await Promise.all([
      this.learningStateStore.load(),
      this.strategyDeploymentRegistry.load(),
      this.venueHealthLearningStore.getCurrentMetrics(),
      record.signalId && prismaAny.signal?.findUnique
        ? prismaAny.signal.findUnique({ where: { id: record.signalId } })
        : Promise.resolve(null),
      record.signalDecisionId && prismaAny.signalDecision?.findUnique
        ? prismaAny.signalDecision.findUnique({ where: { id: record.signalDecisionId } })
        : record.signalId && prismaAny.signalDecision?.findFirst
          ? prismaAny.signalDecision.findFirst({
              where: { signalId: record.signalId },
              orderBy: { decisionAt: 'desc' },
            })
          : Promise.resolve(null),
      record.orderId && prismaAny.order?.findUnique
        ? prismaAny.order.findUnique({ where: { id: record.orderId } })
        : Promise.resolve(null),
      record.orderId && prismaAny.fill?.findMany
        ? prismaAny.fill.findMany({
            where: { orderId: record.orderId },
            orderBy: { filledAt: 'asc' },
          })
        : Promise.resolve([]),
      prismaAny.auditEvent?.findMany
        ? prismaAny.auditEvent.findMany({
            where: {
              ...(record.signalId ? { signalId: record.signalId } : {}),
              ...(record.orderId ? { orderId: record.orderId } : {}),
            },
            orderBy: { createdAt: 'asc' },
          })
        : Promise.resolve([]),
      record.marketId && prismaAny.market?.findUnique
        ? prismaAny.market.findUnique({ where: { id: record.marketId } })
        : Promise.resolve(null),
      record.marketId && prismaAny.marketSnapshot?.findFirst
        ? prismaAny.marketSnapshot.findFirst({
            where: { marketId: record.marketId },
            orderBy: { observedAt: 'desc' },
          })
        : Promise.resolve(null),
      record.marketId && prismaAny.orderbook?.findFirst
        ? prismaAny.orderbook.findFirst({
            where: { marketId: record.marketId },
            orderBy: { observedAt: 'desc' },
          })
        : Promise.resolve(null),
      prismaAny.botRuntimeStatus?.findUnique
        ? prismaAny.botRuntimeStatus.findUnique({ where: { id: 'live' } })
        : Promise.resolve(null),
    ]);

    const currentVenueAssessment = currentVenueMetrics
      ? this.uncertaintyDetector.evaluate(currentVenueMetrics)
      : null;
    const currentVenueMode = currentVenueAssessment
      ? this.venueModePolicy.decide(currentVenueAssessment)
      : null;

    const marketState = record.replay.marketState ?? buildMarketState({
      market,
      marketSnapshot,
      orderbook,
    });
    const runtimeState =
      record.replay.runtimeState ??
      ({
        runtimeStatus,
      } as Record<string, unknown>);
    const lineageState =
      record.replay.lineageState ??
      ({
        lineage: record.lineage,
        activeDeployment: {
          incumbentVariantId: deploymentRegistry.incumbentVariantId,
          activeRollout: deploymentRegistry.activeRollout,
          lastPromotionDecision: deploymentRegistry.lastPromotionDecision,
          lastRollback: deploymentRegistry.lastRollback,
        },
      } as Record<string, unknown>);
    const replayLearningState =
      record.replay.learningState ??
      ({
        lastCycleSummary: learningState.lastCycleSummary,
        strategyVariant:
          record.strategyVariantId != null
            ? learningState.strategyVariants[record.strategyVariantId] ?? null
            : null,
        executionLearning: learningState.executionLearning,
        portfolioLearning: learningState.portfolioLearning,
      } as Record<string, unknown>);
    const venueMode = record.replay.venueMode ?? currentVenueMode?.mode ?? null;
    const venueUncertainty =
      record.replay.venueUncertainty ?? currentVenueAssessment?.label ?? null;

    return {
      decisionId: record.decisionId,
      decisionType: record.decisionType,
      recordedAt: record.recordedAt,
      summary: record.summary,
      signalId: record.signalId,
      signalDecisionId: record.signalDecisionId,
      orderId: record.orderId,
      marketId: record.marketId,
      cycleId: record.cycleId,
      marketState,
      runtimeState,
      learningState: replayLearningState,
      lineageState,
      activeParameterBundle: record.replay.activeParameterBundle,
      venueMode,
      venueUncertainty,
      sourceArtifacts: {
        signal,
        signalDecision,
        order,
        fills,
        auditEvents,
        market,
        marketSnapshot,
        orderbook,
        runtimeStatus,
      },
      reconstructable:
        marketState != null &&
        runtimeState != null &&
        replayLearningState != null &&
        lineageState != null &&
        record.replay.activeParameterBundle != null,
    };
  }
}

function buildMarketState(input: {
  market: unknown;
  marketSnapshot: unknown;
  orderbook: unknown;
}): Record<string, unknown> | null {
  if (!input.market && !input.marketSnapshot && !input.orderbook) {
    return null;
  }
  return {
    market: input.market,
    marketSnapshot: input.marketSnapshot,
    orderbook: input.orderbook,
  };
}
