import { Controller, Get, Param } from '@nestjs/common';
import { MarketsService } from './markets.service';

@Controller({
  path: 'markets',
  version: '1',
})
export class MarketsController {
  constructor(private readonly marketsService: MarketsService) {}

  @Get()
  async listMarkets() {
    return this.marketsService.listMarkets();
  }

  @Get(':marketId')
  async getMarket(@Param('marketId') marketId: string) {
    return this.marketsService.getMarketById(marketId);
  }

  @Get(':marketId/orderbook')
  async getMarketOrderbook(@Param('marketId') marketId: string) {
    return this.marketsService.getLatestOrderbook(marketId);
  }
}