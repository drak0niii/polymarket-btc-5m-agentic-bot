import { Injectable } from '@nestjs/common';
import { PrismaService } from '@api/modules/prisma/prisma.service';

interface CreateAuditEventParams {
  eventType: string;
  message: string;
  marketId?: string;
  signalId?: string;
  orderId?: string;
  metadata: Record<string, unknown>;
}

@Injectable()
export class AuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany() {
    return this.prisma.auditEvent.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async create(params: CreateAuditEventParams) {
    return this.prisma.auditEvent.create({
      data: {
        eventType: params.eventType,
        message: params.message,
        marketId: params.marketId,
        signalId: params.signalId,
        orderId: params.orderId,
        metadata: params.metadata as object,
      },
    });
  }
}