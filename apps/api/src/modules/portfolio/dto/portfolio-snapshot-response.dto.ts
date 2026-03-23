export class PortfolioSnapshotResponseDto {
  id!: string;
  bankroll!: number;
  availableCapital!: number;
  openExposure!: number;
  realizedPnlDay!: number;
  unrealizedPnl!: number;
  consecutiveLosses!: number;
  capturedAt!: Date;
  createdAt!: Date;
}