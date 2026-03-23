import { Injectable } from '@nestjs/common';
import { PrismaService } from '@api/modules/prisma/prisma.service';

@Injectable()
export class OrdersRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany() {
    return this.prisma.order.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findById(orderId: string) {
    return this.prisma.order.findUnique({
      where: { id: orderId },
    });
  }

  async findFillsByOrderId(orderId: string) {
    return this.prisma.fill.findMany({
      where: { orderId },
      orderBy: {
        filledAt: 'desc',
      },
    });
  }
}
