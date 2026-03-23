import { Injectable } from '@nestjs/common';
import { NotFoundError } from '@api/common/errors';
import { StrategyRepository } from './strategy.repository';
import { StrategyConfigDto } from './dto/strategy-config.dto';
import { UpdateStrategyConfigDto } from './dto/update-strategy-config.dto';

@Injectable()
export class StrategyService {
  constructor(private readonly strategyRepository: StrategyRepository) {}

  async listStrategies() {
    return this.strategyRepository.findMany();
  }

  async getActiveStrategy() {
    const strategy = await this.strategyRepository.findActive();

    if (!strategy) {
      throw new NotFoundError('No active strategy version was found.');
    }

    return strategy;
  }

  async getStrategyById(strategyVersionId: string) {
    const strategy = await this.strategyRepository.findById(strategyVersionId);

    if (!strategy) {
      throw new NotFoundError(
        `Strategy version ${strategyVersionId} was not found.`,
      );
    }

    return strategy;
  }

  async createStrategy(dto: StrategyConfigDto) {
    return this.strategyRepository.create({
      name: dto.name,
      priorModelConfig: dto.priorModelConfig,
      posteriorConfig: dto.posteriorConfig,
      filtersConfig: dto.filtersConfig,
      riskConfig: dto.riskConfig,
      executionConfig: dto.executionConfig,
      isActive: dto.isActive ?? false,
    });
  }

  async updateStrategy(
    strategyVersionId: string,
    dto: UpdateStrategyConfigDto,
  ) {
    const strategy = await this.strategyRepository.findById(strategyVersionId);

    if (!strategy) {
      throw new NotFoundError(
        `Strategy version ${strategyVersionId} was not found.`,
      );
    }

    return this.strategyRepository.update(strategyVersionId, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.priorModelConfig !== undefined
        ? { priorModelConfig: dto.priorModelConfig }
        : {}),
      ...(dto.posteriorConfig !== undefined
        ? { posteriorConfig: dto.posteriorConfig }
        : {}),
      ...(dto.filtersConfig !== undefined
        ? { filtersConfig: dto.filtersConfig }
        : {}),
      ...(dto.riskConfig !== undefined ? { riskConfig: dto.riskConfig } : {}),
      ...(dto.executionConfig !== undefined
        ? { executionConfig: dto.executionConfig }
        : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
    });
  }

  async activateStrategy(strategyVersionId: string) {
    const strategy = await this.strategyRepository.findById(strategyVersionId);

    if (!strategy) {
      throw new NotFoundError(
        `Strategy version ${strategyVersionId} was not found.`,
      );
    }

    return this.strategyRepository.activate(strategyVersionId);
  }
}