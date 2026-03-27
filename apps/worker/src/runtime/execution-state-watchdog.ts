import { AppLogger } from '@worker/common/logger';
import type { RuntimeControlRepository } from './runtime-control.repository';
import {
  type BotRuntimeState,
  type RuntimeTransitionRequest,
  buildRuntimeTransitionRequest,
} from './runtime-state-machine';
import {
  ExecutionStateAnomalyDetector,
  type ExecutionStateAnomalyDetectorInput,
  type ExecutionStateAnomalyDetectorResult,
} from '@polymarket-btc-5m-agentic-bot/risk-engine';

export interface ExecutionStateWatchdogDecision
  extends ExecutionStateAnomalyDetectorResult {
  transitionRequest: RuntimeTransitionRequest | null;
  degradeOrderPersistence: boolean;
  avoidBlindReposts: boolean;
  forceCancelOnlyBehavior: boolean;
}

export class ExecutionStateWatchdog {
  private readonly logger = new AppLogger('ExecutionStateWatchdog');
  private readonly detector = new ExecutionStateAnomalyDetector();

  constructor(
    private readonly runtimeControl?: Pick<
      RuntimeControlRepository,
      'recordReconciliationCheckpoint'
    >,
  ) {}

  async evaluate(input: {
    currentState: BotRuntimeState;
    anomalyInput: ExecutionStateAnomalyDetectorInput;
    now?: Date;
  }): Promise<ExecutionStateWatchdogDecision> {
    const now = input.now ?? new Date();
    const anomalyResult = this.detector.evaluate(input.anomalyInput);
    const transitionRequest =
      anomalyResult.recommendedRuntimeState === 'running'
        ? null
        : buildRuntimeTransitionRequest({
            currentState: input.currentState,
            nextState: anomalyResult.recommendedRuntimeState,
            family: 'execution_anomaly',
            reasonCode:
              anomalyResult.reasonCodes[0] ?? 'execution_state_watchdog_degraded',
            rationale: anomalyResult.reasonCodes,
            requestedAt: now.toISOString(),
          });

    if (transitionRequest && this.runtimeControl) {
      await this.runtimeControl.recordReconciliationCheckpoint({
        cycleKey: `execution-state-watchdog:${now.getTime()}`,
        source: 'execution_state_watchdog',
        status: 'transition_requested',
        details: {
          transitionRequest,
          anomalies: anomalyResult.anomalies,
          reasonCodes: anomalyResult.reasonCodes,
          degradeOrderPersistence:
            anomalyResult.recommendedRuntimeState === 'reconciliation_only' ||
            anomalyResult.recommendedRuntimeState === 'cancel_only' ||
            anomalyResult.recommendedRuntimeState === 'halted_hard',
          avoidBlindReposts:
            anomalyResult.reasonCodes.includes('repeated_retry_fail_states') ||
            anomalyResult.reasonCodes.includes('cancel_acknowledgment_missing_too_long') ||
            anomalyResult.reasonCodes.includes('venue_open_orders_disagree_with_local_view'),
          forceCancelOnlyBehavior:
            anomalyResult.recommendedRuntimeState === 'cancel_only' ||
            anomalyResult.recommendedRuntimeState === 'halted_hard',
        },
      });
      this.logger.warn('Execution-state watchdog requested runtime transition.', {
        transitionRequest,
        anomalyCount: anomalyResult.anomalies.length,
      });
    }

    return {
      ...anomalyResult,
      transitionRequest,
      degradeOrderPersistence:
        anomalyResult.recommendedRuntimeState === 'reconciliation_only' ||
        anomalyResult.recommendedRuntimeState === 'cancel_only' ||
        anomalyResult.recommendedRuntimeState === 'halted_hard',
      avoidBlindReposts:
        anomalyResult.reasonCodes.includes('repeated_retry_fail_states') ||
        anomalyResult.reasonCodes.includes('cancel_acknowledgment_missing_too_long') ||
        anomalyResult.reasonCodes.includes('venue_open_orders_disagree_with_local_view'),
      forceCancelOnlyBehavior:
        anomalyResult.recommendedRuntimeState === 'cancel_only' ||
        anomalyResult.recommendedRuntimeState === 'halted_hard',
    };
  }
}
