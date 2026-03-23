import { Module } from '@nestjs/common';
import { HealthController } from './modules/health/health.controller';
import { BotControlModule } from './modules/bot-control/bot-control.module';
import { MarketsModule } from './modules/markets/markets.module';
import { SignalsModule } from './modules/signals/signals.module';
import { PortfolioModule } from './modules/portfolio/portfolio.module';
import { OrdersModule } from './modules/orders/orders.module';
import { StrategyModule } from './modules/strategy/strategy.module';
import { AuditModule } from './modules/audit/audit.module';
import { DiagnosticsModule } from './modules/diagnostics/diagnostics.module';
import { UiModule } from './modules/ui/ui.module';
import { PrismaModule } from './modules/prisma/prisma.module';
import { AppLogger } from './common/logger';

@Module({
  imports: [
    PrismaModule,
    BotControlModule,
    MarketsModule,
    SignalsModule,
    PortfolioModule,
    OrdersModule,
    StrategyModule,
    AuditModule,
    DiagnosticsModule,
    UiModule,
  ],
  controllers: [HealthController],
  providers: [AppLogger],
})
export class AppModule {}