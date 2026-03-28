import { Module } from '@nestjs/common';
import { AuditModule } from '@api/modules/audit/audit.module';
import { DiagnosticsController } from './diagnostics.controller';
import { DiagnosticsService } from './diagnostics.service';
import { DiagnosticsRepository } from './diagnostics.repository';

@Module({
  imports: [AuditModule],
  controllers: [DiagnosticsController],
  providers: [DiagnosticsService, DiagnosticsRepository],
  exports: [DiagnosticsService, DiagnosticsRepository],
})
export class DiagnosticsModule {}
