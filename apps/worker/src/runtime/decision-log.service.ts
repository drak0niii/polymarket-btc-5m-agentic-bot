import { PrismaClient } from '@prisma/client';
import type { AuditDecisionLog } from '@polymarket-btc-5m-agentic-bot/domain';

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

  summarizeAuditCoverage(events: unknown[]): {
    coverage: number;
    healthy: boolean;
  } {
    const requiredFamilies = [
      'signal.edge_assessed',
      'signal.admission_decision',
      'signal.execution_decision',
      'trade.post_trade_attribution',
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
}
