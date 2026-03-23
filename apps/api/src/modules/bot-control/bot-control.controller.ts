import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { BotControlService } from './bot-control.service';
import { StartBotDto } from './dto/start-bot.dto';
import { StopBotDto } from './dto/stop-bot.dto';
import { HaltBotDto } from './dto/halt-bot.dto';
import { SetLiveConfigDto } from './dto/set-live-config.dto';

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
}
