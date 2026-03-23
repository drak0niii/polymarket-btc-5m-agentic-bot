import { z } from 'zod';

export const executionDriftReportSchema = z.object({
  summary: z.string(),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  realizedVsExpectedRatio: z.number().nullable(),
  likelyCauses: z.array(z.string()),
  affectedRegimes: z.array(z.string()),
  recommendedActions: z.array(z.string()),
});

export type ExecutionDriftReport = z.infer<typeof executionDriftReportSchema>;