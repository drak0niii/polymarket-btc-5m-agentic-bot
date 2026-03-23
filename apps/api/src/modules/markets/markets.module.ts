import { Module } from '@nestjs/common';
import { MarketsController } from './markets.controller';
import { MarketsService } from './markets.service';
import { MarketsRepository } from './markets.repository';

@Module({
  controllers: [MarketsController],
  providers: [MarketsService, MarketsRepository],
  exports: [MarketsService, MarketsRepository],
})
export class MarketsModule {}