type LogLevel = 'error' | 'warn' | 'log' | 'debug' | 'verbose';
import { redactSecrets } from '@worker/config/secret-provider';

export interface LogMetadata {
  requestId?: string;
  correlationId?: string;
  botState?: string;
  marketId?: string;
  signalId?: string;
  orderId?: string;
  [key: string]: unknown;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  log: 2,
  debug: 3,
  verbose: 4,
};

export class AppLogger {
  private context?: string;
  private readonly currentLevel: LogLevel;

  constructor(context?: string) {
    this.context = context;
    this.currentLevel = this.resolveLogLevel(process.env.LOG_LEVEL);
  }

  setContext(context: string): void {
    this.context = context;
  }

  error(message: unknown, trace?: string, metadata?: LogMetadata): void {
    this.write('error', message, trace, metadata);
  }

  warn(message: unknown, metadata?: LogMetadata): void {
    this.write('warn', message, undefined, metadata);
  }

  log(message: unknown, metadata?: LogMetadata): void {
    this.write('log', message, undefined, metadata);
  }

  debug(message: unknown, metadata?: LogMetadata): void {
    this.write('debug', message, undefined, metadata);
  }

  verbose(message: unknown, metadata?: LogMetadata): void {
    this.write('verbose', message, undefined, metadata);
  }

  child(context: string): AppLogger {
    return new AppLogger(context);
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] <= LOG_LEVEL_PRIORITY[this.currentLevel];
  }

  private write(
    level: LogLevel,
    message: unknown,
    trace?: string,
    metadata?: LogMetadata,
  ): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const payload = {
      timestamp: new Date().toISOString(),
      level,
      context: this.context ?? 'Worker',
      pid: process.pid,
      message: redactSecrets(this.normalizeMessage(message)),
      ...(trace ? { trace: redactSecrets(trace) } : {}),
      ...(metadata ? { metadata: redactSecrets(metadata) } : {}),
    };

    const serialized = JSON.stringify(payload);

    switch (level) {
      case 'error':
        console.error(serialized);
        break;
      case 'warn':
        console.warn(serialized);
        break;
      case 'debug':
        console.debug(serialized);
        break;
      case 'verbose':
        console.info(serialized);
        break;
      case 'log':
      default:
        console.log(serialized);
        break;
    }
  }

  private normalizeMessage(message: unknown): string | Record<string, unknown> {
    if (message instanceof Error) {
      return {
        name: message.name,
        message: message.message,
        stack: message.stack,
      };
    }

    if (typeof message === 'string') {
      return message;
    }

    if (
      typeof message === 'object' &&
      message !== null &&
      !Array.isArray(message)
    ) {
      return message as Record<string, unknown>;
    }

    return String(message);
  }

  private resolveLogLevel(value?: string): LogLevel {
    if (
      value === 'error' ||
      value === 'warn' ||
      value === 'log' ||
      value === 'debug' ||
      value === 'verbose'
    ) {
      return value;
    }

    return 'log';
  }
}
