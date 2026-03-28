import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

const OPERATING_MODES = ['sentinel_simulation', 'live_trading'] as const;

export class StartBotDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  requestedBy?: string;

  @IsOptional()
  @IsString()
  @IsIn(OPERATING_MODES)
  operatingMode?: (typeof OPERATING_MODES)[number];
}
