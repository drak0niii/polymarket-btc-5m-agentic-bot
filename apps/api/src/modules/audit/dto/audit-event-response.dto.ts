export class AuditEventResponseDto {
  id!: string;
  marketId!: string | null;
  signalId!: string | null;
  orderId!: string | null;
  eventType!: string;
  message!: string;
  metadata!: unknown;
  createdAt!: Date;
}