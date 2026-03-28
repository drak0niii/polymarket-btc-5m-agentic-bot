import { AppLogger } from '@worker/common/logger';
import { type TradingOperatingMode } from '@polymarket-btc-5m-agentic-bot/domain';
import { BotStateStore } from './bot-state';
import { StartupGateService } from './startup-gate.service';

export class StartStopManager {
  private readonly logger = new AppLogger('StartStopManager');

  constructor(
    private readonly stateStore: BotStateStore,
    private readonly startupGateService?:
      | Pick<StartupGateService, 'assertLiveStartupAllowed' | 'assertStartupAllowedForMode'>
      | {
          preflightVenue?: () => Promise<{ ready: boolean; reasonCode?: string | null }>;
        },
  ) {}

  async start(
    reason: string,
    operatingMode: TradingOperatingMode = 'live_trading',
  ): Promise<void> {
    const current = this.stateStore.getState();
    if (current !== 'stopped' && current !== 'halted_hard') {
      throw new Error(
        `Bot can only start from "stopped" or "halted_hard". Current state: ${current}`,
      );
    }

    this.stateStore.setState('bootstrapping', reason);
    this.logger.log('Bot runtime entered bootstrapping state.', {
      botState: this.stateStore.getState(),
    });

    try {
      await this.assertReadiness(operatingMode);
    } catch (error) {
      this.stateStore.setState('stopped', 'startup readiness failed');
      throw error;
    }
  }

  enterRunning(reason: string): void {
    this.stateStore.setState('running', reason);
    this.logger.log('Bot runtime entered running state.', {
      botState: this.stateStore.getState(),
    });
  }

  enterDegraded(reason: string): void {
    this.stateStore.setState('degraded', reason);
    this.logger.warn('Bot runtime entered degraded state.', {
      botState: this.stateStore.getState(),
    });
  }

  enterReconciliationOnly(reason: string): void {
    this.stateStore.setState('reconciliation_only', reason);
    this.logger.warn('Bot runtime entered reconciliation-only state.', {
      botState: this.stateStore.getState(),
    });
  }

  enterCancelOnly(reason: string): void {
    this.stateStore.setState('cancel_only', reason);
    this.logger.warn('Bot runtime entered cancel-only state.', {
      botState: this.stateStore.getState(),
    });
  }

  stop(reason: string): void {
    const current = this.stateStore.getState();
    if (current === 'stopped') {
      return;
    }

    this.stateStore.setState('cancel_only', reason);
    this.logger.warn('Bot runtime entering cancel-only state for stop.', {
      botState: this.stateStore.getState(),
      previousState: current,
    });
  }

  completeStop(reason = 'runtime stopped cleanly'): void {
    this.stateStore.setState('stopped', reason);
    this.logger.warn('Bot runtime entered stopped state.', {
      botState: this.stateStore.getState(),
    });
  }

  halt(reason: string): void {
    this.stateStore.setState('halted_hard', reason);
    this.logger.error('Bot runtime entered halted_hard state.', undefined, {
      botState: this.stateStore.getState(),
    });
  }

  async assertReadiness(
    operatingMode: TradingOperatingMode = 'live_trading',
  ): Promise<void> {
    if (!this.startupGateService) {
      return;
    }

    try {
      if (
        'assertStartupAllowedForMode' in this.startupGateService &&
        typeof this.startupGateService.assertStartupAllowedForMode === 'function'
      ) {
        await this.startupGateService.assertStartupAllowedForMode(operatingMode);
        return;
      }

      if ('assertLiveStartupAllowed' in this.startupGateService) {
        await this.startupGateService.assertLiveStartupAllowed();
        return;
      }

      const verdict = await this.startupGateService.preflightVenue?.();
      if (verdict && verdict.ready === false) {
        throw new Error(verdict.reasonCode ?? 'startup_preflight_failed');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const prefix =
        'assertLiveStartupAllowed' in this.startupGateService
          ? 'startup readiness'
          : 'venue preflight';
      throw new Error(`${prefix} ${message}`);
    }
  }
}
