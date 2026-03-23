export class RegimeDiagnosticResponseDto {
  id!: string;
  strategyVersionId!: string | null;
  regime!: string;
  tradeCount!: number;
  winRate!: number | null;
  expectedEvAvg!: number | null;
  realizedEvAvg!: number | null;
  fillRate!: number | null;
  capturedAt!: Date;
  createdAt!: Date;
}