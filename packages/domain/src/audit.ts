export interface AuditEvent {
  id: string;
  marketId: string | null;
  signalId: string | null;
  orderId: string | null;
  eventType: string;
  message: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}