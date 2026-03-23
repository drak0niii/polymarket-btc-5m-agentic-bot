export class OrderResponseDto {
  id!: string;
  marketId!: string;
  signalId!: string | null;
  strategyVersionId!: string | null;
  idempotencyKey!: string | null;
  venueOrderId!: string | null;
  status!: string;
  side!: string;
  price!: number;
  size!: number;
  expectedEv!: number | null;
  lastError!: string | null;
  postedAt!: Date | null;
  acknowledgedAt!: Date | null;
  canceledAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}
