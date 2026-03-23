import { z } from 'zod';

export const dailyReviewSchema = z.object({
  summary: z.string(),
  pnl: z.object({
    realized: z.number(),
    unrealized: z.number(),
  }),
  execution: z.object({
    fillRate: z.number().nullable(),
    evDrift: z.number().nullable(),
    staleOrderRate: z.number().nullable(),
  }),
  risk: z.object({
    dailyLossLimitBreached: z.boolean(),
    consecutiveLosses: z.number(),
    halted: z.boolean(),
  }),
  keyFindings: z.array(z.string()),
  recommendations: z.array(z.string()),
});

export type DailyReview = z.infer<typeof dailyReviewSchema>;