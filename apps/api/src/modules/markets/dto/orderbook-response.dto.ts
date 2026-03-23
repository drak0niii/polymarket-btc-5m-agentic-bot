export class OrderbookResponseDto {
  id!: string;
  marketId!: string;
  bidLevels!: unknown;
  askLevels!: unknown;
  bestBid!: number | null;
  bestAsk!: number | null;
  spread!: number | null;
  depthScore!: number | null;
  observedAt!: Date;
  createdAt!: Date;
}