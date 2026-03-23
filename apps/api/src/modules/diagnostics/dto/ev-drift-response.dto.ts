export class EvDriftResponseDto {
  id!: string;
  strategyVersionId!: string | null;
  windowLabel!: string;
  expectedEvSum!: number;
  realizedEvSum!: number;
  evDrift!: number;
  realizedVsExpected!: number;
  capturedAt!: Date;
  createdAt!: Date;
}