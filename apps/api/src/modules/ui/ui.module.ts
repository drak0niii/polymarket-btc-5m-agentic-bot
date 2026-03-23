import { Module } from '@nestjs/common';
import { UiController } from './ui.controller';
import { UiService } from './ui.service';
import { MarketsModule } from '@api/modules/markets/markets.module';
import { SignalsModule } from '@api/modules/signals/signals.module';
import { OrdersModule } from '@api/modules/orders/orders.module';
import { PortfolioModule } from '@api/modules/portfolio/portfolio.module';
import { BotControlModule } from '@api/modules/bot-control/bot-control.module';
import { DiagnosticsModule } from '@api/modules/diagnostics/diagnostics.module';
import { AuditModule } from '@api/modules/audit/audit.module';

@Module({
  imports: [
    MarketsModule,
    SignalsModule,
    OrdersModule,
    PortfolioModule,
    BotControlModule,
    DiagnosticsModule,
    AuditModule,
  ],
  controllers: [UiController],
  providers: [UiService],
  exports: [UiService],
})
export class UiModule {}