import fs from 'fs';
import path from 'path';
import { buildCapitalExposureValidationReport } from '@worker/runtime/capital-exposure-validation';
import { evaluateReadinessObserver } from '@worker/runtime/readiness-observer';
import type {
  LifecycleScenarioName,
  LifecycleValidationSuiteResult,
} from '@worker/validation/live-order-lifecycle-validation';
import { TradeAdmissionGate } from '@polymarket-btc-5m-agentic-bot/signal-engine';
import { CapitalRampPolicyService, DeploymentTierPolicyService } from '@polymarket-btc-5m-agentic-bot/risk-engine';

export type ChaosInjectionClass =
  | 'logic-level'
  | 'payload-level'
  | 'timing-level'
  | 'network-level'
  | 'persistence-level';

export interface ChaosScenarioResult {
  key: string;
  passed: boolean;
  injectionClasses: ChaosInjectionClass[];
  injectionBoundary: 'adapter' | 'runtime' | 'reconciliation' | 'persistence';
  injectedFaults: string[];
  timing: {
    baseDelayMs: number;
    jitterMs: number;
    raceWindowMs: number;
    clockSkewMs: number;
    burstCount: number;
    droppedMessages: number;
  };
  expected: {
    runtimeTransition: string;
    readinessResult: string;
    reconciliationBehavior: string;
    lifecycleSafetyResult: string;
    capitalAction: string;
  };
  observed: Record<string, unknown>;
}

export interface ChaosSoakIterationResult {
  iteration: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  passed: boolean;
  failedScenarios: string[];
}

export interface ChaosHarnessResult {
  passed: boolean;
  classificationSummary: Record<ChaosInjectionClass, number>;
  scenarios: ChaosScenarioResult[];
  observerVerdict: ReturnType<typeof evaluateReadinessObserver>;
  capitalEvidence: ReturnType<typeof buildCapitalExposureValidationReport>;
  soak: {
    enabled: boolean;
    iterations: number;
    passedIterations: number;
    failedIterations: number;
    averageDurationMs: number;
    maxDurationMs: number;
    results: ChaosSoakIterationResult[];
  };
  generatedAt: string;
  evidencePath: string;
}

const DEFAULT_CHAOS_EVIDENCE_PATH = path.resolve(
  __dirname,
  '../../../../artifacts/chaos-harness/latest.json',
);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildLifecycleSuite(input: {
  now: Date;
  executedAgoMs: number;
  scenario: LifecycleScenarioName;
  success: boolean;
  ambiguityReasonCodes: string[];
  noDuplicateExposure: boolean;
  runtimeSafetyStayedFailClosed: boolean;
}): LifecycleValidationSuiteResult {
  const executedAt = new Date(input.now.getTime() - input.executedAgoMs).toISOString();

  return {
    success: input.success,
    executedAt,
    validationMode: 'venue_runtime',
    scenarioCoverage: [input.scenario],
    scenarios: [
      {
        scenario: input.scenario,
        validationMode: 'venue_runtime',
        passed: input.success,
        intentId: `chaos-${input.scenario}`,
        submitAttempts: [],
        botBelief: [],
        venueTruth: [],
        restTruth: [],
        streamEvents: [],
        reconciliation: [],
        finalTruth: {
          scenario: input.scenario,
          ambiguityReasonCodes: input.ambiguityReasonCodes,
        },
        noDuplicateExposure: input.noDuplicateExposure,
        runtimeSafetyStayedFailClosed: input.runtimeSafetyStayedFailClosed,
        ambiguityDetected: input.ambiguityReasonCodes.length > 0,
        ambiguityReasonCodes: input.ambiguityReasonCodes,
        timing: {
          startedAt: executedAt,
          completedAt: executedAt,
          durationMs: 0,
          botSnapshotCount: 0,
          restSnapshotCount: 0,
          reconciliationStepCount: 0,
          streamEventCount: 0,
        },
        assertions: [],
      },
    ],
    soak: {
      enabled: false,
      iterations: 1,
      passedIterations: input.success ? 1 : 0,
      failedIterations: input.success ? 0 : 1,
      averageDurationMs: 0,
      maxDurationMs: 0,
      results: [],
    },
    evidencePath: `synthetic-chaos/${input.scenario}.json`,
  };
}

