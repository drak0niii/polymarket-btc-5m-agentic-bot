import { readLatestCapitalGrowthReport } from '@worker/jobs/capitalGrowthReview.job';

async function main(): Promise<void> {
  const variantId = process.argv[2] ?? null;
  const report = await readLatestCapitalGrowthReport();

  process.stdout.write(
    `${JSON.stringify(
      {
        report,
        variants:
          variantId && report
            ? report.variants.filter((variant) => variant.strategyVariantId === variantId)
            : report?.variants ?? [],
        shouldScale: report?.shouldScale ?? [],
        shouldReduce: report?.shouldReduce ?? [],
        profitableButUnstable: report?.profitableButUnstable ?? [],
      },
      null,
      2,
    )}\n`,
  );
}

void main();
