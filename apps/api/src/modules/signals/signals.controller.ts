import { Controller, Get, Param } from '@nestjs/common';
import { SignalsService } from './signals.service';

@Controller({
  path: 'signals',
  version: '1',
})
export class SignalsController {
  constructor(private readonly signalsService: SignalsService) {}

  @Get()
  async listSignals() {
    return this.signalsService.listSignals();
  }

  @Get(':signalId')
  async getSignal(@Param('signalId') signalId: string) {
    return this.signalsService.getSignalById(signalId);
  }

  @Get(':signalId/decisions')
  async getSignalDecisions(@Param('signalId') signalId: string) {
    return this.signalsService.getSignalDecisions(signalId);
  }
}