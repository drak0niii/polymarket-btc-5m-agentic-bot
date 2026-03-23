import { BotRuntimeState } from '@worker/runtime/bot-state';
import { ExecuteOrdersJob } from '@worker/jobs/executeOrders.job';
import { ManageOpenOrdersJob } from '@worker/jobs/manageOpenOrders.job';
import { ReconcileFillsJob } from '@worker/jobs/reconcileFills.job';
import { RefreshPortfolioJob } from '@worker/jobs/refreshPortfolio.job';

export interface ExecutionAuthorityInput {
  marketAuthorityPassed?: boolean;
  riskAuthorityPassed?: boolean;
  marketAuthorityReason?: string | null;
  riskAuthorityReason?: string | null;
}

export interface ExecutionAuthorityResult {
  passed: boolean;
  reasonCode: string | null;
}

export class ExecutionPortfolioAgent {
  constructor(
    private readonly executeOrdersJob: ExecuteOrdersJob,
    private readonly manageOpenOrdersJob: ManageOpenOrdersJob,
    private readonly reconcileFillsJob: ReconcileFillsJob,
    private readonly refreshPortfolioJob: RefreshPortfolioJob,
  ) {}

  async runExecution(options?: {
    canSubmit?: () => boolean;
    runtimeState?: BotRuntimeState;
    authority?: ExecutionAuthorityInput;
  }): Promise<{
    submitted: number;
    rejected: number;
    blockedByAuthority?: boolean;
    blockReason?: string | null;
  }> {
    const authorityVerdict = this.evaluateExecutionAuthority(options?.authority);
    if (!authorityVerdict.passed) {
      return {
        submitted: 0,
        rejected: 0,
        blockedByAuthority: true,
        blockReason: authorityVerdict.reasonCode,
      };
    }

    return this.executeOrdersJob.run({
      canSubmit: options?.canSubmit,
      runtimeState: options?.runtimeState,
    });
  }

  async runReconciliation(options?: {
    forceCancelAll?: boolean;
    runtimeState?: BotRuntimeState;
  }): Promise<{
    canceled: number;
    observed: number;
    syncFailed: boolean;
    fillsInserted: number;
  }> {
    const orderManagement = await this.manageOpenOrdersJob.run({
      forceCancelAll: options?.forceCancelAll ?? false,
      runtimeState: options?.runtimeState,
    });
    const fillReconciliation = await this.reconcileFillsJob.run({
      runtimeState: options?.runtimeState,
    });

    return {
      canceled: orderManagement.canceled,
      observed: orderManagement.observed,
      syncFailed: orderManagement.syncFailed || fillReconciliation.syncFailed,
      fillsInserted: fillReconciliation.fillsInserted,
    };
  }

  async runPortfolioRefresh(options?: {
    runtimeState?: BotRuntimeState;
  }): Promise<{ snapshotId: string | null }> {
    return this.refreshPortfolioJob.run({
      runtimeState: options?.runtimeState,
    });
  }

  private evaluateExecutionAuthority(
    input: ExecutionAuthorityInput | undefined,
  ): ExecutionAuthorityResult {
    if (input?.marketAuthorityPassed === false) {
      return {
        passed: false,
        reasonCode: input.marketAuthorityReason ?? 'market_authority_veto',
      };
    }
    if (input?.riskAuthorityPassed === false) {
      return {
        passed: false,
        reasonCode: input.riskAuthorityReason ?? 'risk_authority_veto',
      };
    }

    return {
      passed: true,
      reasonCode: null,
    };
  }
}
