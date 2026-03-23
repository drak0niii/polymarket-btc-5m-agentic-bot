import { AppLogger } from '@worker/common/logger';

export class RunStressResolutionWindowJob {
  private readonly logger = new AppLogger('RunStressResolutionWindowJob');

  async run(): Promise<void> {
    this.logger.debug('Resolution-window stress test job executed.');
  }
}