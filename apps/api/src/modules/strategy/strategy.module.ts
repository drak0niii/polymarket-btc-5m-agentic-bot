import { Module } from '@nestjs/common';
import { StrategyController } from './strategy.controller';
import { StrategyService } from './strategy.service';
import { StrategyRepository } from './strategy.repository';

@Module({
  controllers: [StrategyController],
  providers: [StrategyService, StrategyRepository],
  exports: [StrategyService, StrategyRepository],
})
export class StrategyModule {}