import { PrismaClient } from '@prisma/client';
import { appEnv } from '@worker/config/env';
import { DecisionLogService } from './decision-log.service';
import { loadCapitalExposureValidationReport } from '@worker/runtime/capital-exposure-validation';
import { loadLatestChaosHarnessEvidence } from '@worker/runtime/chaos-harness';
import { loadLatestLifecycleValidationEvidence } from '@worker/validation/live-order-lifecycle-validation';
import { ProductionReadinessDashboardService } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { DeploymentTierPolicyService } from '@polymarket-btc-5m-agentic-bot/risk-engine';
import { CapitalRampPolicyService } from '@polymarket-btc-5m-agentic-bot/risk-engine';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const prismaAny = prisma as any;
  const lifecycleSuite = loadLatestLifecycleValidationEvidence();
  const capitalExposureReport = loadCapitalExposureValidationReport();
  const chaosArtifact = loadLatestChaosHarnessEvidence();
  const decisionLogs = new DecisionLogService(prisma);
  const readinessService = new ProductionReadinessDashboardService();
  const tierPolicy = new DeploymentTierPolicyService();
  const capitalRampPolicy = new CapitalRampPolicyService();

  const [
    runtimeStatus,
    startupGate,
    researchGovernance,
    chaosRun,
    auditEvents,
    openOrdersCheckpoint,
    fillsCheckpoint,
    externalCheckpoint,
    heartbeatCheckpoint,
    lifecycleValidationCheckpoint,
    observerCheckpoint,
    capitalExposureCheckpoint,
  ] = await Promise.all([
    prismaAny.botRuntimeStatus?.findUnique?.({ where: { id: 'live' } }) ?? null,
    prismaAny.reconciliationCheckpoint?.findFirst?.({
      where: { source: 'startup_gate_verdict' },
      orderBy: { processedAt: 'desc' },
    }) ?? null,
    prismaAny.reconciliationCheckpoint?.findFirst?.({
      where: { source: 'research_governance_validation' },
      orderBy: { processedAt: 'desc' },
    }) ?? null,
    prismaAny.stressTestRun?.findFirst?.({
      where: { family: 'chaos_harness' },
      orderBy: { startedAt: 'desc' },
    }) ?? null,
    prismaAny.auditEvent?.findMany?.({
      orderBy: { createdAt: 'desc' },
      take: 200,
    }) ?? [],
    prismaAny.reconciliationCheckpoint?.findFirst?.({
      where: { source: 'open_orders_reconcile_cycle' },
      orderBy: { processedAt: 'desc' },
    }) ?? null,
    prismaAny.reconciliationCheckpoint?.findFirst?.({
      where: { source: 'fills_reconcile_cycle' },
      orderBy: { processedAt: 'desc' },
    }) ?? null,
    prismaAny.reconciliationCheckpoint?.findFirst?.({
      where: { source: 'external_portfolio_reconcile' },
      orderBy: { processedAt: 'desc' },
    }) ?? null,
    prismaAny.reconciliationCheckpoint?.findFirst?.({
      where: { source: 'venue_open_orders_heartbeat' },
      orderBy: { processedAt: 'desc' },
    }) ?? null,
    prismaAny.reconciliationCheckpoint?.findFirst?.({
      where: { source: 'lifecycle_validation_scenario' },
      orderBy: { processedAt: 'desc' },
    }) ?? null,
    prismaAny.reconciliationCheckpoint?.findFirst?.({
      where: { source: 'production_readiness_observer' },
      orderBy: { processedAt: 'desc' },
    }) ?? null,
    prismaAny.reconciliationCheckpoint?.findFirst?.({
      where: { source: 'capital_exposure_validation' },
      orderBy: { processedAt: 'desc' },
    }) ?? null,
  ]);

  const auditCoverage = decisionLogs.summarizeAuditCoverage(auditEvents);
  const chaosPassed =
    chaosRun?.verdict === 'passed' ||
    chaosRun?.status === 'passed' ||
    chaosArtifact?.passed === true ||
    appEnv.BOT_DEPLOYMENT_TIER === 'paper' ||
    appEnv.BOT_DEPLOYMENT_TIER === 'research';
  const recentParserFailure =
    auditEvents.find((event: { eventType?: string | null }) =>
      (event.eventType ?? '').startsWith('venue.parser_failure'),
    ) ?? null;
  const researchDetails =
    researchGovernance?.details && typeof researchGovernance.details === 'object'
      ? (researchGovernance.details as Record<string, unknown>)
      : {};
  const robustness =
    researchDetails.robustness && typeof researchDetails.robustness === 'object'
      ? (researchDetails.robustness as Record<string, unknown>)
      : {};
  const promotion =
    researchDetails.promotion && typeof researchDetails.promotion === 'object'
      ? (researchDetails.promotion as Record<string, unknown>)
      : {};
  const tierVerdict = tierPolicy.evaluate({
    tier: appEnv.BOT_DEPLOYMENT_TIER,
    liveExecutionEnabled: appEnv.BOT_LIVE_EXECUTION_ENABLED,
    robustnessPassed: Boolean(robustness.passed),
    auditCoverageHealthy: auditCoverage.healthy,
    readinessReady:
      runtimeStatus?.state === 'running' &&
      openOrdersCheckpoint?.status === 'completed' &&
      fillsCheckpoint?.status === 'completed' &&
      externalCheckpoint?.status === 'completed',
  });
  const capitalRamp = capitalRampPolicy.evaluate({
    tierAllowsScale: tierVerdict.allowNewEntries,
    robustnessPassed: Boolean(robustness.passed),
    chaosPassed,
    auditCoverageHealthy: auditCoverage.healthy,
    attributionCoverage: Math.min(
      1,
      auditEvents.filter((event: { eventType?: string | null }) =>
        (event.eventType ?? '').includes('trade.post_trade_attribution'),
      ).length / 10,
    ),
    promotionScore: Number(promotion.score ?? 0),
    capitalExposureValidated:
      capitalExposureReport?.allowLiveScale === true ||
      observerCheckpoint?.status === 'completed' && appEnv.BOT_DEPLOYMENT_TIER === 'paper' ||
      observerCheckpoint?.status === 'completed' && appEnv.BOT_DEPLOYMENT_TIER === 'research',
  });

  const dashboard = readinessService.evaluate({
    deploymentTier: tierVerdict.tier,
    capitalMultiplier: capitalRamp.capitalMultiplier,
    checks: {
      startup: startupGate?.status === 'completed',
      streams:
        openOrdersCheckpoint?.status === 'completed' &&
        fillsCheckpoint?.status === 'completed' &&
        externalCheckpoint?.status === 'completed' &&
        (heartbeatCheckpoint?.status === 'completed' || !heartbeatCheckpoint) &&
        !recentParserFailure,
      observer: observerCheckpoint?.status === 'completed',
      governance: researchGovernance?.status === 'passed',
      robustness: Boolean(robustness.passed),
      auditability: auditCoverage.healthy,
      replay:
        auditEvents.filter((event: { eventType?: string | null }) =>
          (event.eventType ?? '').includes('signal.admission_decision'),
        ).length > 0 &&
        Boolean(lifecycleSuite?.success),
      chaos: chaosPassed,
      tier: tierVerdict.reasons.length === 0,
      capitalRamp:
        capitalRamp.allowScaling ||
        appEnv.BOT_DEPLOYMENT_TIER === 'paper' ||
        appEnv.BOT_DEPLOYMENT_TIER === 'research',
      capitalEvidence:
        capitalExposureReport?.allowLiveScale === true ||
        capitalExposureCheckpoint?.status === 'completed',
    },
    reasons: {
      startup: startupGate?.status ?? 'missing',
      streams: recentParserFailure?.eventType ?? heartbeatCheckpoint?.status ?? 'missing',
      observer: observerCheckpoint?.status ?? 'missing',
      governance: researchGovernance?.status ?? 'missing',
      robustness: Boolean(robustness.passed) ? 'healthy' : 'not_passed',
      auditability: auditCoverage.healthy ? 'healthy' : 'coverage_too_low',
      replay:
        lifecycleSuite
          ? `decision_log_replay|lifecycle_validation:${lifecycleSuite.success ? 'passed' : 'failed'}`
          : lifecycleValidationCheckpoint?.status
            ? `decision_log_replay|lifecycle_validation:${lifecycleValidationCheckpoint.status}`
            : 'decision_log_replay',
      chaos:
        chaosRun?.status ??
        (chaosArtifact
          ? `artifact:${chaosArtifact.passed ? 'passed' : 'failed'}`
          : 'missing'),
      tier: tierVerdict.reasons.join('|') || 'healthy',
      capitalRamp: capitalRamp.reasons.join('|') || capitalRamp.stage,
      capitalEvidence:
        capitalExposureReport?.stage ??
        capitalExposureCheckpoint?.status ??
        'missing',
    },
    observedAt: {
      replay: lifecycleSuite?.executedAt ?? lifecycleValidationCheckpoint?.processedAt?.toISOString?.() ?? null,
      observer: observerCheckpoint?.processedAt?.toISOString?.() ?? null,
      capitalEvidence:
        capitalExposureReport?.generatedAt ??
        capitalExposureCheckpoint?.processedAt?.toISOString?.() ??
        null,
    },
  });

  await decisionLogs.record({
    category: 'readiness',
    eventType: 'runtime.readiness_dashboard',
    summary: 'Runtime readiness dashboard generated.',
    payload: dashboard as unknown as Record<string, unknown>,
    createdAt: new Date().toISOString(),
  });

  await prisma.$disconnect();
  process.stdout.write(`${JSON.stringify(dashboard, null, 2)}\n`);
  if (dashboard.status === 'blocked') {
    process.exitCode = 1;
  }
}

void main();
