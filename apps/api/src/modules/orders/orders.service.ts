import { Injectable } from '@nestjs/common';
import { NotFoundError } from '@api/common/errors';
import { OrdersRepository } from './orders.repository';

@Injectable()
export class OrdersService {
  constructor(private readonly ordersRepository: OrdersRepository) {}

  async listOrders() {
    return this.ordersRepository.findMany();
  }

  async getOrderById(orderId: string) {
    const order = await this.ordersRepository.findById(orderId);

    if (!order) {
      throw new NotFoundError(`Order ${orderId} was not found.`);
    }

    return order;
  }

  async getFillsByOrderId(orderId: string) {
    const order = await this.ordersRepository.findById(orderId);

    if (!order) {
      throw new NotFoundError(`Order ${orderId} was not found.`);
    }

    return this.ordersRepository.findFillsByOrderId(orderId);
  }
}