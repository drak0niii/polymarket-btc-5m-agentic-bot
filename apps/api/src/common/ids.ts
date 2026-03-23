import { createHash, randomUUID } from 'node:crypto';

export function generateId(): string {
  return randomUUID();
}

export function generateRequestId(): string {
  return randomUUID();
}

export function generateCorrelationId(): string {
  return randomUUID();
}

export function buildDeterministicId(parts: Array<string | number | boolean | null | undefined>): string {
  const normalized = parts
    .map((part) => {
      if (part === null) return 'null';
      if (typeof part === 'undefined') return 'undefined';
      return String(part).trim();
    })
    .join('::');

  return createHash('sha256').update(normalized).digest('hex');
}