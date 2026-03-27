import {
  readLatestDailyDecisionQualityReport,
  type DailyDecisionQualityReport,
} from '@worker/validation/daily-decision-quality-report';

export function formatDailyDecisionQualityOutput(input: {
  report: DailyDecisionQualityReport | null;
  lastNDays?: number;
}): Record<string, unknown> {
  if (!input.report) {
    return {
      reportAvailable: false,
      message: 'No daily decision-quality report is available yet.',
    };
  }

  const lastNDays = Math.max(1, Math.floor(input.lastNDays ?? 7));
  const byDay = [...input.report.byDay].sort((left, right) =>
    right.sliceKey.localeCompare(left.sliceKey),
  );

  return {
    reportAvailable: true,
    generatedAt: input.report.generatedAt,
    window: input.report.window,
    summary: input.report.summary,
    overall: input.report.overall,
    recentDays: byDay.slice(0, lastNDays),
    byRegime: input.report.byRegime,
  };
}

async function main(): Promise<void> {
  const parsedDays = Number.parseInt(process.argv[2] ?? '7', 10);
  const report = await readLatestDailyDecisionQualityReport();
  process.stdout.write(
    `${JSON.stringify(
      formatDailyDecisionQualityOutput({
        report,
        lastNDays: Number.isFinite(parsedDays) ? parsedDays : 7,
      }),
      null,
      2,
    )}\n`,
  );
}

void main();
