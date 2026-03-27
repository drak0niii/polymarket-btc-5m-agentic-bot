import assert from 'assert';
import {
  FillStateService,
} from '@polymarket-btc-5m-agentic-bot/execution-engine';
import {
  ExecutionStateAnomalyDetector,
  PortfolioKillSwitchService,
} from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { appEnv } from '../config/env';
import { ManageOpenOrdersJob } from '../jobs/manageOpenOrders.job';
import { ExecutionStateWatchdog } from '../runtime/execution-state-watchdog';
import { probeExecutionStateWatchdogDegradation } from '../smoke/production-readiness';

async function testExecutionStateAnomalyDetectorReasonCodesAndSeverity(): Promise<void> {
  const detector = new ExecutionStateAnomalyDetector();
  const result = detector.evaluate({
    userStream: {
      stale: true,
      liveOrdersWhileStale: true,
      connected: false,
      reconnectAttempt: 2,
      openOrders: 2,
      lastTrafficAgeMs: 12_000,
      divergenceDetected: false,
    },
    venueTruth: {
      disagreementCount: 3,
      unresolvedGhostMismatch: true,
      lastVenueTruthAgeMs: 8_000,
      workingOpenOrders: 2,
      cancelPendingTooLongCount: 2,
    },
    lifecycle: {
      retryingCount: 2,
      failedCount: 1,
      ghostExposureDetected: true,
      unresolvedIntentCount: 1,
      locallyFilledButAbsentCount: 2,
      oldestLocallyFilledAbsentAgeMs: 45_000,
    },
  });

  assert.strictEqual(result.reasonCodes.includes('user_stream_stale_with_live_orders'), true);
  assert.strictEqual(
    result.reasonCodes.includes('venue_open_orders_disagree_with_local_view'),
    true,
  );
  assert.strictEqual(result.reasonCodes.includes('cancel_acknowledgment_missing_too_long'), true);
  assert.strictEqual(result.reasonCodes.includes('ghost_exposure_after_reconnect'), true);
  assert.strictEqual(
    result.reasonCodes.includes('locally_filled_absent_from_venue_truth'),
    true,
  );
  assert.strictEqual(result.highestSeverity, 'critical');
  assert.strictEqual(result.recommendedRuntimeState, 'halted_hard');
}

