import { AppLogger } from '@worker/common/logger';

export class RunStressOrderbookJob {
  private readonly logger = new AppLogger('RunStressOrderbookJob');

  async run(): Promise<void> {
    this.logger.debug('Orderbook stress test job executed.');
  }
}