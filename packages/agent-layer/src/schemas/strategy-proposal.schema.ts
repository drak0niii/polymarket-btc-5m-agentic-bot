import { z } from 'zod';

export const strategyProposalSchema = z.object({
  name: z.string(),
  summary: z.string(),
  priorModelConfig: z.record(z.string(), z.unknown()),
  posteriorConfig: z.record(z.string(), z.unknown()),
  filtersConfig: z.record(z.string(), z.unknown()),
  riskConfig: z.record(z.string(), z.unknown()),
  executionConfig: z.record(z.string(), z.unknown()),
});

export type StrategyProposal = z.infer<typeof strategyProposalSchema>;