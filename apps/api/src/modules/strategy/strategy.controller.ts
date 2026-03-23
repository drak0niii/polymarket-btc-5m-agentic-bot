import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { StrategyService } from './strategy.service';
import { StrategyConfigDto } from './dto/strategy-config.dto';
import { UpdateStrategyConfigDto } from './dto/update-strategy-config.dto';

@Controller({
  path: 'strategy',
  version: '1',
})
export class StrategyController {
  constructor(private readonly strategyService: StrategyService) {}

  @Get()
  async listStrategies() {
    return this.strategyService.listStrategies();
  }

  @Get('active')
  async getActiveStrategy() {
    return this.strategyService.getActiveStrategy();
  }

  @Get(':strategyVersionId')
  async getStrategyById(
    @Param('strategyVersionId') strategyVersionId: string,
  ) {
    return this.strategyService.getStrategyById(strategyVersionId);
  }

  @Post()
  async createStrategy(@Body() dto: StrategyConfigDto) {
    return this.strategyService.createStrategy(dto);
  }

  @Patch(':strategyVersionId')
  async updateStrategy(
    @Param('strategyVersionId') strategyVersionId: string,
    @Body() dto: UpdateStrategyConfigDto,
  ) {
    return this.strategyService.updateStrategy(strategyVersionId, dto);
  }

  @Post(':strategyVersionId/activate')
  async activateStrategy(
    @Param('strategyVersionId') strategyVersionId: string,
  ) {
    return this.strategyService.activateStrategy(strategyVersionId);
  }
}