import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class UpdateStrategyConfigDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsObject()
  priorModelConfig?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  posteriorConfig?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  filtersConfig?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  riskConfig?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  executionConfig?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}