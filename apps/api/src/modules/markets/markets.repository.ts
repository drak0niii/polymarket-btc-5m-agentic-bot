import { Injectable } from '@nestjs/common';
import { PrismaService } from '@api/modules/prisma/prisma.service';

@Injectable()
export class MarketsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany() {
    return this.prisma.market.findMany({
      orderBy: {
        updatedAt: 'desc',
      },
    });
  }

  async findById(marketId: string) {
    return this.prisma.market.findUnique({
      where: { id: marketId },
    });
  }

  async findLatestOrderbookByMarketId(marketId: string) {
    return this.prisma.orderbook.findFirst({
      where: { marketId },
      orderBy: {
        observedAt: 'desc',
      },
    });
  }
}