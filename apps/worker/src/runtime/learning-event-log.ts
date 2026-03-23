import fs from 'fs/promises';
import path from 'path';
import type { LearningEvent } from '@polymarket-btc-5m-agentic-bot/domain';
import { resolveRepositoryRoot } from './learning-state-store';

export class LearningEventLog {
  private readonly rootDir: string;
  private readonly logPath: string;

  constructor(rootDir = path.join(resolveRepositoryRoot(), 'artifacts/learning')) {
    this.rootDir = rootDir;
    this.logPath = path.join(rootDir, 'learning-events.jsonl');
  }

  async append(events: LearningEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    await fs.mkdir(this.rootDir, { recursive: true });
    const payload = events
      .map((event) => JSON.stringify(event))
      .join('\n');
    await fs.appendFile(this.logPath, `${payload}\n`, 'utf8');
  }

  async readLatest(limit = 100): Promise<LearningEvent[]> {
    try {
      const content = await fs.readFile(this.logPath, 'utf8');
      return content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(-limit)
        .map((line) => JSON.parse(line) as LearningEvent);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  getPath(): string {
    return this.logPath;
  }
}
