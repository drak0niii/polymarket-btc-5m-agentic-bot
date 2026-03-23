import { Injectable } from '@nestjs/common';
import { NotFoundError } from '@api/common/errors';
import { SignalsRepository } from './signals.repository';

@Injectable()
export class SignalsService {
  constructor(private readonly signalsRepository: SignalsRepository) {}

  async listSignals() {
    return this.signalsRepository.findMany();
  }

  async getSignalById(signalId: string) {
    const signal = await this.signalsRepository.findById(signalId);

    if (!signal) {
      throw new NotFoundError(`Signal ${signalId} was not found.`);
    }

    return signal;
  }

  async getSignalDecisions(signalId: string) {
    const signal = await this.signalsRepository.findById(signalId);

    if (!signal) {
      throw new NotFoundError(`Signal ${signalId} was not found.`);
    }

    return this.signalsRepository.findDecisionsBySignalId(signalId);
  }
}