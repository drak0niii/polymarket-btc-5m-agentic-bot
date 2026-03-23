import { Controller, Get, Param } from '@nestjs/common';
import { OrdersService } from './orders.service';

@Controller({
  path: 'orders',
  version: '1',
})
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  async listOrders() {
    return this.ordersService.listOrders();
  }

  @Get(':orderId')
  async getOrder(@Param('orderId') orderId: string) {
    return this.ordersService.getOrderById(orderId);
  }

  @Get(':orderId/fills')
  async getOrderFills(@Param('orderId') orderId: string) {
    return this.ordersService.getFillsByOrderId(orderId);
  }
}