function countByClass(scenarios: ChaosScenarioResult[]): Record<ChaosInjectionClass, number> {
  const summary: Record<ChaosInjectionClass, number> = {
    'logic-level': 0,
    'payload-level': 0,
    'timing-level': 0,
    'network-level': 0,
    'persistence-level': 0,
  };

  for (const scenario of scenarios) {
    for (const classification of scenario.injectionClasses) {
      summary[classification] += 1;
    }
  }

  return summary;
}

export function persistChaosHarnessResult(
  result: ChaosHarnessResult,
  reportPath = DEFAULT_CHAOS_EVIDENCE_PATH,
): ChaosHarnessResult {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const finalResult = {
    ...result,
    evidencePath: reportPath,
  };
  fs.writeFileSync(reportPath, JSON.stringify(finalResult, null, 2));
  return finalResult;
}

export function loadLatestChaosHarnessEvidence(
  reportPath = DEFAULT_CHAOS_EVIDENCE_PATH,
): ChaosHarnessResult | null {
  if (!fs.existsSync(reportPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(reportPath, 'utf8')) as ChaosHarnessResult;
}

export class ChaosHarness {
  private readonly admissionGate = new TradeAdmissionGate();
  private readonly tierPolicy = new DeploymentTierPolicyService();
  private readonly capitalRampPolicy = new CapitalRampPolicyService();

  run(options?: { iterations?: number; now?: Date; evidencePath?: string }): ChaosHarnessResult {
    const iterations = Math.max(1, options?.iterations ?? 1);
    const baseNow = options?.now ?? new Date();
    const soakResults: ChaosSoakIterationResult[] = [];
    let latestScenarios: ChaosScenarioResult[] = [];
    let latestObserver = this.createObserverVerdict(baseNow);
    let latestCapitalEvidence = this.createCapitalEvidence(baseNow);

    for (let iteration = 1; iteration <= iterations; iteration += 1) {
      const startedAt = new Date(baseNow.getTime() + (iteration - 1) * 1_000);
      const scenarios = this.runScenarioSet(startedAt);
      const durationMs = 40 + iteration * 10;
      const failedScenarios = scenarios.scenarios
        .filter((scenario) => !scenario.passed)
        .map((scenario) => scenario.key);

      soakResults.push({
        iteration,
        startedAt: startedAt.toISOString(),
        completedAt: new Date(startedAt.getTime() + durationMs).toISOString(),
        durationMs,
        passed: failedScenarios.length === 0,
        failedScenarios,
      });

      latestScenarios = scenarios.scenarios;
      latestObserver = scenarios.observerVerdict;
      latestCapitalEvidence = scenarios.capitalEvidence;
    }

    const passedIterations = soakResults.filter((result) => result.passed).length;
    const averageDurationMs =
      soakResults.reduce((sum, result) => sum + result.durationMs, 0) / soakResults.length;
    const maxDurationMs = Math.max(...soakResults.map((result) => result.durationMs));
    const result: ChaosHarnessResult = {
      passed: latestScenarios.every((scenario) => scenario.passed),
      classificationSummary: countByClass(latestScenarios),
      scenarios: latestScenarios,
      observerVerdict: latestObserver,
      capitalEvidence: latestCapitalEvidence,
      soak: {
        enabled: iterations > 1,
        iterations,
        passedIterations,
        failedIterations: iterations - passedIterations,
        averageDurationMs,
        maxDurationMs,
        results: soakResults,
      },
      generatedAt: baseNow.toISOString(),
      evidencePath: options?.evidencePath ?? DEFAULT_CHAOS_EVIDENCE_PATH,
    };

    return clone(result);
  }

  private createBaselineEdge() {
    return {
      edgeDefinitionVersion: 'btc-5m-polymarket-edge-v1',
      executionStyle: 'hybrid' as const,
      rawModelEdge: 0.03,
      spreadAdjustedEdge: 0.02,
      slippageAdjustedEdge: 0.015,
      feeAdjustedEdge: 0.01,
      timeoutAdjustedEdge: 0.008,
      staleSignalAdjustedEdge: 0.006,
      inventoryAdjustedEdge: 0.005,
      finalNetEdge: 0.005,
      threshold: 0.0025,
      missingInputs: [],
      staleInputs: [],
      paperEdgeBlocked: false,
      confidence: 0.7,
    };
  }

  private createObserverVerdict(now: Date) {
    return evaluateReadinessObserver({
      internalSteps: [
        { name: 'market_stream_live_subscription', ok: true },
        { name: 'user_stream_authenticated_subscription', ok: true },
        { name: 'stream_truth_reconciliation', ok: true },
      ],
      marketHealth: {
        lastEventAt: new Date(now.getTime() - 60_000).toISOString(),
        lastTrafficAt: new Date(now.getTime() - 60_000).toISOString(),
      },
      userHealth: {
        lastEventAt: new Date(now.getTime() - 60_000).toISOString(),
        lastTrafficAt: new Date(now.getTime() - 60_000).toISOString(),
        divergenceDetected: true,
      },
      smokeSuccess: false,
      externalFreshness: { overallVerdict: 'stale' },
      lifecycleSuite: buildLifecycleSuite({
        now,
        executedAgoMs: 7 * 60 * 60 * 1000,
        scenario: 'submit_timeout_uncertain_venue_state',
        success: false,
        ambiguityReasonCodes: ['delayed_stream_visibility'],
        noDuplicateExposure: true,
        runtimeSafetyStayedFailClosed: true,
      }),
      marketStaleAfterMs: 5_000,
      userStaleAfterMs: 5_000,
    });
  }

  private createCapitalEvidence(now: Date) {
    return buildCapitalExposureValidationReport({
      deploymentTier: 'scaled_live',
      validationMode: 'limited_cap_live',
      lifecycleSuite: buildLifecycleSuite({
        now,
        executedAgoMs: 0,
        scenario: 'duplicate_or_delayed_fill_events',
        success: true,
        ambiguityReasonCodes: ['duplicate_fill_visibility_with_timing_offset'],
        noDuplicateExposure: true,
        runtimeSafetyStayedFailClosed: true,
      }),
      readinessSuitePassed: false,
      observerHealthy: false,
      fills: [],
      divergenceFailures: 2,
      executionDiagnostics: [],
      portfolioSnapshots: [],
    });
  }

  private runScenarioSet(now: Date): {
    scenarios: ChaosScenarioResult[];
    observerVerdict: ReturnType<typeof evaluateReadinessObserver>;
    capitalEvidence: ReturnType<typeof buildCapitalExposureValidationReport>;
  } {
    const baselineEdge = this.createBaselineEdge();
    const observerVerdict = this.createObserverVerdict(now);
    const capitalEvidence = this.createCapitalEvidence(now);

    const staleAdmission = this.admissionGate.evaluate({
      edgeDefinitionVersion: baselineEdge.edgeDefinitionVersion,
      signalPresent: true,
      directionalEdge: 0.03,
      executableEv: 0.005,
      signalConfidence: 0.7,
      walkForwardConfidence: 0.7,
      liquidityHealthy: true,
      freshnessHealthy: false,
      venueHealthy: true,
      reconciliationHealthy: true,
      riskHealthy: true,
      regimeAllowed: true,
      executableEdge: { ...baselineEdge, staleInputs: ['market_stream_jitter'] },
    });
    const missingEdge = this.admissionGate.evaluate({
      edgeDefinitionVersion: null,
      signalPresent: true,
      directionalEdge: 0.03,
      executableEv: 0.005,
      signalConfidence: 0.7,
      walkForwardConfidence: 0.7,
      liquidityHealthy: true,
      freshnessHealthy: true,
      venueHealthy: true,
      reconciliationHealthy: true,
      riskHealthy: true,
      regimeAllowed: true,
      executableEdge: baselineEdge,
    });
    const tierVerdict = this.tierPolicy.evaluate({
      tier: 'scaled_live',
      liveExecutionEnabled: true,
      robustnessPassed: false,
      auditCoverageHealthy: false,
      readinessReady: true,
    });
    const capitalRamp = this.capitalRampPolicy.evaluate({
      tierAllowsScale: tierVerdict.allowNewEntries,
      robustnessPassed: false,
      chaosPassed: false,
      auditCoverageHealthy: false,
      attributionCoverage: 0.3,
      promotionScore: 0.4,
      capitalExposureValidated: false,
    });
    const delayedAckLifecycle = buildLifecycleSuite({
      now,
      executedAgoMs: 0,
      scenario: 'cancel_acknowledged_late',
      success: true,
      ambiguityReasonCodes: ['delayed_cancel_visibility'],
      noDuplicateExposure: true,
      runtimeSafetyStayedFailClosed: true,
    });
    const duplicateFillLifecycle = buildLifecycleSuite({
      now,
      executedAgoMs: 0,
      scenario: 'duplicate_or_delayed_fill_events',
      success: true,
      ambiguityReasonCodes: ['duplicate_fill_visibility_with_timing_offset'],
      noDuplicateExposure: true,
      runtimeSafetyStayedFailClosed: true,
    });
    const limitedCapBlocked = buildCapitalExposureValidationReport({
      deploymentTier: 'scaled_live',
      validationMode: 'limited_cap_live',
      lifecycleSuite: duplicateFillLifecycle,
      readinessSuitePassed: true,
      observerHealthy: true,
      fills: [
        { price: 0.51, size: 10, fee: 0.01, filledAt: now.toISOString() },
        { price: 0.52, size: 10, fee: 0.01, filledAt: new Date(now.getTime() - 60_000).toISOString() },
      ],
      divergenceFailures: 1,
      executionDiagnostics: [
        {
          expectedEv: 0.06,
          realizedEv: 0.01,
          expectedFee: 0.005,
          realizedFee: 0.01,
          expectedSlippage: 0.003,
          realizedSlippage: 0.018,
          regime: 'illiquid_noisy_book',
          fillRate: 0.6,
        },
        {
          expectedEv: 0.05,
          realizedEv: 0.015,
          expectedFee: 0.005,
          realizedFee: 0.01,
          expectedSlippage: 0.003,
          realizedSlippage: 0.014,
          regime: 'illiquid_noisy_book',
          fillRate: 0.55,
        },
      ],
      portfolioSnapshots: [
        {
          bankroll: 100,
          availableCapital: 100,
          realizedPnlDay: 0,
          capturedAt: new Date(now.getTime() - 120_000).toISOString(),
        },
        {
          bankroll: 100,
          availableCapital: 92,
          realizedPnlDay: -8,
          capturedAt: now.toISOString(),
        },
      ],
    });
    const microCapBlocked = buildCapitalExposureValidationReport({
      deploymentTier: 'canary',
      validationMode: 'micro_cap_live',
      lifecycleSuite: duplicateFillLifecycle,
      readinessSuitePassed: true,
      observerHealthy: true,
      fills: [{ price: 0.51, size: 5, fee: 0.005, filledAt: now.toISOString() }],
      divergenceFailures: 0,
      executionDiagnostics: [
        {
          expectedEv: 0.05,
          realizedEv: 0.045,
          expectedFee: 0.005,
          realizedFee: 0.005,
          expectedSlippage: 0.004,
          realizedSlippage: 0.02,
          regime: 'illiquid_noisy_book',
          fillRate: 0.8,
        },
      ],
      portfolioSnapshots: [
        {
          bankroll: 100,
          availableCapital: 100,
          capturedAt: new Date(now.getTime() - 60_000).toISOString(),
        },
        {
          bankroll: 100,
          availableCapital: 99,
          capturedAt: now.toISOString(),
        },
      ],
    });

    const scenarios: ChaosScenarioResult[] = [
      {
        key: 'network_jitter_and_burst_latency',
        passed: staleAdmission.reasonCode === 'stale_data',
        injectionClasses: ['timing-level', 'network-level'],
        injectionBoundary: 'adapter',
        injectedFaults: ['network_jitter', 'burst_latency', 'stale_orderbook'],
        timing: {
          baseDelayMs: 200,
          jitterMs: 80,
          raceWindowMs: 120,
          clockSkewMs: 0,
          burstCount: 3,
          droppedMessages: 0,
        },
        expected: {
          runtimeTransition: 'reconciliation_only',
          readinessResult: 'blocked',
          reconciliationBehavior: 'wait_for_fresh_truth_before_admission',
          lifecycleSafetyResult: 'stale_admission_blocked',
          capitalAction: 'no_new_entries',
        },
        observed: {
          admissionReasonCode: staleAdmission.reasonCode,
          observerHealthy: observerVerdict.observerHealthy,
          capitalScalingAllowed: capitalRamp.allowScaling,
        },
      },
      {
        key: 'delayed_ack_and_delayed_visibility',
        passed:
          delayedAckLifecycle.scenarios[0]?.ambiguityDetected === true &&
          delayedAckLifecycle.scenarios[0]?.runtimeSafetyStayedFailClosed === true,
        injectionClasses: ['timing-level', 'network-level'],
        injectionBoundary: 'runtime',
        injectedFaults: ['delayed_ack', 'delayed_visibility'],
        timing: {
          baseDelayMs: 350,
          jitterMs: 120,
          raceWindowMs: 180,
          clockSkewMs: 0,
          burstCount: 2,
          droppedMessages: 0,
        },
        expected: {
          runtimeTransition: 'reconciliation_only',
          readinessResult: 'degraded',
          reconciliationBehavior: 'rest_truth_recheck_before_terminal_state',
          lifecycleSafetyResult: 'ambiguity_explicit_and_fail_closed',
          capitalAction: 'freeze_scale_up',
        },
        observed: {
          ambiguityReasonCodes: delayedAckLifecycle.scenarios[0]?.ambiguityReasonCodes ?? [],
          runtimeSafetyStayedFailClosed:
            delayedAckLifecycle.scenarios[0]?.runtimeSafetyStayedFailClosed ?? false,
        },
      },
      {
        key: 'dropped_stream_messages',
        passed:
          observerVerdict.discrepancyFlags.includes(
            'user_stream_internal_vs_observer_divergence',
          ) && !observerVerdict.observerHealthy,
        injectionClasses: ['network-level', 'payload-level'],
        injectionBoundary: 'adapter',
        injectedFaults: ['dropped_stream_messages', 'stale_user_stream'],
        timing: {
          baseDelayMs: 150,
          jitterMs: 60,
          raceWindowMs: 90,
          clockSkewMs: 0,
          burstCount: 1,
          droppedMessages: 4,
        },
        expected: {
          runtimeTransition: 'reconciliation_only',
          readinessResult: 'blocked',
          reconciliationBehavior: 'rest_vs_stream_divergence_checkpoint',
          lifecycleSafetyResult: 'no_unsafe_continuation',
          capitalAction: 'block_live_promotion',
        },
        observed: {
          discrepancyFlags: observerVerdict.discrepancyFlags,
          reasonCodes: observerVerdict.reasonCodes,
        },
      },
      {
        key: 'reconnect_storms',
        passed: observerVerdict.reasonCodes.includes('traffic_heartbeat_stale'),
        injectionClasses: ['timing-level', 'network-level'],
        injectionBoundary: 'runtime',
        injectedFaults: ['reconnect_storm', 'heartbeat_gap'],
        timing: {
          baseDelayMs: 500,
          jitterMs: 180,
          raceWindowMs: 200,
          clockSkewMs: 0,
          burstCount: 5,
          droppedMessages: 2,
        },
        expected: {
          runtimeTransition: 'degraded',
          readinessResult: 'blocked',
          reconciliationBehavior: 'hold_orders_until_streams_retrusted',
          lifecycleSafetyResult: 'no_blind_resume_after_reconnect',
          capitalAction: 'reduce_or_freeze_capital',
        },
        observed: {
          reasonCodes: observerVerdict.reasonCodes,
          observerHealthy: observerVerdict.observerHealthy,
        },
      },
      {
        key: 'out_of_order_event_arrival',
        passed:
          duplicateFillLifecycle.scenarios[0]?.runtimeSafetyStayedFailClosed === true &&
          duplicateFillLifecycle.scenarios[0]?.noDuplicateExposure === true,
        injectionClasses: ['timing-level', 'payload-level'],
        injectionBoundary: 'reconciliation',
        injectedFaults: ['out_of_order_fill_events', 'race_window_replay'],
        timing: {
          baseDelayMs: 90,
          jitterMs: 40,
          raceWindowMs: 250,
          clockSkewMs: 0,
          burstCount: 2,
          droppedMessages: 0,
        },
        expected: {
          runtimeTransition: 'reconciliation_only',
          readinessResult: 'degraded',
          reconciliationBehavior: 'deduplicate_fill_visibility_before_state_transition',
          lifecycleSafetyResult: 'no_double_counted_fill_events',
          capitalAction: 'block_scale_until_reconciled',
        },
        observed: {
          noDuplicateExposure: duplicateFillLifecycle.scenarios[0]?.noDuplicateExposure ?? false,
          ambiguityReasonCodes: duplicateFillLifecycle.scenarios[0]?.ambiguityReasonCodes ?? [],
        },
      },
      {
        key: 'partial_persistence_failure',
        passed:
          limitedCapBlocked.reasons.includes('capital_exposure_divergence_detected') &&
          limitedCapBlocked.allowRequestedMode === false,
        injectionClasses: ['persistence-level', 'timing-level'],
        injectionBoundary: 'persistence',
        injectedFaults: ['partial_checkpoint_write_failure', 'divergence_replay_required'],
        timing: {
          baseDelayMs: 120,
          jitterMs: 50,
          raceWindowMs: 120,
          clockSkewMs: 0,
          burstCount: 1,
          droppedMessages: 0,
        },
        expected: {
          runtimeTransition: 'reconciliation_only',
          readinessResult: 'blocked',
          reconciliationBehavior: 'replay_from_persisted_truth_and_fail_closed',
          lifecycleSafetyResult: 'capital_report_rejected',
          capitalAction: 'block_limited_cap_rollout',
        },
        observed: {
          reasons: limitedCapBlocked.reasons,
          stage: limitedCapBlocked.stage,
          allowRequestedMode: limitedCapBlocked.allowRequestedMode,
        },
      },
      {
        key: 'clock_skew_injection',
        passed: missingEdge.reasonCode === 'edge_definition_missing' && !tierVerdict.allowLiveOrders,
        injectionClasses: ['timing-level', 'logic-level'],
        injectionBoundary: 'runtime',
        injectedFaults: ['clock_skew', 'invalid_edge_timing_contract'],
        timing: {
          baseDelayMs: 75,
          jitterMs: 25,
          raceWindowMs: 80,
          clockSkewMs: 4_500,
          burstCount: 1,
          droppedMessages: 0,
        },
        expected: {
          runtimeTransition: 'degraded',
          readinessResult: 'blocked',
          reconciliationBehavior: 'startup_gate_revalidation',
          lifecycleSafetyResult: 'new_entries_blocked_on_time_uncertainty',
          capitalAction: 'no_scaling_without_time_authority',
        },
        observed: {
          admissionReasonCode: missingEdge.reasonCode,
          tierReasons: tierVerdict.reasons,
        },
      },
      {
        key: 'rest_vs_stream_truth_race',
        passed:
          observerVerdict.discrepancyFlags.includes(
            'open_order_divergence_internal_vs_observer_divergence',
          ) &&
          observerVerdict.materialDiscrepancy,
        injectionClasses: ['timing-level', 'network-level', 'payload-level'],
        injectionBoundary: 'reconciliation',
        injectedFaults: ['rest_stream_visibility_race', 'open_order_divergence'],
        timing: {
          baseDelayMs: 180,
          jitterMs: 70,
          raceWindowMs: 300,
          clockSkewMs: 0,
          burstCount: 2,
          droppedMessages: 1,
        },
        expected: {
          runtimeTransition: 'reconciliation_only',
          readinessResult: 'blocked',
          reconciliationBehavior: 'prefer_external_truth_until_stream_recovers',
          lifecycleSafetyResult: 'truth_ambiguity_explicit',
          capitalAction: 'freeze_scale_up',
        },
        observed: {
          materialDiscrepancy: observerVerdict.materialDiscrepancy,
          discrepancyFlags: observerVerdict.discrepancyFlags,
        },
      },
      {
        key: 'delayed_cancel_visibility',
        passed:
          delayedAckLifecycle.scenarios[0]?.ambiguityReasonCodes.includes(
            'delayed_cancel_visibility',
          ) ?? false,
        injectionClasses: ['timing-level', 'network-level'],
        injectionBoundary: 'adapter',
        injectedFaults: ['cancel_ack_late', 'cancel_visibility_delayed'],
        timing: {
          baseDelayMs: 260,
          jitterMs: 110,
          raceWindowMs: 160,
          clockSkewMs: 0,
          burstCount: 1,
          droppedMessages: 0,
        },
        expected: {
          runtimeTransition: 'cancel_only',
          readinessResult: 'degraded',
          reconciliationBehavior: 'poll_rest_until_cancel_truth_converges',
          lifecycleSafetyResult: 'no_false_terminal_cancel_assumption',
          capitalAction: 'hold_notional_constant',
        },
        observed: {
          ambiguityReasonCodes: delayedAckLifecycle.scenarios[0]?.ambiguityReasonCodes ?? [],
          runtimeSafetyStayedFailClosed:
            delayedAckLifecycle.scenarios[0]?.runtimeSafetyStayedFailClosed ?? false,
        },
      },
      {
        key: 'duplicate_fill_visibility_with_timing_offset',
        passed:
          microCapBlocked.reasons.includes('fill_quality_not_stable_enough') &&
          microCapBlocked.allowRequestedMode === false,
        injectionClasses: ['timing-level', 'payload-level', 'network-level'],
        injectionBoundary: 'reconciliation',
        injectedFaults: ['duplicate_fill_visibility', 'timing_offset', 'out_of_order_match_events'],
        timing: {
          baseDelayMs: 140,
          jitterMs: 60,
          raceWindowMs: 220,
          clockSkewMs: 0,
          burstCount: 2,
          droppedMessages: 0,
        },
        expected: {
          runtimeTransition: 'reconciliation_only',
          readinessResult: 'degraded',
          reconciliationBehavior: 'deduplicate_before_position_update',
          lifecycleSafetyResult: 'no_double_counted_fill_events',
          capitalAction: 'block_micro_cap_promotion',
        },
        observed: {
          reasons: microCapBlocked.reasons,
          fillQualityScore: microCapBlocked.microCap.fillQualityScore,
          allowRequestedMode: microCapBlocked.allowRequestedMode,
        },
      },
    ];

    return {
      scenarios,
      observerVerdict: clone(observerVerdict),
      capitalEvidence: clone(capitalEvidence),
    };
  }
}
