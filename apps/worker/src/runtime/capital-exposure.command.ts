import { PrismaClient } from '@prisma/client';
import {
  type CapitalExposureExecutionDiagnosticRecord,
  type CapitalExposureFillRecord,
  type CapitalExposurePortfolioSnapshotRecord,
  type CapitalValidationMode,
  buildCapitalExposureValidationReport,
  persistCapitalExposureValidationReport,
} from './capital-exposure-validation';
import { loadLatestLifecycleValidationEvidence } from '@worker/validation/live-order-lifecycle-validation';
import { appEnv } from '@worker/config/env';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const modeArg = args.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length);
  const validationMode =
    modeArg === 'shadow' || modeArg === 'micro_cap_live' || modeArg === 'limited_cap_live'
      ? (modeArg as CapitalValidationMode)
      : undefined;
  const prisma = new PrismaClient();
  const prismaAny = prisma as any;
  let readinessSuite: { status?: string | null } | null = null;
  let observerCheckpoint: { status?: string | null } | null = null;
  let divergenceFailures = 0;
  let fills: CapitalExposureFillRecord[] = [];
  let executionDiagnostics: CapitalExposureExecutionDiagnosticRecord[] = [];
  let portfolioSnapshots: CapitalExposurePortfolioSnapshotRecord[] = [];

  try {
    try {
      [
        readinessSuite,
        observerCheckpoint,
        divergenceFailures,
        fills,
        executionDiagnostics,
        portfolioSnapshots,
      ] = await Promise.all([
        prismaAny.reconciliationCheckpoint?.findFirst?.({
          where: { source: 'production_readiness_suite' },
          orderBy: { processedAt: 'desc' },
        }) ?? null,
        prismaAny.reconciliationCheckpoint?.findFirst?.({
          where: { source: 'production_readiness_observer' },
          orderBy: { processedAt: 'desc' },
        }) ?? null,
        prismaAny.reconciliationCheckpoint?.count?.({
          where: {
            source: 'external_portfolio_reconcile',
            status: 'failed',
          },
        }) ?? 0,
        prismaAny.fill?.findMany?.({
          orderBy: { filledAt: 'desc' },
          take: 25,
        }) ?? [],
        prismaAny.executionDiagnostic?.findMany?.({
          orderBy: { capturedAt: 'desc' },
          take: 50,
        }) ?? [],
        prismaAny.portfolioSnapshot?.findMany?.({
          orderBy: { capturedAt: 'desc' },
          take: 50,
        }) ?? [],
      ]);
    } catch {
      // The command should still emit a fail-closed report when persistence is unavailable.
      readinessSuite = null;
      observerCheckpoint = null;
      divergenceFailures = 0;
      fills = [];
      executionDiagnostics = [];
      portfolioSnapshots = [];
    }

    const report = persistCapitalExposureValidationReport(
      buildCapitalExposureValidationReport({
        deploymentTier: appEnv.BOT_DEPLOYMENT_TIER,
        validationMode,
        lifecycleSuite: loadLatestLifecycleValidationEvidence(),
        readinessSuitePassed: readinessSuite?.status === 'completed',
        observerHealthy: observerCheckpoint?.status === 'completed',
        fills,
        divergenceFailures,
        executionDiagnostics,
        portfolioSnapshots,
      }),
    );

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.allowLiveScale) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main();
