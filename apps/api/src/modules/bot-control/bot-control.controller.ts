import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { BotControlService } from './bot-control.service';
import { StartBotDto } from './dto/start-bot.dto';
import { StopBotDto } from './dto/stop-bot.dto';
import { HaltBotDto } from './dto/halt-bot.dto';
import { SetLiveConfigDto } from './dto/set-live-config.dto';

class SetOperatingModeDto {
  @IsString()
  @IsIn(['sentinel_simulation', 'live_trading'])
  operatingMode!: 'sentinel_simulation' | 'live_trading';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  requestedBy?: string;
}

@Controller({
  path: 'bot-control',
  version: '1',
})
export class BotControlController {
  constructor(private readonly botControlService: BotControlService) {}

  @Get('state')
  async getState() {
    return this.botControlService.getState();
  }

  @Get('mode')
  async getMode() {
    return this.botControlService.getOperatingMode();
  }

  @Post('start')
  @HttpCode(HttpStatus.OK)
  async startBot(@Body() dto: StartBotDto) {
    return this.botControlService.start(dto);
  }

  @Post('stop')
  @HttpCode(HttpStatus.OK)
  async stopBot(@Body() dto: StopBotDto) {
    return this.botControlService.stop(dto);
  }

  @Post('halt')
  @HttpCode(HttpStatus.OK)
  async haltBot(@Body() dto: HaltBotDto) {
    return this.botControlService.halt(dto);
  }

  @Post('live-config')
  @HttpCode(HttpStatus.OK)
  async setLiveConfig(@Body() dto: SetLiveConfigDto) {
    return this.botControlService.setLiveConfig(dto);
  }

  @Post('mode')
  @HttpCode(HttpStatus.OK)
  async setMode(@Body() dto: SetOperatingModeDto) {
    return this.botControlService.setOperatingMode(dto);
  }
}
