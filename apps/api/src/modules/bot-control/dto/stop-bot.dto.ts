import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class StopBotDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  requestedBy?: string;

  @IsOptional()
  @IsBoolean()
  cancelOpenOrders?: boolean;
}