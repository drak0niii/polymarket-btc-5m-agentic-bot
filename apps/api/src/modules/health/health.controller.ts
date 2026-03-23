import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '@api/modules/prisma/prisma.service';
import { AppLogger } from '@api/common/logger';
import { appEnv } from '@api/config/env';

@Controller({
  path: 'health',
  version: '1',
})
export class HealthController {
  private readonly logger = new AppLogger('HealthController');

  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async getHealth(): Promise<{
    status: 'ok' | 'degraded';
    service: string;
    environment: string;
    timestamp: string;
    checks: {
      api: 'ok';
      database: 'ok' | 'failed';
    };
  }> {
    const databaseStatus = await this.checkDatabase();
    const overallStatus = databaseStatus === 'ok' ? 'ok' : 'degraded';

    return {
      status: overallStatus,
      service: 'polymarket-btc-5m-agentic-bot-api',
      environment: appEnv.NODE_ENV,
      timestamp: new Date().toISOString(),
      checks: {
        api: 'ok',
        database: databaseStatus,
      },
    };
  }

  private async checkDatabase(): Promise<'ok' | 'failed'> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'ok';
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown database health error';

      this.logger.error('Database health check failed.', undefined, {
        error: message,
      });

      return 'failed';
    }
  }
}