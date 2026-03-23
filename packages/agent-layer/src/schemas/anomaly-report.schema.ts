import { z } from 'zod';

export const anomalyReportSchema = z.object({
  summary: z.string(),
  anomalyType: z.string(),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  likelyCauses: z.array(z.string()),
  affectedComponents: z.array(z.string()),
  recommendedActions: z.array(z.string()),
});

export type AnomalyReport = z.infer<typeof anomalyReportSchema>;