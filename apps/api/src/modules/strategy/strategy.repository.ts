import { Injectable } from '@nestjs/common';
import { PrismaService } from '@api/modules/prisma/prisma.service';

interface CreateStrategyParams {
  name: string;
  priorModelConfig: unknown;
  posteriorConfig: unknown;
  filtersConfig: unknown;
  riskConfig: unknown;
  executionConfig: unknown;
  isActive: boolean;
}

interface UpdateStrategyParams {
  name?: string;
  priorModelConfig?: unknown;
  posteriorConfig?: unknown;
  filtersConfig?: unknown;
  riskConfig?: unknown;
  executionConfig?: unknown;
  isActive?: boolean;
}

@Injectable()
export class StrategyRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany() {
    return this.prisma.strategyVersion.findMany({
      orderBy: {
        updatedAt: 'desc',
      },
    });
  }

  async findById(strategyVersionId: string) {
    return this.prisma.strategyVersion.findUnique({
      where: { id: strategyVersionId },
    });
  }

  async findActive() {
    return this.prisma.strategyVersion.findFirst({
      where: { isActive: true },
      orderBy: {
        updatedAt: 'desc',
      },
    });
  }

  async create(params: CreateStrategyParams) {
    return this.prisma.strategyVersion.create({
      data: {
        name: params.name,
        priorModelConfig: params.priorModelConfig as object,
        posteriorConfig: params.posteriorConfig as object,
        filtersConfig: params.filtersConfig as object,
        riskConfig: params.riskConfig as object,
        executionConfig: params.executionConfig as object,
        isActive: params.isActive,
      },
    });
  }

  async update(strategyVersionId: string, params: UpdateStrategyParams) {
    return this.prisma.strategyVersion.update({
      where: { id: strategyVersionId },
      data: {
        ...(params.name !== undefined ? { name: params.name } : {}),
        ...(params.priorModelConfig !== undefined
          ? { priorModelConfig: params.priorModelConfig as object }
          : {}),
        ...(params.posteriorConfig !== undefined
          ? { posteriorConfig: params.posteriorConfig as object }
          : {}),
        ...(params.filtersConfig !== undefined
          ? { filtersConfig: params.filtersConfig as object }
          : {}),
        ...(params.riskConfig !== undefined
          ? { riskConfig: params.riskConfig as object }
          : {}),
        ...(params.executionConfig !== undefined
          ? { executionConfig: params.executionConfig as object }
          : {}),
        ...(params.isActive !== undefined ? { isActive: params.isActive } : {}),
      },
    });
  }

  async activate(strategyVersionId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.strategyVersion.updateMany({
        data: {
          isActive: false,
        },
      });

      return tx.strategyVersion.update({
        where: { id: strategyVersionId },
        data: {
          isActive: true,
        },
      });
    });
  }
}