import { PrismaClient } from '@prisma/client';
import { loadLatestLifecycleValidationEvidence } from '@worker/validation/live-order-lifecycle-validation';
import { DecisionReplayContext } from './decision-replay-context';

export class ReplayEngine {
  private readonly decisionReplayContext: DecisionReplayContext;

  constructor(private readonly prisma: PrismaClient) {
    this.decisionReplayContext = new DecisionReplayContext(prisma);
  }

  async replaySignal(signalId: string) {
    const lifecycleSuite = loadLatestLifecycleValidationEvidence();
    const signal = await (this.prisma as any).signal.findUnique({
      where: { id: signalId },
    });
    const [decisions, orders, auditEvents, fills] = await Promise.all([
      (this.prisma as any).signalDecision.findMany({
        where: { signalId },
        orderBy: { decisionAt: 'asc' },
      }),
      this.prisma.order.findMany({
        where: { signalId },
        orderBy: { createdAt: 'asc' },
      }),
      (this.prisma as any).auditEvent.findMany({
        where: { signalId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.fill.findMany({
        where: {
          order: {
            signalId,
          },
        },
        orderBy: { filledAt: 'asc' },
      }),
    ]);

    const lifecycleEvidence = auditEvents.filter((event: { eventType?: string | null }) =>
      (event.eventType ?? '').startsWith('lifecycle.validation_'),
    );
    const parserFailures = auditEvents.filter((event: { eventType?: string | null }) =>
      (event.eventType ?? '').startsWith('venue.parser_failure'),
    );
    const decisionReplay = await this.decisionReplayContext.reconstructLatestForSignal(signalId);

    return {
      signal,
      decisions,
      orders,
      fills,
      auditEvents,
      lifecycleEvidence,
      parserFailures,
      lifecycleSuite,
      latestLifecycleValidation:
        lifecycleSuite?.scenarios[lifecycleSuite.scenarios.length - 1] ??
        (lifecycleEvidence.length > 0
          ? lifecycleEvidence[lifecycleEvidence.length - 1]?.metadata ?? null
          : null),
      decisionReplay,
      reconstructable:
        !!signal &&
        decisions.length > 0 &&
        auditEvents.some((event: { eventType?: string | null }) =>
          (event.eventType ?? '').includes('signal.admission_decision'),
        ) &&
        !!decisionReplay?.reconstructable,
      generatedAt: new Date().toISOString(),
    };
  }
}
