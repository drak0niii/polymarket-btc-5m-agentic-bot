import { Injectable } from '@nestjs/common';
import { NotFoundError } from '@api/common/errors';
import { MarketsRepository } from './markets.repository';

@Injectable()
export class MarketsService {
  constructor(private readonly marketsRepository: MarketsRepository) {}

  async listMarkets() {
    return this.marketsRepository.findMany();
  }

  async getMarketById(marketId: string) {
    const market = await this.marketsRepository.findById(marketId);

    if (!market) {
      throw new NotFoundError(`Market ${marketId} was not found.`);
    }

    return market;
  }

  async getLatestOrderbook(marketId: string) {
    const market = await this.marketsRepository.findById(marketId);

    if (!market) {
      throw new NotFoundError(`Market ${marketId} was not found.`);
    }

    return this.marketsRepository.findLatestOrderbookByMarketId(marketId);
  }
}