import { PrismaClient } from '@prisma/client';
import type {
  AuditDecisionLog,
  SentinelReadinessStatus,
  SentinelSimulatedTradeRecord,
} from '@polymarket-btc-5m-agentic-bot/domain';

export class DecisionLogService {
  constructor(private readonly prisma: PrismaClient) {}

  async record(input: AuditDecisionLog): Promise<void> {
    const auditEventModel = (this.prisma as any).auditEvent;
    if (!auditEventModel?.create) {
      return;
    }

    await auditEventModel.create({
      data: {
        marketId: input.marketId ?? null,
        signalId: input.signalId ?? null,
        orderId: input.orderId ?? null,
        eventType: input.eventType,
        message: input.summary,
        metadata: {
          category: input.category,
          ...input.payload,
        },
        createdAt: new Date(input.createdAt),
      },
    });
  }

  async recordSentinelTradeEvidence(input: {
    trade: SentinelSimulatedTradeRecord;
    summary?: string;
  }): Promise<void> {
    await this.record({
      category: 'post_trade',
      eventType: 'sentinel.trade_simulated',
      summary:
        input.summary ??
        `Sentinel simulated trade recorded for signal ${input.trade.signalId}.`,
      marketId: input.trade.marketId,
      signalId: input.trade.signalId,
      payload: {
        sentinelTrade: input.trade,
      },
      createdAt: input.trade.simulatedAt,
    });
  }

  async recordSentinelRecommendationTransition(input: {
    previous: SentinelReadinessStatus | null;
    next: SentinelReadinessStatus;
  }): Promise<void> {
    if (
      input.previous?.recommendationState === input.next.recommendationState &&
      input.previous?.recommendationMessage === input.next.recommendationMessage
    ) {
      return;
    }

    await this.record({
      category: 'readiness',
      eventType: 'sentinel.recommendation_updated',
      summary: 'Sentinel readiness recommendation updated.',
      payload: {
        previousRecommendationState: input.previous?.recommendationState ?? null,
        nextRecommendationState: input.next.recommendationState,
        readinessScore: input.next.readinessScore,
        readinessThreshold: input.next.readinessThreshold,
        recommendationMessage: input.next.recommendationMessage,
      },
      createdAt: input.next.updatedAt,
    });
  }

  summarizeAuditCoverage(events: unknown[]): {
    coverage: number;
    healthy: boolean;
  } {
    const requiredFamilies = [
      'signal.edge_assessed',
      'signal.admission_decision',
      'signal.execution_decision',
      'trade.post_trade_attribution',
      'trade.loss_attribution_classified',
      'runtime.readiness_dashboard',
    ];

    const seen = new Set(
      (events ?? [])
        .map((event) =>
          event && typeof event === 'object' && 'eventType' in (event as Record<string, unknown>)
            ? String((event as Record<string, unknown>).eventType)
            : '',
        )
        .filter((value) => value.length > 0),
    );

    const present = requiredFamilies.filter((family) => seen.has(family)).length;
    const coverage = requiredFamilies.length > 0 ? present / requiredFamilies.length : 0;
    return {
      coverage,
      healthy: coverage >= 0.6,
    };
  }

  summarizeProofCoverage(events: unknown[]): {
    coverage: number;
    healthy: boolean;
    presentFamilies: string[];
  } {
    const requiredFamilies = [
      'validation.live_proof_scorecard',
      'validation.retention_report',
      'validation.regime_performance_report',
      'learning.live_proof_review',
    ];

    const seen = new Set(
      (events ?? [])
        .map((event) =>
          event && typeof event === 'object' && 'eventType' in (event as Record<string, unknown>)
            ? String((event as Record<string, unknown>).eventType)
            : '',
        )
        .filter((value) => value.length > 0),
    );

    const presentFamilies = requiredFamilies.filter((family) => seen.has(family));
    const coverage =
      requiredFamilies.length > 0 ? presentFamilies.length / requiredFamilies.length : 0;
    return {
      coverage,
      healthy: coverage >= 0.75,
      presentFamilies,
    };
  }
}
