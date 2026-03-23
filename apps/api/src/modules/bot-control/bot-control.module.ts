import { Module } from '@nestjs/common';
import { BotControlController } from './bot-control.controller';
import { BotControlService } from './bot-control.service';
import { AuditModule } from '@api/modules/audit/audit.module';
import { BotControlRepository } from './bot-control.repository';

@Module({
  imports: [AuditModule],
  controllers: [BotControlController],
  providers: [BotControlService, BotControlRepository],
  exports: [BotControlService],
})
export class BotControlModule {}
