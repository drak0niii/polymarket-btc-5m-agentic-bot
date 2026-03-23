import { Injectable } from '@nestjs/common';
import { NotFoundError } from '@api/common/errors';
import { PortfolioRepository } from './portfolio.repository';

@Injectable()
export class PortfolioService {
  constructor(private readonly portfolioRepository: PortfolioRepository) {}

  async getLatestPortfolio() {
    const snapshot = await this.portfolioRepository.findLatestSnapshot();

    if (!snapshot) {
      throw new NotFoundError('No portfolio snapshot was found.');
    }

    return snapshot;
  }

  async listSnapshots() {
    return this.portfolioRepository.findManySnapshots();
  }
}