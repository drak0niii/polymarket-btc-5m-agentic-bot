import fs from 'fs';
import path from 'path';
import type { LifecycleValidationSuiteResult } from '@worker/validation/live-order-lifecycle-validation';

const DEFAULT_CAPITAL_EXPOSURE_REPORT_PATH = path.resolve(
  __dirname,
  '../../../../artifacts/capital-exposure-validation/latest.json',
);

export type CapitalValidationMode = 'shadow' | 'micro_cap_live' | 'limited_cap_live';

export interface CapitalExposureFillRecord {
  price: number;
  size: number;
  fee?: number | null;
  filledAt: string | Date;
}

export interface CapitalExposureExecutionDiagnosticRecord {
  expectedEv?: number | null;
  realizedEv?: number | null;
  expectedFee?: number | null;
  realizedFee?: number | null;
  expectedSlippage?: number | null;
  realizedSlippage?: number | null;
  regime?: string | null;
  fillRate?: number | null;
  capturedAt?: string | Date;
}

export interface CapitalExposurePortfolioSnapshotRecord {
  bankroll: number;
  availableCapital: number;
  realizedPnlDay?: number | null;
  capturedAt: string | Date;
}

export interface CapitalExposureRegimeMetric {
  regime: string;
  tradeCount: number;
  expectedEvAvg: number | null;
  realizedEvAvg: number | null;
  executionDriftAvg: number | null;
}

export interface CapitalExposureValidationReport {
  generatedAt: string;
  deploymentTier: string;
  validationMode: CapitalValidationMode;
  stage:
    | 'unvalidated'
    | 'shadow_validated'
    | 'micro_cap_validated'
    | 'limited_cap_validated';
  allowRequestedMode: boolean;
  allowLiveScale: boolean;
  reasons: string[];
  shadow: {
    readinessSuitePassed: boolean;
    observerHealthy: boolean;
    lifecycleSuitePassed: boolean;
    diagnosticCount: number;
    benchmarkAligned: boolean;
  };
  microCap: {
    fillCount: number;
    totalFillNotional: number;
    maxFillNotional: number;
    latestFillAt: string | null;
    divergenceFailures: number;
    duplicateExposureIncidents: number;
    thresholdNotional: number;
    fillQualityScore: number;
    acceptable: boolean;
  };
  limitedCap: {
    eligible: boolean;
    minTradeCount: number;
    drawdownPct: number;
    capitalEfficiency: number;
    acceptableExecutionDrift: boolean;
    acceptableDrawdown: boolean;
    acceptableIncidentRate: boolean;
    stableExecutionQuality: boolean;
  };
  metrics: {
    tradeCount: number;
    expectedEvSum: number;
    realizedEvSum: number;
    executionDrift: number;
    realizedVsExpected: number | null;
    avgExpectedFee: number | null;
    avgRealizedFee: number | null;
    avgExpectedSlippage: number | null;
    avgRealizedSlippage: number | null;
    avgFillRate: number | null;
    lifecycleAnomalyRate: number;
    drawdownPct: number;
    capitalEfficiency: number;
    regimePerformance: CapitalExposureRegimeMetric[];
  };
  reportPath: string;
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function deriveValidationMode(deploymentTier: string): CapitalValidationMode {
  if (deploymentTier === 'canary') {
    return 'micro_cap_live';
  }
  if (deploymentTier === 'cautious_live' || deploymentTier === 'scaled_live') {
    return 'limited_cap_live';
  }

  return 'shadow';
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value ?? '');
}

function safeRatio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-9) {
    return null;
  }

  return numerator / denominator;
}

function computeDrawdownPct(input: CapitalExposurePortfolioSnapshotRecord[]): number {
  const ordered = [...input].sort(
    (left, right) =>
      new Date(toIsoString(left.capturedAt)).getTime() -
      new Date(toIsoString(right.capturedAt)).getTime(),
  );
  let peak = 0;
  let worstDrawdown = 0;

  for (const snapshot of ordered) {
    const value = Math.max(
      0,
      Number.isFinite(snapshot.availableCapital) ? snapshot.availableCapital : snapshot.bankroll,
    );
    peak = Math.max(peak, value);
    if (peak <= 0) {
      continue;
    }
    worstDrawdown = Math.max(worstDrawdown, (peak - value) / peak);
  }

  return worstDrawdown;
}

