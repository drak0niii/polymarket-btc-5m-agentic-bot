import { AppLogger } from '@worker/common/logger';

export class RunStressRegimesJob {
  private readonly logger = new AppLogger('RunStressRegimesJob');

  async run(): Promise<void> {
    this.logger.debug('Regime stress test job executed.');
  }
}