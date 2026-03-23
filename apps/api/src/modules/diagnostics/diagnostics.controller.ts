import { Controller, Get, Post } from '@nestjs/common';
import { DiagnosticsService } from './diagnostics.service';

@Controller({
  path: 'diagnostics',
  version: '1',
})
export class DiagnosticsController {
  constructor(private readonly diagnosticsService: DiagnosticsService) {}

  @Get('execution')
  async getExecutionDiagnostics() {
    return this.diagnosticsService.getExecutionDiagnostics();
  }

  @Get('ev-drift')
  async getEvDriftDiagnostics() {
    return this.diagnosticsService.getEvDriftDiagnostics();
  }

  @Get('regimes')
  async getRegimeDiagnostics() {
    return this.diagnosticsService.getRegimeDiagnostics();
  }

  @Get('stress-tests')
  async getStressTestRuns() {
    return this.diagnosticsService.getStressTestRuns();
  }

  @Get('reconciliation')
  async getReconciliationDiagnostics() {
    return this.diagnosticsService.getReconciliationDiagnostics();
  }

  @Get('exposure')
  async getExposureDiagnostics() {
    return this.diagnosticsService.getExposureDiagnostics();
  }

  @Get('risk-alerts')
  async getRiskAlerts() {
    return this.diagnosticsService.getRiskAlerts();
  }

  @Post('stress-tests/run')
  async runStressTests() {
    return this.diagnosticsService.runStressTests();
  }
}
