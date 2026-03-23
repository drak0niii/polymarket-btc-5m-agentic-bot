import { PrismaClient } from '@prisma/client';
import { ChaosHarness, persistChaosHarnessResult } from './chaos-harness';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const iterationsArg = args.find((arg) => arg.startsWith('--iterations='));
  const iterations = Math.max(
    1,
    Number.parseInt(iterationsArg?.slice('--iterations='.length) ?? '1', 10) || 1,
  );
  const harness = new ChaosHarness();
  const result = persistChaosHarnessResult(harness.run({ iterations }));

  if (process.env.DATABASE_URL) {
    const prisma = new PrismaClient();
    const run = await prisma.stressTestRun.create({
      data: {
        family: 'chaos_harness',
        status: result.passed ? 'passed' : 'failed',
        verdict: result.passed ? 'passed' : 'failed',
        startedAt: new Date(),
        completedAt: new Date(),
        summary: JSON.parse(JSON.stringify(result)),
      },
    });
    for (const scenario of result.scenarios) {
      await prisma.stressTestScenarioResult.create({
        data: {
          stressTestRunId: run.id,
          scenarioKey: scenario.key,
          status: scenario.passed ? 'passed' : 'failed',
          verdict: scenario.passed ? 'passed' : 'failed',
          parameters: {},
          summary: JSON.parse(JSON.stringify(scenario)),
        },
      });
    }
    await prisma.$disconnect();
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) {
    process.exitCode = 1;
  }
}

void main();
