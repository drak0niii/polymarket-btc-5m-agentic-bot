import { PrismaClient } from '@prisma/client';
import { DailyReviewJob } from '@worker/jobs/dailyReview.job';

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const prisma = new PrismaClient();
  try {
    const job = new DailyReviewJob(prisma);
    const summary = await job.run({
      force,
      now: new Date(),
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
