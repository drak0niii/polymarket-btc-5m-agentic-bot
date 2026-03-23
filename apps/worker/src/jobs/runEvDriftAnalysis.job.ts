import { AppLogger } from '@worker/common/logger';

export class RunEvDriftAnalysisJob {
  private readonly logger = new AppLogger('RunEvDriftAnalysisJob');

  async run(): Promise<void> {
    this.logger.debug('EV drift analysis job executed.');
  }
}