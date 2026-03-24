import { readLatestCapitalLeakReport } from '@worker/jobs/capitalLeakReview.job';

async function main(): Promise<void> {
  const variantId = process.argv[2] ?? null;
  const report = await readLatestCapitalLeakReport();

  process.stdout.write(
    `${JSON.stringify(
      {
        report,
        byStrategyVariant:
          variantId && report
            ? report.byStrategyVariant.find((group) => group.groupKey === variantId) ?? null
            : report?.byStrategyVariant ?? [],
        byRegime: report?.byRegime ?? [],
        byExecutionStyle: report?.byExecutionStyle ?? [],
      },
      null,
      2,
    )}\n`,
  );
}

void main();