export function buildCapitalExposureValidationReport(input: {
  deploymentTier: string;
  lifecycleSuite: LifecycleValidationSuiteResult | null;
  readinessSuitePassed: boolean;
  observerHealthy: boolean;
  fills: CapitalExposureFillRecord[];
  divergenceFailures: number;
  executionDiagnostics?: CapitalExposureExecutionDiagnosticRecord[];
  portfolioSnapshots?: CapitalExposurePortfolioSnapshotRecord[];
  validationMode?: CapitalValidationMode;
  maxMicroCapNotional?: number;
  reportPath?: string;
  now?: Date;
}): CapitalExposureValidationReport {
  const validationMode = input.validationMode ?? deriveValidationMode(input.deploymentTier);
  const thresholdNotional = input.maxMicroCapNotional ?? 25;
  const duplicateExposureIncidents =
    input.lifecycleSuite?.scenarios.filter((scenario) => !scenario.noDuplicateExposure).length ?? 0;
  const unsafeLifecycleIncidents =
    input.lifecycleSuite?.scenarios.filter((scenario) => !scenario.runtimeSafetyStayedFailClosed)
      .length ?? 0;
  const normalizedFills = input.fills.map((fill) => ({
    notional: Math.max(0, fill.price) * Math.max(0, fill.size),
    fee: Math.max(0, fill.fee ?? 0),
    filledAt:
      fill.filledAt instanceof Date ? fill.filledAt.toISOString() : String(fill.filledAt ?? ''),
  }));
  const executionDiagnostics = (input.executionDiagnostics ?? []).map((diagnostic) => ({
    expectedEv: diagnostic.expectedEv ?? null,
    realizedEv: diagnostic.realizedEv ?? null,
    expectedFee: diagnostic.expectedFee ?? null,
    realizedFee: diagnostic.realizedFee ?? null,
    expectedSlippage: diagnostic.expectedSlippage ?? null,
    realizedSlippage: diagnostic.realizedSlippage ?? null,
    regime: diagnostic.regime ?? 'unknown',
    fillRate: diagnostic.fillRate ?? null,
  }));
  const tradeCount = Math.max(normalizedFills.length, executionDiagnostics.length);
  const totalFillNotional = normalizedFills.reduce((sum, fill) => sum + fill.notional, 0);
  const maxFillNotional =
    normalizedFills.length > 0
      ? Math.max(...normalizedFills.map((fill) => fill.notional))
      : 0;
  const latestFillAt =
    normalizedFills.length > 0
      ? normalizedFills
          .map((fill) => fill.filledAt)
          .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] ?? null
      : null;
  const expectedEvSum = sum(
    executionDiagnostics
      .map((diagnostic) => diagnostic.expectedEv)
      .filter((value): value is number => value != null),
  );
  const realizedEvSum = sum(
    executionDiagnostics
      .map((diagnostic) => diagnostic.realizedEv)
      .filter((value): value is number => value != null),
  );
  const executionDrift = realizedEvSum - expectedEvSum;
  const realizedVsExpected = safeRatio(realizedEvSum, expectedEvSum);
  const avgExpectedFee = average(
    executionDiagnostics
      .map((diagnostic) => diagnostic.expectedFee)
      .filter((value): value is number => value != null),
  );
  const avgRealizedFee = average(
    executionDiagnostics
      .map((diagnostic) => diagnostic.realizedFee)
      .filter((value): value is number => value != null),
  );
  const avgExpectedSlippage = average(
    executionDiagnostics
      .map((diagnostic) => diagnostic.expectedSlippage)
      .filter((value): value is number => value != null),
  );
  const avgRealizedSlippage = average(
    executionDiagnostics
      .map((diagnostic) => diagnostic.realizedSlippage)
      .filter((value): value is number => value != null),
  );
  const avgFillRate = average(
    executionDiagnostics
      .map((diagnostic) => diagnostic.fillRate)
      .filter((value): value is number => value != null),
  );
  const fillQualityEvaluations = executionDiagnostics.filter(
    (diagnostic) =>
      diagnostic.realizedSlippage != null ||
      diagnostic.expectedSlippage != null ||
      diagnostic.realizedFee != null,
  );
  const fillQualityScore =
    fillQualityEvaluations.length === 0
        ? 0
        : fillQualityEvaluations.filter((diagnostic) => {
          const realizedSlippage = diagnostic.realizedSlippage ?? 0;
          const slippageHealthy =
            diagnostic.realizedSlippage == null ||
            diagnostic.expectedSlippage == null ||
            diagnostic.expectedSlippage <= 0
              ? realizedSlippage <= 0.02
              : realizedSlippage <= diagnostic.expectedSlippage * 1.35;
          const feeHealthy =
            diagnostic.realizedFee == null ||
            diagnostic.expectedFee == null ||
            diagnostic.expectedFee <= 0
              ? true
              : diagnostic.realizedFee <= diagnostic.expectedFee * 1.35;

          return slippageHealthy && feeHealthy;
        }).length / fillQualityEvaluations.length;
  const scenarioCount = input.lifecycleSuite?.scenarios.length ?? 0;
  const lifecycleAnomalyRate =
    scenarioCount > 0
      ? (duplicateExposureIncidents + unsafeLifecycleIncidents) / scenarioCount
      : 1;
  const drawdownPct = computeDrawdownPct(input.portfolioSnapshots ?? []);
  const capitalEfficiency = totalFillNotional > 0 ? realizedEvSum / totalFillNotional : 0;
  const regimeGroups = new Map<string, typeof executionDiagnostics>();
  for (const diagnostic of executionDiagnostics) {
    const group = regimeGroups.get(diagnostic.regime) ?? [];
    group.push(diagnostic);
    regimeGroups.set(diagnostic.regime, group);
  }
  const regimePerformance: CapitalExposureRegimeMetric[] = [...regimeGroups.entries()]
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
    .map(([regime, diagnostics]) => ({
      regime,
      tradeCount: diagnostics.length,
      expectedEvAvg: average(
        diagnostics
          .map((diagnostic) => diagnostic.expectedEv)
          .filter((value): value is number => value != null),
      ),
      realizedEvAvg: average(
        diagnostics
          .map((diagnostic) => diagnostic.realizedEv)
          .filter((value): value is number => value != null),
      ),
      executionDriftAvg: average(
        diagnostics
          .map((diagnostic) =>
            diagnostic.realizedEv != null && diagnostic.expectedEv != null
              ? diagnostic.realizedEv - diagnostic.expectedEv
              : null,
          )
          .filter((value): value is number => value != null),
      ),
    }));

  const shadowValidated =
    input.readinessSuitePassed &&
    input.observerHealthy &&
    Boolean(input.lifecycleSuite?.success) &&
    executionDiagnostics.length > 0 &&
    Math.abs(executionDrift) <= 0.35;
  const microCapAcceptable =
    normalizedFills.length > 0 &&
    totalFillNotional > 0 &&
    maxFillNotional <= thresholdNotional &&
    input.divergenceFailures === 0 &&
    duplicateExposureIncidents === 0 &&
    fillQualityScore >= 0.5 &&
    Math.abs(executionDrift) <= 0.25;
  const microCapValidated =
    shadowValidated &&
    microCapAcceptable;
  const limitedCapEligible =
    microCapValidated &&
    tradeCount >= 3 &&
    drawdownPct <= 0.05 &&
    Math.abs(executionDrift) <= 0.15 &&
    lifecycleAnomalyRate <= 0.05 &&
    fillQualityScore >= 0.6;

  const reasons: string[] = [];
  if (!shadowValidated) {
    reasons.push('shadow_validation_incomplete');
  }
  if (normalizedFills.length === 0) {
    reasons.push('micro_cap_live_fills_missing');
  }
  if (maxFillNotional > thresholdNotional) {
    reasons.push('micro_cap_fill_notional_exceeded');
  }
  if (input.divergenceFailures > 0) {
    reasons.push('capital_exposure_divergence_detected');
  }
  if (duplicateExposureIncidents > 0) {
    reasons.push('capital_exposure_duplicate_incident_detected');
  }
  if (executionDiagnostics.length === 0) {
    reasons.push('execution_diagnostics_missing');
  }
  if (Math.abs(executionDrift) > 0.25) {
    reasons.push('execution_drift_above_micro_cap_tolerance');
  }
  if (fillQualityScore < 0.5) {
    reasons.push('fill_quality_not_stable_enough');
  }
  if (tradeCount < 3 && validationMode === 'limited_cap_live') {
    reasons.push('limited_cap_trade_count_below_threshold');
  }
  if (drawdownPct > 0.05 && validationMode === 'limited_cap_live') {
    reasons.push('drawdown_above_limited_cap_tolerance');
  }
  if (lifecycleAnomalyRate > 0.05 && validationMode === 'limited_cap_live') {
    reasons.push('lifecycle_anomaly_rate_above_tolerance');
  }

  const stage = limitedCapEligible
    ? 'limited_cap_validated'
    : microCapValidated
      ? 'micro_cap_validated'
      : shadowValidated
        ? 'shadow_validated'
        : 'unvalidated';
  const allowRequestedMode =
    validationMode === 'limited_cap_live'
      ? limitedCapEligible
      : validationMode === 'micro_cap_live'
        ? microCapValidated
        : shadowValidated;
  const allowLiveScale =
    allowRequestedMode ||
    input.deploymentTier === 'paper' ||
    input.deploymentTier === 'research';

  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    deploymentTier: input.deploymentTier,
    validationMode,
    stage,
    allowRequestedMode,
    allowLiveScale,
    reasons,
    shadow: {
      readinessSuitePassed: input.readinessSuitePassed,
      observerHealthy: input.observerHealthy,
      lifecycleSuitePassed: Boolean(input.lifecycleSuite?.success),
      diagnosticCount: executionDiagnostics.length,
      benchmarkAligned: shadowValidated,
    },
    microCap: {
      fillCount: normalizedFills.length,
      totalFillNotional,
      maxFillNotional,
      latestFillAt,
      divergenceFailures: input.divergenceFailures,
      duplicateExposureIncidents,
      thresholdNotional,
      fillQualityScore,
      acceptable: microCapAcceptable,
    },
    limitedCap: {
      eligible: limitedCapEligible,
      minTradeCount: 3,
      drawdownPct,
      capitalEfficiency,
      acceptableExecutionDrift: Math.abs(executionDrift) <= 0.15,
      acceptableDrawdown: drawdownPct <= 0.05,
      acceptableIncidentRate: lifecycleAnomalyRate <= 0.05,
      stableExecutionQuality: fillQualityScore >= 0.6,
    },
    metrics: {
      tradeCount,
      expectedEvSum,
      realizedEvSum,
      executionDrift,
      realizedVsExpected,
      avgExpectedFee,
      avgRealizedFee,
      avgExpectedSlippage,
      avgRealizedSlippage,
      avgFillRate,
      lifecycleAnomalyRate,
      drawdownPct,
      capitalEfficiency,
      regimePerformance,
    },
    reportPath: input.reportPath ?? DEFAULT_CAPITAL_EXPOSURE_REPORT_PATH,
  };
}

export function persistCapitalExposureValidationReport(
  report: CapitalExposureValidationReport,
): CapitalExposureValidationReport {
  fs.mkdirSync(path.dirname(report.reportPath), { recursive: true });
  fs.writeFileSync(report.reportPath, JSON.stringify(report, null, 2));
  return report;
}

export function loadCapitalExposureValidationReport(
  reportPath = DEFAULT_CAPITAL_EXPOSURE_REPORT_PATH,
): CapitalExposureValidationReport | null {
  if (!fs.existsSync(reportPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(reportPath, 'utf8')) as CapitalExposureValidationReport;
}
