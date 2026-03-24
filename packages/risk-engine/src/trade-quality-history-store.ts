import fs from 'fs/promises';
import path from 'path';
import type { TradeQualityScore } from '@polymarket-btc-5m-agentic-bot/domain';

export class TradeQualityHistoryStore {
  private readonly rootDir: string;
  private readonly logPath: string;

  constructor(rootDir = path.join(resolveRepositoryRoot(), 'artifacts/learning/trade-quality')) {
    this.rootDir = rootDir;
    this.logPath = path.join(rootDir, 'trade-quality-history.jsonl');
  }

  async append(scores: TradeQualityScore[]): Promise<void> {
    if (scores.length === 0) {
      return;
    }

    await fs.mkdir(this.rootDir, { recursive: true });
    await fs.appendFile(
      this.logPath,
      `${scores.map((score) => JSON.stringify(score)).join('\n')}\n`,
      'utf8',
    );
  }

  async readLatest(limit = 100): Promise<TradeQualityScore[]> {
    try {
      const content = await fs.readFile(this.logPath, 'utf8');
      return content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(-limit)
        .map((line) => JSON.parse(line) as TradeQualityScore);
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }
  }

  async readWindow(from: Date, to: Date): Promise<TradeQualityScore[]> {
    const items = await this.readLatest(5_000);
    return items.filter((item) => {
      const evaluatedAt = new Date(item.evaluatedAt);
      return (
        !Number.isNaN(evaluatedAt.getTime()) &&
        evaluatedAt.getTime() >= from.getTime() &&
        evaluatedAt.getTime() <= to.getTime()
      );
    });
  }

  getPath(): string {
    return this.logPath;
  }
}

function resolveRepositoryRoot(start = process.cwd()): string {
  let current = path.resolve(start);
  while (true) {
    const markers = [
      path.join(current, 'pnpm-workspace.yaml'),
      path.join(current, 'AGENTS.md'),
    ];
    try {
      if (markers.some((marker) => require('fs').existsSync(marker))) {
        return current;
      }
    } catch {
      return start;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return start;
    }
    current = parent;
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT');
}
