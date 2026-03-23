import { Injectable } from '@nestjs/common';
import { PrismaService } from '@api/modules/prisma/prisma.service';

@Injectable()
export class SignalsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany() {
    return this.prisma.signal.findMany({
      orderBy: {
        observedAt: 'desc',
      },
    });
  }

  async findById(signalId: string) {
    return this.prisma.signal.findUnique({
      where: { id: signalId },
    });
  }

  async findDecisionsBySignalId(signalId: string) {
    return this.prisma.signalDecision.findMany({
      where: { signalId },
      orderBy: {
        decisionAt: 'desc',
      },
    });
  }
}