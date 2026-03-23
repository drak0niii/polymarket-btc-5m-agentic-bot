import {
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class SetLiveConfigDto {
  @IsOptional()
  @IsNumber()
  @Min(1)
  maxOpenPositions?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.000001)
  maxDailyLossPct?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.000001)
  maxPerTradeRiskPct?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.000001)
  maxKellyFraction?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  maxConsecutiveLosses?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  noTradeWindowSeconds?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  evaluationIntervalMs?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  orderReconcileIntervalMs?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  portfolioRefreshIntervalMs?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  updatedBy?: string;
}