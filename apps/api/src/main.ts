import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { appEnv } from './config/env';
import { AppLogger } from './common/logger';

async function bootstrap(): Promise<void> {
  const bootstrapLogger = new AppLogger('Bootstrap');

  try {
    const app = await NestFactory.create(AppModule, {
      bufferLogs: true,
      cors: false,
    });

    app.useLogger(app.get(AppLogger));
    app.enableShutdownHooks();

    app.setGlobalPrefix('api');

    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: '1',
    });

    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: {
          enableImplicitConversion: true,
        },
        stopAtFirstError: false,
      }),
    );

    app.enableCors({
      origin: true,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Request-Id',
        'X-Correlation-Id',
      ],
      exposedHeaders: ['X-Request-Id'],
    });

    await app.listen(appEnv.API_PORT, appEnv.API_HOST);

    const appUrl = await app.getUrl();

    bootstrapLogger.log(
      `API is running at ${appUrl}/api/v1`,
    );
    bootstrapLogger.log(`Environment: ${appEnv.NODE_ENV}`);
  } catch (error) {
    const message =
      error instanceof Error ? error.stack ?? error.message : String(error);

    bootstrapLogger.error(`Application failed to start: ${message}`);
    process.exit(1);
  }
}

void bootstrap();