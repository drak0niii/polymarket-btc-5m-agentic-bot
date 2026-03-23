import { PrismaClient } from '@prisma/client';

export type PersistedIntentStatus =
  | 'prepared'
  | 'submitted'
  | 'unknown_visibility'
  | 'terminal'
  | 'blocked';

export interface PersistedOrderIntentRecord {
  intentId: string;
  status: PersistedIntentStatus;
  orderId: string | null;
  venueOrderId: string | null;
  clientOrderId: string | null;
  signalId: string | null;
  marketId: string | null;
  tokenId: string | null;
  fingerprint: string;
  attempts: number;
  updatedAt: string;
}

export class OrderIntentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private statusPriority(status: PersistedIntentStatus): number {
    switch (status) {
      case 'terminal':
        return 4;
      case 'submitted':
        return 3;
      case 'unknown_visibility':
        return 2;
      case 'blocked':
        return 1;
      case 'prepared':
      default:
        return 0;
    }
  }

  async record(input: {
    intentId: string;
    status: PersistedIntentStatus;
    fingerprint: string;
    orderId?: string | null;
    venueOrderId?: string | null;
    clientOrderId?: string | null;
    signalId?: string | null;
    marketId?: string | null;
    tokenId?: string | null;
    attempts?: number;
    details?: Record<string, unknown>;
  }): Promise<void> {
    const prismaAny = this.prisma as any;
    await prismaAny.reconciliationCheckpoint?.create?.({
      data: {
        cycleKey: input.intentId,
        source: 'order_intent',
        status: input.status,
        details: {
          intentId: input.intentId,
          fingerprint: input.fingerprint,
          orderId: input.orderId ?? null,
          venueOrderId: input.venueOrderId ?? null,
          clientOrderId: input.clientOrderId ?? null,
          signalId: input.signalId ?? null,
          marketId: input.marketId ?? null,
          tokenId: input.tokenId ?? null,
          attempts: input.attempts ?? 0,
          ...(input.details ?? {}),
        },
        processedAt: new Date(),
      },
    });
  }

  async loadLatest(intentId: string): Promise<PersistedOrderIntentRecord | null> {
    const prismaAny = this.prisma as any;
    const latest = await prismaAny.reconciliationCheckpoint?.findFirst?.({
      where: {
        source: 'order_intent',
        cycleKey: intentId,
      },
      orderBy: { processedAt: 'desc' },
    });
    if (!latest) {
      return null;
    }
    const details = latest.details && typeof latest.details === 'object'
      ? (latest.details as Record<string, unknown>)
      : {};
    return {
      intentId,
      status: latest.status as PersistedIntentStatus,
      orderId: typeof details.orderId === 'string' ? details.orderId : null,
      venueOrderId: typeof details.venueOrderId === 'string' ? details.venueOrderId : null,
      clientOrderId:
        typeof details.clientOrderId === 'string' ? details.clientOrderId : null,
      signalId: typeof details.signalId === 'string' ? details.signalId : null,
      marketId: typeof details.marketId === 'string' ? details.marketId : null,
      tokenId: typeof details.tokenId === 'string' ? details.tokenId : null,
      fingerprint: typeof details.fingerprint === 'string' ? details.fingerprint : '',
      attempts: typeof details.attempts === 'number' ? details.attempts : 0,
      updatedAt: latest.processedAt.toISOString(),
    };
  }

  async loadBlockingUnknownIntents(): Promise<PersistedOrderIntentRecord[]> {
    const prismaAny = this.prisma as any;
    const rows = (await prismaAny.reconciliationCheckpoint?.findMany?.({
      where: {
        source: 'order_intent',
      },
      orderBy: { processedAt: 'desc' },
      take: 200,
    })) ?? [];
    const deduped = new Map<string, PersistedOrderIntentRecord>();
    for (const row of rows) {
      const existing = deduped.get(row.cycleKey);
      const details = row.details && typeof row.details === 'object'
        ? (row.details as Record<string, unknown>)
        : {};
      const candidate = {
        intentId: row.cycleKey,
        status: row.status as PersistedIntentStatus,
        orderId: typeof details.orderId === 'string' ? details.orderId : null,
        venueOrderId: typeof details.venueOrderId === 'string' ? details.venueOrderId : null,
        clientOrderId:
          typeof details.clientOrderId === 'string' ? details.clientOrderId : null,
        signalId: typeof details.signalId === 'string' ? details.signalId : null,
        marketId: typeof details.marketId === 'string' ? details.marketId : null,
        tokenId: typeof details.tokenId === 'string' ? details.tokenId : null,
        fingerprint: typeof details.fingerprint === 'string' ? details.fingerprint : '',
        attempts: typeof details.attempts === 'number' ? details.attempts : 0,
        updatedAt: row.processedAt.toISOString(),
      };
      if (existing) {
        const existingAt = new Date(existing.updatedAt).getTime();
        const candidateAt = row.processedAt.getTime();
        if (
          candidateAt < existingAt ||
          (candidateAt === existingAt &&
            this.statusPriority(candidate.status) <= this.statusPriority(existing.status))
        ) {
          continue;
        }
      }
      deduped.set(row.cycleKey, candidate);
    }
    return [...deduped.values()].filter((intent) =>
      ['prepared', 'unknown_visibility', 'blocked'].includes(intent.status),
    );
  }
}
