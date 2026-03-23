import {
  IsBoolean,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class StrategyConfigDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsObject()
  priorModelConfig!: Record<string, unknown>;

  @IsObject()
  posteriorConfig!: Record<string, unknown>;

  @IsObject()
  filtersConfig!: Record<string, unknown>;

  @IsObject()
  riskConfig!: Record<string, unknown>;

  @IsObject()
  executionConfig!: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}