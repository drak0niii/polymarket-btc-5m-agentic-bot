import { Module } from '@nestjs/common';
import { SignalsController } from './signals.controller';
import { SignalsService } from './signals.service';
import { SignalsRepository } from './signals.repository';

@Module({
  controllers: [SignalsController],
  providers: [SignalsService, SignalsRepository],
  exports: [SignalsService, SignalsRepository],
})
export class SignalsModule {}