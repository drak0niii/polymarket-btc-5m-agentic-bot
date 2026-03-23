export interface OrderRouterInput {
  orderType: 'GTC' | 'FOK' | 'FAK' | 'GTD';
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
}

export interface OrderRouterResult {
  route: 'maker' | 'taker';
  orderType: 'GTC' | 'FOK' | 'FAK' | 'GTD';
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  routedAt: string;
}

export class OrderRouter {
  route(input: OrderRouterInput): OrderRouterResult {
    return {
      route:
        input.orderType === 'FOK' || input.orderType === 'FAK' ? 'taker' : 'maker',
      orderType: input.orderType,
      side: input.side,
      price: input.price,
      size: input.size,
      routedAt: new Date().toISOString(),
    };
  }
}
