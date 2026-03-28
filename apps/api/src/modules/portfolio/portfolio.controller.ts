import { Controller, Get } from '@nestjs/common';
import { PortfolioService } from './portfolio.service';

@Controller({
  path: 'portfolio',
  version: '1',
})
export class PortfolioController {
  constructor(private readonly portfolioService: PortfolioService) {}

  @Get()
  async getLatestPortfolio() {
    return this.portfolioService.getLatestPortfolioSummary();
  }

  @Get('snapshots')
  async listPortfolioSnapshots() {
    return this.portfolioService.listSnapshots();
  }
}
