import { AppLogger } from '@worker/common/logger';

export class RunStressRiskOfRuinJob {
  private readonly logger = new AppLogger('RunStressRiskOfRuinJob');

  async run(): Promise<void> {
    this.logger.debug('Risk-of-ruin stress test job executed.');
  }
}