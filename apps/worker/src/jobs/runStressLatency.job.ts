import { AppLogger } from '@worker/common/logger';

export class RunStressLatencyJob {
  private readonly logger = new AppLogger('RunStressLatencyJob');

  async run(): Promise<void> {
    this.logger.debug('Latency stress test job executed.');
  }
}