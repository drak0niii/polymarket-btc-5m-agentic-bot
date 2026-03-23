export class FillResponseDto {
  id!: string;
  marketId!: string;
  orderId!: string | null;
  price!: number;
  size!: number;
  fee!: number | null;
  realizedPnl!: number | null;
  filledAt!: Date;
  createdAt!: Date;
}