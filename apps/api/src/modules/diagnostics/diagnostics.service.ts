import { Injectable } from '@nestjs/common';
import { DiagnosticsRepository } from './diagnostics.repository';
import { AuditService } from '@api/modules/audit/audit.service';

@Injectable()
export class DiagnosticsService {
  constructor(
    private readonly diagnosticsRepository: DiagnosticsRepository,
    private readonly auditService: AuditService,
  ) {}

  async getExecutionDiagnostics() {
    return this.diagnosticsRepository.findExecutionDiagnostics();
  }

  async getEvDriftDiagnostics() {
    return this.diagnosticsRepository.findEvDriftDiagnostics();
  }

  async getRegimeDiagnostics() {
    return this.diagnosticsRepository.findRegimeDiagnostics();
  }

  async getStressTestRuns() {
    return this.diagnosticsRepository.findStressTestRuns();
  }

  async getReconciliationDiagnostics() {
    return this.diagnosticsRepository.findReconciliationCheckpoints();
  }

  async getExposureDiagnostics() {
    return this.diagnosticsRepository.getExposureDiagnostics();
  }

  async getRiskAlerts() {
    return this.diagnosticsRepository.getRiskAlerts();
  }

  async runStressTests() {
    const run = await this.diagnosticsRepository.createStressTestRun({
      family: 'manual_trigger',
      status: 'queued',
      startedAt: new Date(),
    });

    await this.auditService.record({
      eventType: 'diagnostics.stress_tests.requested',
      message: 'Stress test run requested.',
      metadata: {
        stressTestRunId: run.id,
      },
    });

    return run;
  }
}
