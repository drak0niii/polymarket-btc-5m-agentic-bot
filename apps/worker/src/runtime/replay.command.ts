import { PrismaClient } from '@prisma/client';
import { ReplayEngine } from './replay-engine';

async function main(): Promise<void> {
  const signalId = process.argv[2];
  if (!signalId) {
    throw new Error('Usage: replay.command.ts <signalId>');
  }

  const prisma = new PrismaClient();
  const replayEngine = new ReplayEngine(prisma);
  const replay = await replayEngine.replaySignal(signalId);
  await prisma.$disconnect();

  process.stdout.write(`${JSON.stringify(replay, null, 2)}\n`);
  if (!replay.reconstructable) {
    process.exitCode = 1;
  }
}

void main();
