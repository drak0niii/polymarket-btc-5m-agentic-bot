import assert from 'assert';
import { ExecutionStateWatchdog } from '../runtime/execution-state-watchdog';

async function testExecutionWatchdogTransitionsAcrossSeverityBands(): Promise<void> {
  const watchdog = new ExecutionStateWatchdog();

  const calm = await watchdog.evaluate({
    currentState: 'running',
    anomalyInput: {
      userStream: {
        stale: false,
        liveOrdersWhileStale: false,
        connected: true,
        reconnectAttempt: 0,
        openOrders: 0,
        lastTrafficAgeMs: 100,
        divergenceDetected: false,
      },
      venueTruth: {
        disagreementCount: 0,
        unresolvedGhostMismatch: false,
        lastVenueTruthAgeMs: 100,
        workingOpenOrders: 0,
        cancelPendingTooLongCount: 0,
      },
      lifecycle: {
        retryingCount: 0,
        failedCount: 0,
        ghostExposureDetected: false,
        unresolvedIntentCount: 0,
        locallyFilledButAbsentCount: 0,
        oldestLocallyFilledAbsentAgeMs: null,
      },
    },
  });
  const reconciliationOnly = await watchdog.evaluate({
    currentState: 'running',
    anomalyInput: {
      userStream: {
        stale: true,
        liveOrdersWhileStale: true,
        connected: true,
        reconnectAttempt: 0,
        openOrders: 1,
        lastTrafficAgeMs: 4_000,
        divergenceDetected: false,
      },
      venueTruth: {
        disagreementCount: 0,
        unresolvedGhostMismatch: false,
        lastVenueTruthAgeMs: 1_000,
        workingOpenOrders: 1,
        cancelPendingTooLongCount: 0,
      },
      lifecycle: {
        retryingCount: 0,
        failedCount: 0,
        ghostExposureDetected: false,
        unresolvedIntentCount: 0,
        locallyFilledButAbsentCount: 0,
        oldestLocallyFilledAbsentAgeMs: null,
      },
    },
  });
  const cancelOnly = await watchdog.evaluate({
    currentState: 'running',
    anomalyInput: {
      userStream: {
        stale: false,
        liveOrdersWhileStale: false,
        connected: true,
        reconnectAttempt: 0,
        openOrders: 2,
        lastTrafficAgeMs: 500,
        divergenceDetected: true,
      },
      venueTruth: {
        disagreementCount: 3,
        unresolvedGhostMismatch: true,
        lastVenueTruthAgeMs: 5_000,
        workingOpenOrders: 2,
        cancelPendingTooLongCount: 2,
      },
      lifecycle: {
        retryingCount: 0,
        failedCount: 0,
        ghostExposureDetected: false,
        unresolvedIntentCount: 0,
        locallyFilledButAbsentCount: 0,
        oldestLocallyFilledAbsentAgeMs: null,
      },
    },
  });

  assert.strictEqual(calm.transitionRequest, null);
  assert.strictEqual(reconciliationOnly.transitionRequest?.nextState, 'reconciliation_only');
  assert.strictEqual(cancelOnly.transitionRequest?.nextState, 'cancel_only');
  assert.strictEqual(cancelOnly.forceCancelOnlyBehavior, true);
}

export const phaseTenExecutionWatchdogTests = [
  {
    name: 'phase10 watchdog moves runtime to reconciliation_only and cancel_only correctly',
    fn: testExecutionWatchdogTransitionsAcrossSeverityBands,
  },
];
