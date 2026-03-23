import { IsOptional, IsString, MaxLength } from 'class-validator';

export class StartBotDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  requestedBy?: string;
}