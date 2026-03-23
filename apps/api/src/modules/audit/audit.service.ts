import { Injectable } from '@nestjs/common';
import { AuditRepository } from './audit.repository';

export interface AuditRecordParams {
  eventType: string;
  message: string;
  marketId?: string;
  signalId?: string;
  orderId?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(private readonly auditRepository: AuditRepository) {}

  async listAuditEvents() {
    return this.auditRepository.findMany();
  }

  async record(params: AuditRecordParams) {
    return this.auditRepository.create({
      eventType: params.eventType,
      message: params.message,
      marketId: params.marketId,
      signalId: params.signalId,
      orderId: params.orderId,
      metadata: params.metadata ?? {},
    });
  }
}