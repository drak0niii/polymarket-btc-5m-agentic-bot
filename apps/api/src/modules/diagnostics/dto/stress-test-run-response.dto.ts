export class StressTestRunResponseDto {
  id!: string;
  family!: string;
  status!: string;
  startedAt!: Date;
  completedAt!: Date | null;
  summary!: unknown;
  verdict!: string | null;
  createdAt!: Date;
}