async function testExecutionStateWatchdogRequestsRuntimeTransition(): Promise<void> {
  const checkpoints: Array<Record<string, unknown>> = [];
  const watchdog = new ExecutionStateWatchdog({
    recordReconciliationCheckpoint: async (input) => {
      checkpoints.push(input as unknown as Record<string, unknown>);
    },
  });

  const result = await watchdog.evaluate({
    currentState: 'running',
    anomalyInput: {
      userStream: {
        stale: true,
        liveOrdersWhileStale: true,
        connected: true,
        reconnectAttempt: 1,
        openOrders: 1,
        lastTrafficAgeMs: 5_000,
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

  assert.strictEqual(result.transitionRequest?.nextState, 'reconciliation_only');
  assert.strictEqual(result.degradeOrderPersistence, true);
  assert.strictEqual(checkpoints.length, 1);
}

async function testFillStateServiceUsesGranularLifecycleTruth(): Promise<void> {
  const service = new FillStateService();
  const matched = service.applyFill({
    state: {
      intendedSize: 1,
      cumulativeFilledSize: 0,
      averageFillPrice: null,
      remainingSize: 1,
      cumulativeFees: 0,
      lastVisibleVenueState: 'working',
      lastUserStreamUpdateAt: null,
      lastRestConfirmationAt: null,
    },
    fillPrice: 0.52,
    fillSize: 1,
    fee: 0.01,
    venueState: 'MATCHED',
    observedAt: '2026-03-27T10:00:00.000Z',
  });
  const matchedAssessment = service.assessLifecycle({
    state: matched,
    orderStatus: 'filled',
    venueState: 'MATCHED',
    hasRestConfirmation: false,
  });

  const confirmed = service.applyFill({
    state: {
      intendedSize: 1,
      cumulativeFilledSize: 0,
      averageFillPrice: null,
      remainingSize: 1,
      cumulativeFees: 0,
      lastVisibleVenueState: 'working',
      lastUserStreamUpdateAt: null,
      lastRestConfirmationAt: null,
    },
    fillPrice: 0.52,
    fillSize: 1,
    fee: 0.01,
    venueState: 'CONFIRMED',
    observedAt: '2026-03-27T10:00:01.000Z',
    restConfirmed: true,
  });
  const confirmedAssessment = service.assessLifecycle({
    state: confirmed,
    orderStatus: 'filled',
    venueState: 'CONFIRMED',
    hasRestConfirmation: true,
  });

  assert.strictEqual(matched.lastRestConfirmationAt, null);
  assert.strictEqual(matchedAssessment.lifecycleState, 'confirmed');
  assert.strictEqual(matchedAssessment.economicallyFinalEnough, false);
  assert.strictEqual(confirmedAssessment.lifecycleState, 'economically_final_enough');
  assert.strictEqual(confirmedAssessment.economicallyFinalEnough, true);
}

async function testKillSwitchEscalatesFromExecutionAnomalies(): Promise<void> {
  const service = new PortfolioKillSwitchService();
  const result = service.evaluate({
    accountState: {
      source: 'canonical_account_state_v1',
      portfolioSnapshotId: 'portfolio-1',
      externalSnapshotId: 'external-1',
      bankroll: 1_000,
      grossCash: 1_000,
      availableCash: 800,
      reservedCash: 200,
      unresolvedBuyReservation: 0,
      workingBuyNotional: 0,
      workingSellQuantity: 0,
      deployableRiskNow: 100,
      openExposure: 0,
      openOrderExposure: 0,
      unrealizedPnl: 0,
      realizedPnlDay: 0,
      realizedPnlHour: 0,
      feesPaidDay: 0,
      rewardsPaidDay: 0,
      consecutiveLosses: 0,
      inventories: [],
      reservations: [],
      concentration: {
        largestMarketRatio: 0.1,
        largestMarketId: 'm1',
        largestMarketExposure: 100,
        largestTokenRatio: 0.1,
        largestTokenId: 'yes1',
        largestTokenExposure: 100,
      },
      freshness: {
        state: 'healthy',
        allowNewEntries: true,
        allowPositionManagement: true,
        reasonCodes: [],
        externalSnapshotHealthy: true,
        marketStreamHealthy: true,
        userStreamHealthy: true,
      },
      capturedAt: '2026-03-27T10:00:00.000Z',
    },
    diagnostics: [],
    venueInstability: {
      postFailureCount: 0,
      cancelFailureCount: 0,
      cancelFailuresWithWorkingOrders: 0,
      heartbeatFailuresWithOpenOrders: 0,
      divergenceStatus: 'none',
      staleBookRejectCount: 0,
      totalRecentDecisions: 10,
      abnormalCancelLatencyCount: 2,
      repeatedPartialFillToxicityCount: 0,
      fillQualityDriftCount: 0,
      realizedVsExpectedCostBlowoutCount: 2,
    },
    executionStateAnomalies: [
      {
        reasonCode: 'user_stream_stale_with_live_orders',
        severity: 'critical',
        severityScore: 95,
        recommendedRuntimeState: 'cancel_only',
        rationale: 'stream stale',
        evidence: {},
      },
    ],
  });

  assert.strictEqual(result.recommendedRuntimeState, 'cancel_only');
  assert.strictEqual(result.blockNewEntries, true);
  assert.strictEqual(result.runtimeReasonChain.includes('user_stream_stale_with_live_orders'), true);
}

async function testManageOpenOrdersAdaptsToWatchdogDirective(): Promise<void> {
  const originalLiveExecution = appEnv.BOT_LIVE_EXECUTION_ENABLED;
  (appEnv as { BOT_LIVE_EXECUTION_ENABLED: boolean }).BOT_LIVE_EXECUTION_ENABLED = true;
  const now = Date.now();
  const updates: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const canceledVenueOrders: string[] = [];
  const prisma = {
    order: {
      findMany: async () => [
        {
          id: 'order-1',
          venueOrderId: 'venue-1',
          marketId: 'market-1',
          tokenId: 'yes1',
          signalId: null,
          status: 'submitted',
          side: 'BUY',
          intent: 'ENTER',
          price: 0.5,
          size: 1,
          filledSize: 0,
          remainingSize: 1,
          createdAt: new Date(now - 1_000),
          lastVenueStatus: 'working',
        },
      ],
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return null;
      },
      count: async () => 1,
    },
    signal: {
      findUnique: async () => ({
        id: 'signal-1',
        observedAt: new Date(now - 2_000),
      }),
    },
    market: {
      findUnique: async () => ({
        id: 'market-1',
        slug: 'btc-up',
        title: 'BTC up?',
        status: 'active',
        tokenIdYes: 'yes1',
        tokenIdNo: 'no1',
        expiresAt: new Date(now + 60_000).toISOString(),
      }),
    },
    marketSnapshot: {
      findFirst: async () => ({
        marketId: 'market-1',
        observedAt: new Date(now - 500),
      }),
    },
    orderbook: {
      findFirst: async () => ({
        marketId: 'market-1',
        tokenId: 'yes1',
        observedAt: new Date(now - 500),
        bestBid: 0.49,
        bestAsk: 0.51,
        spread: 0.02,
        bids: [{ price: 0.49, size: 10 }],
        asks: [{ price: 0.51, size: 10 }],
      }),
    },
    auditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return null;
      },
    },
  };
  const runtimeControl = {
    getLatestCheckpoint: async () => ({
      status: 'transition_requested',
      processedAt: new Date(),
      details: {
        reasonCodes: ['cancel_acknowledgment_missing_too_long'],
        degradeOrderPersistence: true,
        avoidBlindReposts: true,
        forceCancelOnlyBehavior: true,
        transitionRequest: {
          nextState: 'cancel_only',
        },
      },
    }),
    recordReconciliationCheckpoint: async () => null,
  };
  const job = new ManageOpenOrdersJob(
    prisma as never,
    runtimeControl as never,
  ) as ManageOpenOrdersJob;
  (job as any).tradingClient = {
    getOpenOrders: async () => [
      {
        id: 'venue-1',
        venueOrderId: 'venue-1',
        status: 'LIVE',
        side: 'BUY',
        price: 0.5,
        size: 1,
        matchedSize: 0,
        tokenId: 'yes1',
      },
    ],
    getOrderScoring: async () => [],
    cancelOrder: async (orderId: string) => {
      canceledVenueOrders.push(orderId);
    },
  };

  try {
    await job.run();
  } finally {
    (appEnv as { BOT_LIVE_EXECUTION_ENABLED: boolean }).BOT_LIVE_EXECUTION_ENABLED =
      originalLiveExecution;
  }

  assert.strictEqual(canceledVenueOrders.includes('venue-1'), true);
  assert.strictEqual(updates.some((update) => update.lastError === 'cancel_request_pending_confirmation'), true);
  assert.strictEqual(
    audits.some((event) => {
      const metadata =
        event.metadata && typeof event.metadata === 'object'
          ? (event.metadata as Record<string, unknown>)
          : {};
      const watchdogDirective =
        metadata.watchdogDirective && typeof metadata.watchdogDirective === 'object'
          ? (metadata.watchdogDirective as Record<string, unknown>)
          : {};
      return watchdogDirective.forceCancelOnlyBehavior === true;
    }),
    true,
  );
}

async function testProductionReadinessCoversWatchdogDegradation(): Promise<void> {
  const checkpoints: Array<Record<string, unknown>> = [];
  const step = await probeExecutionStateWatchdogDegradation({
    runtimeControl: {
      recordReconciliationCheckpoint: async (input) => {
        checkpoints.push(input as unknown as Record<string, unknown>);
      },
    },
  });

  assert.strictEqual(step.ok, true);
  assert.strictEqual(step.name, 'execution_state_watchdog_degradation');
  assert.strictEqual(Array.isArray(step.evidence.scenarios), true);
  assert.strictEqual(checkpoints.length >= 1, true);
}

export const phaseSevenExecutionStateHardeningTests = [
  {
    name: 'phase7 anomaly detector emits explicit reason codes and severity',
    fn: testExecutionStateAnomalyDetectorReasonCodesAndSeverity,
  },
  {
    name: 'phase7 watchdog requests auditable runtime transitions',
    fn: testExecutionStateWatchdogRequestsRuntimeTransition,
  },
  {
    name: 'phase7 fill state service preserves granular lifecycle truth',
    fn: testFillStateServiceUsesGranularLifecycleTruth,
  },
  {
    name: 'phase7 kill switches escalate on execution anomalies and cost blowouts',
    fn: testKillSwitchEscalatesFromExecutionAnomalies,
  },
  {
    name: 'phase7 manage open orders degrades under watchdog pressure',
    fn: testManageOpenOrdersAdaptsToWatchdogDirective,
  },
  {
    name: 'phase7 production readiness covers watchdog degradations',
    fn: testProductionReadinessCoversWatchdogDegradation,
  },
];
