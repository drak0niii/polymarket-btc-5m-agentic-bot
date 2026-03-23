import { AppLogger } from './common/logger';
import { appEnv } from './config/env';
import { initializeTelemetry } from './common/telemetry';
import { BotRuntime } from './runtime/bot-runtime';

async function bootstrap(): Promise<void> {
  const logger = new AppLogger('WorkerBootstrap');

  try {
    initializeTelemetry(appEnv.OTEL_ENABLED);

    const runtime = new BotRuntime();
    await runtime.start();

    logger.log(
      `Worker runtime started on ${appEnv.WORKER_HOST}:${appEnv.WORKER_PORT}`,
    );
    logger.log(`Environment: ${appEnv.NODE_ENV}`);

    const shutdown = async (signal: string) => {
      logger.warn(`Received ${signal}. Stopping worker runtime...`);
      let exitCode = 0;
      try {
        await runtime.requestStop(`${signal.toLowerCase()} received`, true);
        exitCode = runtime.getState() === 'halted_hard' ? 1 : 0;
      } catch (error) {
        const message =
          error instanceof Error ? error.stack ?? error.message : String(error);
        logger.error(`Graceful stop failed, falling back to runtime stop: ${message}`);
        await runtime.stop();
        exitCode = 1;
      }
      process.exit(exitCode);
    };

    process.on('SIGINT', () => {
      void shutdown('SIGINT');
    });

    process.on('SIGTERM', () => {
      void shutdown('SIGTERM');
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.stack ?? error.message : String(error);

    logger.error(`Worker failed to start: ${message}`);
    process.exit(1);
  }
}

void bootstrap();
