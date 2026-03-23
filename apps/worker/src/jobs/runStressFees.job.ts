import { AppLogger } from '@worker/common/logger';

export class RunStressFeesJob {
  private readonly logger = new AppLogger('RunStressFeesJob');

  async run(): Promise<void> {
    this.logger.debug('Fee stress test job executed.');
  }
}