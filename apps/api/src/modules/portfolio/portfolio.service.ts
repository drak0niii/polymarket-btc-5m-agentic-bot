import { Injectable } from '@nestjs/common';
import { NotFoundError } from '@api/common/errors';
import { PortfolioRepository } from './portfolio.repository';

export interface PortfolioSnapshotSummary {
  status: 'ready' | 'missing';
  message: string | null;
  snapshot: Awaited<ReturnType<PortfolioRepository['findLatestSnapshot']>>;
}

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

  async getLatestPortfolioSummary(): Promise<PortfolioSnapshotSummary> {
    const snapshot = await this.portfolioRepository.findLatestSnapshot();

    if (!snapshot) {
      return {
        status: 'missing',
        message: 'No portfolio snapshot has been recorded yet.',
        snapshot: null,
      };
    }

    return {
      status: 'ready',
      message: null,
      snapshot,
    };
  }

  async listSnapshots() {
    return this.portfolioRepository.findManySnapshots();
  }
}
