import { Injectable } from '@nestjs/common';
import { PrismaService } from '@api/modules/prisma/prisma.service';

@Injectable()
export class PortfolioRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findLatestSnapshot() {
    return this.prisma.portfolioSnapshot.findFirst({
      orderBy: {
        capturedAt: 'desc',
      },
    });
  }

  async findManySnapshots() {
    return this.prisma.portfolioSnapshot.findMany({
      orderBy: {
        capturedAt: 'desc',
      },
    });
  }
}
